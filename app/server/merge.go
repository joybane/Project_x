package main

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// partitionOf mirrors the Python ETL's scheme exactly (common.py:
// year/month are calendar, week is the ISO week number alone - the ISO
// week's own year is discarded even though it can differ from the calendar
// year right at year boundaries). New rows must land in the same partition
// scheme as the historical bulk-load, or a query spanning both silently
// misses whichever half it isn't looking in.
func partitionOf(d time.Time) (year, month, week int) {
	_, isoWeek := d.ISOWeek()
	return d.Year(), int(d.Month()), isoWeek
}

// mergeRowsIntoTable appends rows into an existing hive-partitioned parquet
// table, rewriting only the specific weekly partitions the new rows touch -
// not the whole table, which for something like price_volume would mean
// rewriting 30 years of history to add one day. Rows sharing a full key
// (keyCols) with an existing row are treated as a correction and replace it
// rather than duplicating.
//
// columns must match the target table's existing column names (order
// doesn't matter to DuckDB's read_csv_auto, which matches by name).
func mergeRowsIntoTable(baseDir string, columns []string, rows [][]string, dateColIdx int, keyCols []string) (int, error) {
	if len(rows) == 0 {
		return 0, nil
	}

	type partitionKey struct{ year, month, week int }
	groups := map[partitionKey][][]string{}
	for _, row := range rows {
		d, err := time.Parse("2006-01-02", row[dateColIdx])
		if err != nil {
			return 0, fmt.Errorf("row date %q: %w", row[dateColIdx], err)
		}
		y, m, w := partitionOf(d)
		key := partitionKey{y, m, w}
		groups[key] = append(groups[key], row)
	}

	total := 0
	for key, groupRows := range groups {
		n, err := mergeOnePartition(baseDir, columns, groupRows, keyCols, key.year, key.month, key.week)
		if err != nil {
			return total, fmt.Errorf("partition year=%d/month=%d/week=%d: %w", key.year, key.month, key.week, err)
		}
		total += n
	}
	return total, nil
}

func mergeOnePartition(baseDir string, columns []string, rows [][]string, keyCols []string, year, month, week int) (int, error) {
	partDir := filepath.Join(baseDir, fmt.Sprintf("year=%d", year), fmt.Sprintf("month=%d", month), fmt.Sprintf("week=%d", week))
	if err := os.MkdirAll(partDir, 0o755); err != nil {
		return 0, err
	}
	partFile := filepath.Join(partDir, "part-0.parquet")
	partFileSQL := filepath.ToSlash(partFile)

	tmpCSV, err := os.CreateTemp("", "px-merge-*.csv")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmpCSV.Name())
	w := csv.NewWriter(tmpCSV)
	if err := w.Write(columns); err != nil {
		return 0, err
	}
	if err := w.WriteAll(rows); err != nil {
		return 0, err
	}
	w.Flush()
	tmpCSV.Close()
	csvPathSQL := filepath.ToSlash(tmpCSV.Name())

	outTmp := partFile + ".tmp"
	outTmpSQL := filepath.ToSlash(outTmp)

	// __src tags which side of the union a row came from, purely so a key
	// collision resolves to the freshly-fetched row (1) over the archived one
	// (0) - e.g. NSE republishing a corrected bhavcopy for a date it already
	// has. Excluded from the final output; it never reaches the parquet file.
	newRowsSource := fmt.Sprintf("SELECT *, 1 AS __src FROM read_csv_auto('%s', header=true)", csvPathSQL)
	combinedSource := newRowsSource
	if _, statErr := os.Stat(partFile); statErr == nil {
		combinedSource = fmt.Sprintf(
			"SELECT *, 0 AS __src FROM read_parquet('%s') UNION ALL BY NAME %s",
			partFileSQL, newRowsSource,
		)
	}

	sql := fmt.Sprintf(`
		COPY (
			SELECT * EXCLUDE (__rn, __src) FROM (
				SELECT *, ROW_NUMBER() OVER (
					PARTITION BY %s ORDER BY __src DESC
				) AS __rn
				FROM (%s)
			) WHERE __rn = 1
		) TO '%s' (FORMAT PARQUET, COMPRESSION ZSTD)`,
		quoteCols(keyCols), combinedSource, outTmpSQL)

	if err := runDuckDBExec(sql); err != nil {
		return 0, err
	}
	if err := os.Rename(outTmp, partFile); err != nil {
		return 0, err
	}
	return len(rows), nil
}

func quoteCols(cols []string) string {
	out := ""
	for i, c := range cols {
		if i > 0 {
			out += ", "
		}
		out += c
	}
	return out
}

// runDuckDBExec runs a DuckDB statement that produces no result set (DDL,
// COPY). Unlike runDuckDB (main.go), it doesn't pass -json since there's
// nothing tabular to parse - just success/failure.
func runDuckDBExec(sql string) error {
	cmd := exec.Command("duckdb", "-c", sql)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("duckdb error: %v: %s", err, stderr.String())
	}
	return nil
}
