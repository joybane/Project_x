package main

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"net/url"
	"time"
)

func fetchBSEIndexSensex() (int, error) {
	latest, err := latestDateInTable("D:/project_x/bse/index_sensex", "trade_date")
	if err != nil {
		return 0, err
	}
	today := time.Now()
	if !latest.Before(today) {
		return 0, nil
	}
	from := latest.AddDate(0, 0, 1)

	params := url.Values{
		"strIndex":   {"SENSEX"},
		"dtFromDate": {from.Format("02/01/2006")},
		"dtToDate":   {today.Format("02/01/2006")},
		"period":     {"D"},
	}
	u := "https://api.bseindia.com/BseIndiaAPI/api/ProduceCSVForDate/w?" + params.Encode()
	body, err := bseGet(u)
	if err != nil {
		return 0, err
	}
	body = bytes.TrimPrefix(body, []byte{0xEF, 0xBB, 0xBF})

	r := csv.NewReader(bytes.NewReader(body))
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil {
		return 0, fmt.Errorf("%s: %w", u, err)
	}
	cols := newCSVCols(header)

	var rows [][]string
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, err
		}
		dateStr := cols.get(rec, "Date")
		d, err := time.Parse("2-January-2006", dateStr)
		if err != nil {
			continue
		}
		rows = append(rows, []string{
			d.Format("2006-01-02"),
			cols.get(rec, "Open"),
			cols.get(rec, "High"),
			cols.get(rec, "Low"),
			cols.get(rec, "Close"),
		})
	}

	if len(rows) == 0 {
		return 0, nil
	}
	columns := []string{"trade_date", "open", "high", "low", "close"}
	return mergeRowsIntoTable("D:/project_x/bse/index_sensex", columns, rows, 0, []string{"trade_date"})
}
