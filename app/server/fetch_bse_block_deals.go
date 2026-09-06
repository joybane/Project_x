package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

type bseTableResponse struct {
	Table []map[string]any `json:"Table"`
}

func fetchBSEBlockDeals() (int, error) {
	latest, err := latestDateInTable("c:/Workdesk/project_x/bse/block_deals", "trade_date")
	if err != nil {
		return 0, err
	}
	today := time.Now()
	if !latest.Before(today) {
		return 0, nil
	}
	from := latest.AddDate(0, 0, 1)
	columns := []string{"trade_date", "scrip_code", "security_name", "transaction_type", "client_name", "quantity", "price"}

	// The API takes one calendar month at a time in practice (bse_pipeline.py
	// walks it the same way) - a multi-month gap is walked here rather than
	// requested in one call, since the endpoint's own range handling for long
	// spans is unverified from the Go side.
	var allRows [][]string
	for monthStart := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, time.UTC); !monthStart.After(today); monthStart = monthStart.AddDate(0, 1, 0) {
		rangeStart := monthStart
		if rangeStart.Before(from) {
			rangeStart = from
		}
		rangeEnd := monthStart.AddDate(0, 1, -1)
		if rangeEnd.After(today) {
			rangeEnd = today
		}

		params := url.Values{
			"DealType": {"2"},
			"sc_code":  {""},
			"FDate":    {rangeStart.Format("02/01/2006")},
			"TDate":    {rangeEnd.Format("02/01/2006")},
		}
		u := "https://api.bseindia.com/BseIndiaAPI/api/BulkDealData_ng/w?" + params.Encode()
		body, err := bseGet(u)
		if err != nil {
			return len(allRows), err
		}
		var parsed bseTableResponse
		if err := json.Unmarshal(body, &parsed); err != nil {
			return len(allRows), fmt.Errorf("%s: %w", u, err)
		}
		for _, row := range parsed.Table {
			dealDate, _ := row["DEAL_DATE"].(string)
			d, err := time.Parse("2006-01-02T15:04:05", dealDate)
			if err != nil {
				continue
			}
			allRows = append(allRows, []string{
				d.Format("2006-01-02"),
				anyToString(row["SCRIP_CODE"]),
				anyToString(row["scripname"]),
				anyToString(row["TRANSACTION_TYPE"]),
				anyToString(row["CLIENT_NAME"]),
				anyToString(row["QUANTITY"]),
				anyToString(row["PRICE"]),
			})
		}
	}

	if len(allRows) == 0 {
		return 0, nil
	}
	return mergeRowsIntoTable("c:/Workdesk/project_x/bse/block_deals", columns, allRows, 0, columns)
}

func anyToString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return fmt.Sprintf("%v", t)
	}
}
