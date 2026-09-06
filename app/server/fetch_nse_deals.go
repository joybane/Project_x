package main

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"
	"unicode"
)

// The historicalOR endpoint serves NSE bulk deals, block deals, and short
// selling off one API distinguished only by optionType, and answers a whole
// date range in one call rather than one file per day like the archives do.
func fetchNSEDealsRange(optionType, baseDir string, hasClientColumns bool) (int, error) {
	latest, err := latestDateInTable(baseDir, "trade_date")
	if err != nil {
		return 0, err
	}
	today := time.Now()
	if !latest.Before(today) {
		return 0, nil
	}
	from := latest.AddDate(0, 0, 1)

	u := fmt.Sprintf(
		"https://www.nseindia.com/api/historicalOR/bulk-block-short-deals?optionType=%s&from=%s&to=%s&csv=true",
		optionType, url.QueryEscape(from.Format("02-01-2006")), url.QueryEscape(today.Format("02-01-2006")),
	)
	body, err := nseAPIGet(u)
	if err != nil {
		return 0, err
	}

	rows, columns, err := parseNSEDealsCSV(body, hasClientColumns)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	// These rows have no natural unique key beyond their own full content -
	// several clients can trade the same symbol on the same date - so every
	// column together is the dedupe key, matching the original bulk-load ETL
	// (build_nse_deals.py's plain drop_duplicates() with no subset).
	return mergeRowsIntoTable(baseDir, columns, rows, 0, columns)
}

func fetchNSEBulkDeals() (int, error) {
	return fetchNSEDealsRange("bulk_deals", "D:/project_x/nse/bulk_deals", true)
}

func fetchNSEBlockDeals() (int, error) {
	return fetchNSEDealsRange("block_deals", "D:/project_x/nse/block_deals", true)
}

func fetchNSEShortSelling() (int, error) {
	return fetchNSEDealsRange("short_selling", "D:/project_x/nse/short_selling", false)
}

// parseNSEDealsCSV handles the same BOM-prefixed, quoted, trailing-space,
// Indian-comma-grouped format as the historical range exports (see
// build_nse_deals.py) - it's the same underlying API either way.
func parseNSEDealsCSV(body []byte, hasClientColumns bool) ([][]string, []string, error) {
	body = bytes.TrimPrefix(body, []byte{0xEF, 0xBB, 0xBF}) // UTF-8 BOM
	r := csv.NewReader(bytes.NewReader(body))
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil {
		return nil, nil, err
	}
	norm := make([]string, len(header))
	idx := map[string]int{}
	for i, h := range header {
		key := strings.ToLower(strings.TrimSpace(strings.Trim(h, `" `)))
		key = strings.ReplaceAll(key, ".", "")
		key = strings.ReplaceAll(key, "/", "_")
		key = strings.Join(strings.Fields(key), "_")
		norm[i] = key
		idx[key] = i
	}
	get := func(rec []string, name string) string {
		if i, ok := idx[name]; ok && i < len(rec) {
			return strings.TrimSpace(rec[i])
		}
		return ""
	}

	var columns []string
	if hasClientColumns {
		columns = []string{"trade_date", "symbol", "security_name", "client_name", "buy_sell", "quantity", "price"}
	} else {
		columns = []string{"trade_date", "symbol", "security_name", "quantity"}
	}

	var rows [][]string
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		dateStr := get(rec, "date")
		symbol := get(rec, "symbol")
		if dateStr == "" || symbol == "" {
			continue
		}
		// NSE renders the month abbreviation upper-case ("01-SEP-2026"), but
		// Go's reference layout only recognizes title case ("01-Sep-2026").
		d, err := time.Parse("02-Jan-2006", titleCaseMonth(dateStr))
		if err != nil {
			continue
		}
		if hasClientColumns {
			bs := get(rec, "buy_sell")
			if bs == "" {
				bs = get(rec, "buy___sell")
			}
			priceCol := ""
			for k := range idx {
				if strings.HasPrefix(k, "trade_price") {
					priceCol = k
					break
				}
			}
			rows = append(rows, []string{
				d.Format("2006-01-02"),
				symbol,
				get(rec, "security_name"),
				get(rec, "client_name"),
				bs,
				cleanNumber(get(rec, "quantity_traded")),
				cleanNumber(get(rec, priceCol)),
			})
		} else {
			rows = append(rows, []string{
				d.Format("2006-01-02"),
				symbol,
				get(rec, "security_name"),
				cleanNumber(get(rec, "quantity")),
			})
		}
	}
	return rows, columns, nil
}

func cleanNumber(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"`)
	var b strings.Builder
	for _, r := range s {
		if unicode.IsDigit(r) || r == '.' || r == '-' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func titleCaseMonth(s string) string {
	// "01-SEP-2026" -> "01-Sep-2026"
	parts := strings.Split(s, "-")
	if len(parts) != 3 {
		return s
	}
	month := strings.ToLower(parts[1])
	if len(month) > 0 {
		month = strings.ToUpper(month[:1]) + month[1:]
	}
	return parts[0] + "-" + month + "-" + parts[2]
}

