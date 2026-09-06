package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"time"
)

// The security master isn't a daily time series like the other tables - it's
// a full snapshot of every listed scrip, refetched whole each time and
// stored under today's date, matching build_bse_reference.py's original
// design (partitioned by snapshot_date, several snapshots kept over time).
func fetchBSEReference() (int, error) {
	params := url.Values{
		"scripcode": {""},
		"Group":     {""},
		"industry":  {""},
		"segment":   {"Equity"},
		"status":    {""},
	}
	u := "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?" + params.Encode()
	body, err := bseGet(u)
	if err != nil {
		return 0, err
	}
	var records []map[string]any
	if err := json.Unmarshal(body, &records); err != nil {
		return 0, fmt.Errorf("%s: %w", u, err)
	}
	if len(records) == 0 {
		return 0, fmt.Errorf("empty security catalog response from %s", u)
	}

	today := time.Now().Format("2006-01-02")
	columns := []string{"snapshot_date", "scrip_code", "scrip_id", "scrip_name", "issuer_name", "isin", "status", "group", "face_value", "industry", "segment", "mktcap"}
	rows := make([][]string, 0, len(records))
	for _, rec := range records {
		rows = append(rows, []string{
			today,
			anyToString(rec["SCRIP_CD"]),
			anyToString(rec["scrip_id"]),
			anyToString(rec["Scrip_Name"]),
			anyToString(rec["Issuer_Name"]),
			anyToString(rec["ISIN_NUMBER"]),
			anyToString(rec["Status"]),
			anyToString(rec["GROUP"]),
			anyToString(rec["FACE_VALUE"]),
			anyToString(rec["INDUSTRY"]),
			anyToString(rec["Segment"]),
			anyToString(rec["Mktcap"]),
		})
	}
	return mergeRowsIntoTable("c:/Workdesk/project_x/bse/reference", columns, rows, 0, []string{"snapshot_date", "scrip_code"})
}
