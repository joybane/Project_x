package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"time"
)

//go:embed all:web
var webFS embed.FS

const dataRoot = "D:/project_x"

var (
	symbolRe = regexp.MustCompile(`^[A-Za-z0-9\-&.]{1,20}$`)
	dateRe   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// runDuckDB shells out to the duckdb CLI with -json output and returns the raw JSON bytes.
// duckdb prints "" (empty) for a query with zero rows rather than "[]", so that's normalized here.
func runDuckDB(sql string) ([]byte, error) {
	cmd := exec.Command("duckdb", "-json", "-c", sql)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("duckdb error: %v: %s", err, stderr.String())
	}
	out := bytes.TrimSpace(stdout.Bytes())
	if len(out) == 0 {
		return []byte("[]"), nil
	}
	return out, nil
}

func writeJSON(w http.ResponseWriter, data []byte, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	w.Write(data)
}

func parquetGlob(exchange, table string) (string, error) {
	if exchange != "nse" && exchange != "bse" {
		return "", fmt.Errorf("invalid exchange %q", exchange)
	}
	validTables := map[string]bool{
		"price_volume": true, "delivery": true, "bulk_deals": true,
		"block_deals": true, "short_selling": true, "index_sensex": true, "reference": true,
	}
	if !validTables[table] {
		return "", fmt.Errorf("invalid table %q", table)
	}
	return fmt.Sprintf("%s/%s/%s/**/*.parquet", dataRoot, exchange, table), nil
}

func validSymbol(s string) (string, error) {
	if !symbolRe.MatchString(s) {
		return "", fmt.Errorf("invalid symbol %q", s)
	}
	return s, nil
}

func validDate(s, fallback string) (string, error) {
	if s == "" {
		return fallback, nil
	}
	if !dateRe.MatchString(s) {
		return "", fmt.Errorf("invalid date %q", s)
	}
	return s, nil
}

// GET /api/symbols?exchange=nse&q=REL
//
// NSE's price_volume.symbol is already the human ticker, so it's searched
// directly. BSE's price_volume.symbol is the numeric scrip code (the one
// stable id across BSE's whole history and shared with delivery/block_deals),
// so BSE search instead goes through bse/reference (ticker + company name)
// and resolves back to the scrip code the other endpoints expect.
func handleSymbols(w http.ResponseWriter, r *http.Request) {
	exchange := r.URL.Query().Get("exchange")
	q := r.URL.Query().Get("q")
	if q != "" {
		if _, err := validSymbol(q); err != nil {
			writeJSON(w, nil, err)
			return
		}
	}

	var sql string
	if exchange == "bse" {
		glob, err := parquetGlob(exchange, "reference")
		if err != nil {
			writeJSON(w, nil, err)
			return
		}
		filter := ""
		if q != "" {
			filter = fmt.Sprintf("AND (scrip_id ILIKE '%%%s%%' OR scrip_name ILIKE '%%%s%%' OR scrip_code ILIKE '%%%s%%')", q, q, q)
		}
		sql = fmt.Sprintf(`
			WITH latest AS (
				SELECT scrip_code, scrip_id, scrip_name,
					ROW_NUMBER() OVER (PARTITION BY scrip_code ORDER BY snapshot_date DESC) AS rn
				FROM read_parquet('%s', hive_partitioning=1)
			)
			SELECT scrip_code AS symbol, scrip_id AS ticker, scrip_name AS name
			FROM latest
			WHERE rn = 1 %s
			ORDER BY scrip_id
			LIMIT 50`, glob, filter)
	} else {
		glob, err := parquetGlob(exchange, "price_volume")
		if err != nil {
			writeJSON(w, nil, err)
			return
		}
		filter := ""
		if q != "" {
			filter = fmt.Sprintf("WHERE symbol ILIKE '%%%s%%'", q)
		}
		sql = fmt.Sprintf(`
			SELECT DISTINCT symbol, symbol AS ticker, NULL AS name
			FROM read_parquet('%s', hive_partitioning=1)
			%s
			ORDER BY symbol
			LIMIT 50`, glob, filter)
	}
	data, err := runDuckDB(sql)
	writeJSON(w, data, err)
}

