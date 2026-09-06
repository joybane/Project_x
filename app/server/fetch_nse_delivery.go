package main

import (
	"bufio"
	"bytes"
	"fmt"
	"strings"
	"time"
)

func fetchNSEDelivery() (int, error) {
	latest, err := latestDateInTable("c:/Workdesk/project_x/nse/delivery", "trade_date")
	if err != nil {
		return 0, err
	}
	today := time.Now()
	columns := []string{"trade_date", "symbol", "series", "qty_traded", "deliv_qty", "deliv_pct"}
	var allRows [][]string
	var lastErr error

	for _, d := range datesAfter(latest, today) {
		url := fmt.Sprintf("https://nsearchives.nseindia.com/archives/equities/mto/MTO_%s.DAT", d.Format("02012006"))
		body, err := nseArchiveGet(url)
		if err != nil {
			lastErr = err
			continue
		}
		rows, err := parseMTO(body)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", url, err)
		}
		allRows = append(allRows, rows...)
	}

	if len(allRows) == 0 {
		if lastErr != nil {
			return 0, fmt.Errorf("no new trading days available yet (%w)", lastErr)
		}
		return 0, nil
	}
	return mergeRowsIntoTable("c:/Workdesk/project_x/nse/delivery", columns, allRows, 0, []string{"trade_date", "symbol", "series"})
}

// parseMTO mirrors build_nse_delivery.py's parser exactly: the trade date
// comes from the "10,MTO,DDMMYYYY,..." header line, not the filename or
// folder, and rows come in two shapes depending on era (modern: SrNo,Symbol,
// Series,Qty,DelivQty,DelivPct; legacy: Symbol,Series,Qty only, no delivery
// breakdown - kept even though only the modern shape will ever appear for a
// freshly-fetched date, for parity with the historical parser).
func parseMTO(body []byte) ([][]string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var tradeDate string
	var rows [][]string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case strings.HasPrefix(line, "10,MTO,"):
			parts := strings.Split(line, ",")
			if len(parts) < 3 {
				continue
			}
			d, err := timeParseDDMMYYYY(parts[2])
			if err == nil {
				tradeDate = d
			}
		case strings.HasPrefix(line, "20,"):
			parts := strings.Split(line, ",")
			for i := range parts {
				parts[i] = strings.TrimSpace(parts[i])
			}
			rest := parts[1:]
			switch len(rest) {
			case 6:
				symbol, series, qty, delivQty, delivPct := rest[1], rest[2], rest[3], rest[4], rest[5]
				rows = append(rows, []string{tradeDate, symbol, series, qty, delivQty, delivPct})
			case 3:
				symbol, series, qty := rest[0], rest[1], rest[2]
				rows = append(rows, []string{tradeDate, symbol, series, qty, "", ""})
			}
		}
	}
	if tradeDate == "" {
		return nil, fmt.Errorf("could not find a trade date header line ('10,MTO,...') in the MTO file")
	}
	// The header line can appear after some data rows in a couple of odd
	// historical files; since it never varies within one file, backfill it.
	for _, r := range rows {
		if r[0] == "" {
			r[0] = tradeDate
		}
	}
	return rows, nil
}

func timeParseDDMMYYYY(s string) (string, error) {
	t, err := time.Parse("02012006", s)
	if err != nil {
		return "", err
	}
	return t.Format("2006-01-02"), nil
}
