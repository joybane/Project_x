package main

import (
	"bufio"
	"bytes"
	"fmt"
	"strings"
	"time"
)

func fetchBSEDelivery() (int, error) {
	latest, err := latestDateInTable("c:/Workdesk/project_x/bse/delivery", "trade_date")
	if err != nil {
		return 0, err
	}
	today := time.Now()
	columns := []string{"trade_date", "symbol", "deliv_qty", "deliv_val", "volume", "turnover", "deliv_pct"}
	var allRows [][]string
	var lastErr error

	for _, d := range datesAfter(latest, today) {
		// Filename carries DDMM only - the year lives in the URL path, per
		// bse_pipeline.py's _delivery_candidate.
		url := fmt.Sprintf("https://www.bseindia.com/BSEDATA/gross/%s/SCBSEALL%s.zip", d.Format("2006"), d.Format("0201"))
		body, err := bseGet(url)
		if err != nil {
			lastErr = err
			continue
		}
		txtBytes, err := firstFileInZip(body)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", url, err)
		}
		rows, err := parseBSEDeliveryTXT(txtBytes)
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
	return mergeRowsIntoTable("c:/Workdesk/project_x/bse/delivery", columns, allRows, 0, []string{"trade_date", "symbol"})
}

// parseBSEDeliveryTXT handles the pipe-delimited format, and the two known
// header spellings for the volume column ("DAY'S VOLUME" with a real
// apostrophe in most files, a backtick in a couple of historical ones) -
// see build_bse_delivery.py.
func parseBSEDeliveryTXT(body []byte) ([][]string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	if !scanner.Scan() {
		return nil, fmt.Errorf("empty delivery file")
	}
	header := strings.Split(strings.ReplaceAll(scanner.Text(), "`", "'"), "|")
	idx := map[string]int{}
	for i, h := range header {
		idx[strings.TrimSpace(h)] = i
	}
	get := func(rec []string, name string) string {
		if i, ok := idx[name]; ok && i < len(rec) {
			return strings.TrimSpace(rec[i])
		}
		return ""
	}

	var rows [][]string
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		rec := strings.Split(line, "|")
		dateStr := get(rec, "DATE")
		if dateStr == "" {
			continue
		}
		d, err := time.Parse("02012006", dateStr)
		if err != nil {
			continue
		}
		rows = append(rows, []string{
			d.Format("2006-01-02"),
			get(rec, "SCRIP CODE"),
			get(rec, "DELIVERY QTY"),
			get(rec, "DELIVERY VAL"),
			get(rec, "DAY'S VOLUME"),
			get(rec, "DAY'S TURNOVER"),
			get(rec, "DELV. PER."),
		})
	}
	return rows, nil
}