// GET /api/price?exchange=nse&symbol=RELIANCE&from=2020-01-01&to=2024-01-01
//
// Or, for incremental scroll-back loading: ?exchange=&symbol=&before=2020-01-01&limit=500
// returns exactly the `limit` most recent trading days strictly before
// `before` (still ascending), instead of everything in a range - so panning
// back through years of history fetches one fixed-size batch of candles at a
// time rather than re-fetching an ever-growing date range from scratch on
// every scroll.
func handlePrice(w http.ResponseWriter, r *http.Request) {
	exchange := r.URL.Query().Get("exchange")
	symbol, err := validSymbol(r.URL.Query().Get("symbol"))
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	priceGlob, err := parquetGlob(exchange, "price_volume")
	if err != nil {
		writeJSON(w, nil, err)
		return
	}

	// NSE's price_volume calls the volume column ttl_trd_qty; BSE's calls it volume.
	volCol := "volume"
	if exchange == "nse" {
		volCol = "ttl_trd_qty"
	}

	// A symbol can have multiple rows on the same date under different series
	// (NSE: EQ = regular equity, plus BE/BL/other special-settlement series).
	// Default to EQ so the chart gets exactly one candle per day; pick the
	// highest-volume row if EQ doesn't exist for this symbol/date.
	rankedCTE := fmt.Sprintf(`
		WITH ranked AS (
			SELECT p.*,
				ROW_NUMBER() OVER (
					PARTITION BY p.trade_date
					ORDER BY (p.series = 'EQ') DESC, p.%s DESC
				) AS rn
			FROM read_parquet('%s', hive_partitioning=1) p
			WHERE p.symbol = '%s'`, volCol, priceGlob, symbol)

	var sql string
	if before := r.URL.Query().Get("before"); before != "" {
		beforeDate, err := validDate(before, "")
		if err != nil {
			writeJSON(w, nil, err)
			return
		}
		limit := 500
		if l := r.URL.Query().Get("limit"); l != "" {
			if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 2000 {
				limit = n
			}
		}
		sql = fmt.Sprintf(`
			%s AND p.trade_date < '%s'
			)
			SELECT * FROM (
				SELECT trade_date, open, high, low, close, %s AS volume
				FROM ranked WHERE rn = 1
				ORDER BY trade_date DESC
				LIMIT %d
			) ORDER BY trade_date`, rankedCTE, beforeDate, volCol, limit)
	} else {
		from, err := validDate(r.URL.Query().Get("from"), "1990-01-01")
		if err != nil {
			writeJSON(w, nil, err)
			return
		}
		to, err := validDate(r.URL.Query().Get("to"), "2100-01-01")
		if err != nil {
			writeJSON(w, nil, err)
			return
		}
		sql = fmt.Sprintf(`
			%s AND p.trade_date BETWEEN '%s' AND '%s'
			)
			SELECT trade_date, open, high, low, close, %s AS volume
			FROM ranked
			WHERE rn = 1
			ORDER BY trade_date`, rankedCTE, from, to, volCol)
	}
	data, err := runDuckDB(sql)
	writeJSON(w, data, err)
}

