package main

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// csvCols maps a CSV header row to column-name -> index, so field access
// reads by name (SctySrs, ClsPric, ...) instead of brittle positional
// indexing that breaks the moment a source adds a column.
type csvCols struct {
	idx map[string]int
}

func newCSVCols(header []string) csvCols {
	m := make(map[string]int, len(header))
	for i, h := range header {
		m[h] = i
	}
	return csvCols{idx: m}
}

func (c csvCols) get(row []string, name string) string {
	if i, ok := c.idx[name]; ok && i < len(row) {
		return row[i]
	}
	return ""
}

// firstFileInZip returns the bytes of the first entry in a zip archive - every
// source here (NSE bhavcopy, MTO, BSE bhavcopy/delivery) ships exactly one
// file per archive.
func firstFileInZip(data []byte) ([]byte, error) {
	r, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	if len(r.File) == 0 {
		return nil, fmt.Errorf("empty zip archive")
	}
	f, err := r.File[0].Open()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

func latestDateInTable(baseDir, dateCol string) (time.Time, error) {
	glob := baseDir + "/**/*.parquet"
	sql := fmt.Sprintf(`SELECT max(%s) AS d FROM read_parquet('%s', hive_partitioning=1)`, dateCol, glob)
	data, err := runDuckDB(sql)
	if err != nil {
		return time.Time{}, err
	}
	var rows []struct {
		D *string `json:"d"`
	}
	if err := json.Unmarshal(data, &rows); err != nil {
		return time.Time{}, err
	}
	if len(rows) == 0 || rows[0].D == nil {
		return time.Time{}, fmt.Errorf("table at %s has no rows yet - run the initial bulk ETL first", baseDir)
	}
	return time.Parse("2006-01-02 15:04:05", *rows[0].D)
}

// datesAfter lists every calendar date strictly after `from`, up to and
// including `to`, skipping Sat/Sun outright - NSE/BSE never trade those, and
// skipping them here avoids a guaranteed-404 request for every weekend day
// in whatever gap is being caught up.
func datesAfter(from, to time.Time) []time.Time {
	var out []time.Time
	for d := from.AddDate(0, 0, 1); !d.After(to); d = d.AddDate(0, 0, 1) {
		if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			continue
		}
		out = append(out, d)
	}
	return out
}

func fetchNSEPriceVolume() (int, error) {
	latest, err := latestDateInTable("D:/project_x/nse/price_volume", "trade_date")
	if err != nil {
		return 0, err
	}
	today := time.Now()
	columns := []string{"trade_date", "symbol", "series", "open", "high", "low", "close", "last", "prev_close", "ttl_trd_qty", "ttl_trd_val", "total_trades", "isin"}
	var allRows [][]string
	var lastErr error
	fetchedAny := false

	for _, d := range datesAfter(latest, today) {
		url := fmt.Sprintf("https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_%s_F_0000.csv.zip", d.Format("20060102"))
		body, err := nseArchiveGet(url)
		if err != nil {
			// A trading holiday looks identical to "not published yet" from
			// here (both 404) - not a real failure, just nothing for that date.
			lastErr = err
			continue
		}
		fetchedAny = true
		csvBytes, err := firstFileInZip(body)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", url, err)
		}
		rows, err := parseNSEBhavcopyUDiFF(csvBytes, d)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", url, err)
		}
		allRows = append(allRows, rows...)
	}

	if len(allRows) == 0 {
		if fetchedAny {
			return 0, nil
		}
		if lastErr != nil {
			return 0, fmt.Errorf("no new trading days available yet (%w)", lastErr)
		}
		return 0, nil
	}
	return mergeRowsIntoTable("D:/project_x/nse/price_volume", columns, allRows, 0, []string{"trade_date", "symbol", "series"})
}

func parseNSEBhavcopyUDiFF(csvBytes []byte, tradeDate time.Time) ([][]string, error) {
	r := csv.NewReader(bytes.NewReader(csvBytes))
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil {
		return nil, err
	}
	cols := newCSVCols(header)
	dateStr := tradeDate.Format("2006-01-02")

	var rows [][]string
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if cols.get(rec, "Sgmt") != "CM" || cols.get(rec, "FinInstrmTp") != "STK" {
			continue
		}
		rows = append(rows, []string{
			dateStr,
			cols.get(rec, "TckrSymb"),
			cols.get(rec, "SctySrs"),
			cols.get(rec, "OpnPric"),
			cols.get(rec, "HghPric"),
			cols.get(rec, "LwPric"),
			cols.get(rec, "ClsPric"),
			cols.get(rec, "LastPric"),
			cols.get(rec, "PrvsClsgPric"),
			cols.get(rec, "TtlTradgVol"),
			cols.get(rec, "TtlTrfVal"),
			cols.get(rec, "TtlNbOfTxsExctd"),
			cols.get(rec, "ISIN"),
		})
	}
	return rows, nil
}