// GET /api/delivery?exchange=nse&symbol=RELIANCE&from=&to=
//
// Split out from /api/price so the delivery pane can be sourced independently
// of whichever exchange the price candles are showing (NSE only, BSE only, or
// both merged). The "both" case is done by the frontend calling this twice
// (once per exchange) and summing qty_traded/deliv_qty per date client-side.
func handleDelivery(w http.ResponseWriter, r *http.Request) {
	exchange := r.URL.Query().Get("exchange")
	symbol, err := validSymbol(r.URL.Query().Get("symbol"))
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	from, err := validDate(r.URL.Query().Get("from"), "1990-01-01")
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	to, err := validDate(r.URL.Query().Get("to"), "2100-01-01")
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	delivGlob, err := parquetGlob(exchange, "delivery")
	if err != nil {
		writeJSON(w, nil, err)
		return
	}

	var sql string
	if exchange == "nse" {
		// Same EQ-series-first dedup as price_volume - NSE's delivery table
		// carries the same per-series rows (EQ/BE/BL/...) for a given date.
		sql = fmt.Sprintf(`
			WITH ranked AS (
				SELECT trade_date, qty_traded, deliv_qty, deliv_pct,
					ROW_NUMBER() OVER (
						PARTITION BY trade_date
						ORDER BY (series = 'EQ') DESC, qty_traded DESC
					) AS rn
				FROM read_parquet('%s', hive_partitioning=1)
				WHERE symbol = '%s' AND trade_date BETWEEN '%s' AND '%s'
			)
			SELECT trade_date, qty_traded, deliv_qty, deliv_pct
			FROM ranked WHERE rn = 1
			ORDER BY trade_date`, delivGlob, symbol, from, to)
	} else {
		sql = fmt.Sprintf(`
			SELECT trade_date, volume AS qty_traded, deliv_qty, deliv_pct
			FROM read_parquet('%s', hive_partitioning=1)
			WHERE symbol = '%s' AND trade_date BETWEEN '%s' AND '%s'
			ORDER BY trade_date`, delivGlob, symbol, from, to)
	}
	data, err := runDuckDB(sql)
	writeJSON(w, data, err)
}

// GET /api/deals?exchange=nse&type=bulk_deals&symbol=RELIANCE&from=&to=&limit=200
func handleDeals(w http.ResponseWriter, r *http.Request) {
	exchange := r.URL.Query().Get("exchange")
	dealType := r.URL.Query().Get("type") // bulk_deals | block_deals | short_selling
	glob, err := parquetGlob(exchange, dealType)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	from, err := validDate(r.URL.Query().Get("from"), "1990-01-01")
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	to, err := validDate(r.URL.Query().Get("to"), "2100-01-01")
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	// NSE's deal tables key on `symbol` and spell sides as BUY/SELL. BSE's
	// block_deals keys on `scrip_code` (it's sourced from BSE's own
	// scrip-code-based feed, never had a ticker column) and spells sides as a
	// P/S transaction_type code. Both are normalized to one shared JSON shape
	// here so the frontend doesn't need to know which exchange it's looking at.
	var selectCols string
	symCol := "symbol"
	if exchange == "bse" {
		symCol = "scrip_code"
		selectCols = `scrip_code AS symbol, security_name,
			CASE transaction_type WHEN 'P' THEN 'BUY' WHEN 'S' THEN 'SELL' ELSE transaction_type END AS buy_sell,
			client_name, quantity, price`
	} else if dealType == "short_selling" {
		selectCols = "symbol, security_name, quantity"
	} else {
		selectCols = "symbol, security_name, client_name, buy_sell, quantity, price"
	}

	symFilter := ""
	if sym := r.URL.Query().Get("symbol"); sym != "" {
		s, err := validSymbol(sym)
		if err != nil {
			writeJSON(w, nil, err)
			return
		}
		symFilter = fmt.Sprintf("AND %s = '%s'", symCol, s)
	}
	// Real pagination, not a bigger silent cutoff: a 4-year range can easily
	// match tens of thousands of rows. pageSize defaults to a size that
	// renders fast for on-screen display; the screener (which fetches every
	// page up front for client-side sort/search across the whole range, not
	// just one page at a time) asks for a much larger pageSize explicitly so
	// that doesn't mean hundreds of round trips. `page` (0-indexed) moves
	// through the full matched set via OFFSET either way.
	pageSize := 100
	if ps := r.URL.Query().Get("pageSize"); ps != "" {
		if n, err := strconv.Atoi(ps); err == nil && n > 0 && n <= 5000 {
			pageSize = n
		}
	}
	page := 0
	if p := r.URL.Query().Get("page"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n >= 0 {
			page = n
		}
	}
	// COUNT(*) OVER() reports how many rows matched the WHERE clause *before*
	// LIMIT/OFFSET slice it, so the frontend can render "page 3 of 265 (26,479
	// total)" and actually paginate through the whole range instead of only
	// ever seeing whichever days happen to fall in a single fixed-size window.
	sql := fmt.Sprintf(`
		SELECT trade_date, %s, COUNT(*) OVER() AS matched_total
		FROM read_parquet('%s', hive_partitioning=1)
		WHERE trade_date BETWEEN '%s' AND '%s' %s
		ORDER BY trade_date DESC
		LIMIT %d OFFSET %d`, selectCols, glob, from, to, symFilter, pageSize, page*pageSize)
	data, err := runDuckDB(sql)
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	var rows []map[string]any
	if err := json.Unmarshal(data, &rows); err != nil {
		writeJSON(w, nil, err)
		return
	}
	total := 0
	if len(rows) > 0 {
		if mt, ok := rows[0]["matched_total"].(float64); ok {
			total = int(mt)
		}
		for _, row := range rows {
			delete(row, "matched_total")
		}
	}
	totalPages := (total + pageSize - 1) / pageSize
	out, err := json.Marshal(map[string]any{
		"rows": rows, "total": total, "page": page, "pageSize": pageSize, "totalPages": totalPages,
	})
	writeJSON(w, out, err)
}

func withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		if r.Method == http.MethodOptions {
			return
		}
		h(w, r)
	}
}

// findEdge locates msedge.exe in its usual install locations without needing
// it on PATH.
func findEdge() string {
	candidates := []string{
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return "msedge" // fall back to PATH lookup
}

// openAppWindow launches the frontend in a chromeless Edge window (--app mode):
// same WebView2/Chromium engine as a native webview, no address bar or tabs,
// its own taskbar entry - without requiring a CGO-based webview binding.
func openAppWindow(url string) {
	edge := findEdge()
	cmd := exec.Command(edge, "--app="+url, "--window-size=1360,900", "--new-window")
	if err := cmd.Start(); err != nil {
		log.Printf("could not launch Edge app window (%v); open %s manually", err, url)
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/symbols", withCORS(handleSymbols))
	mux.HandleFunc("/api/price", withCORS(handlePrice))
	mux.HandleFunc("/api/delivery", withCORS(handleDelivery))
	mux.HandleFunc("/api/deals", withCORS(handleDeals))
	mux.HandleFunc("/api/update", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			handleUpdateTrigger(w, r)
			return
		}
		handleUpdateStatus(w, r)
	}))
	registerUpdateSteps(buildUpdateSteps())

	staticFS, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", http.FileServer(http.FS(staticFS)))

	addr := "127.0.0.1:8787"
	noWindow := os.Getenv("STOCKAPP_NO_WINDOW") != ""

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		// Someone already has this port - almost certainly a stockapp instance
		// already running. Rather than crash (the old behavior: it printed
		// "listening" then died on bind, and the browser-window goroutine
		// usually lost the race and never fired), just open another window
		// onto the instance that's already serving. No second backend process,
		// no duplicated DuckDB work - this is why extra windows stay cheap.
		log.Printf("%s is already serving (another instance is running) - opening another window onto it", addr)
		if !noWindow {
			openAppWindow("http://" + addr)
		}
		return
	}

	if !noWindow {
		go func() {
			time.Sleep(400 * time.Millisecond)
			openAppWindow("http://" + addr)
		}()
	}

	log.Printf("stockapp server listening on http://%s", addr)
	log.Fatal(http.Serve(listener, mux))
}
