package main

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"time"
)

func fetchBSEPriceVolume() (int, error) {
	latest, err := latestDateInTable("c:/Workdesk/project_x/bse/price_volume", "trade_date")
	if err != nil {
		return 0, err
	}
	today := time.Now()
	columns := []string{"trade_date", "symbol", "ticker", "isin", "security_name", "series", "open", "high", "low", "close", "last", "prev_close", "no_trades", "volume", "turnover"}
	var allRows [][]string
	var lastErr error

	for _, d := range datesAfter(latest, today) {
		url := fmt.Sprintf("https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_%s_F_0000.CSV", d.Format("20060102"))
		body, err := bseGet(url)
		if err != nil {
			lastErr = err
			continue
		}
		rows, err := parseBSEBhavcopyUDiFF(body)
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
	// FinInstrmId (== symbol here) is the same stable scrip code used
	// throughout BSE's own history and shared with delivery/block_deals -
	// see build_bse_price_volume.py. No series-duplicate rows appear for BSE
	// the way they do for NSE, so (trade_date, symbol) alone is unique.
	return mergeRowsIntoTable("c:/Workdesk/project_x/bse/price_volume", columns, allRows, 0, []string{"trade_date", "symbol"})
}

func parseBSEBhavcopyUDiFF(csvBytes []byte) ([][]string, error) {
	csvBytes = bytes.TrimPrefix(csvBytes, []byte{0xEF, 0xBB, 0xBF})
	r := csv.NewReader(bytes.NewReader(csvBytes))
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil {
		return nil, err
	}
	cols := newCSVCols(header)

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
		tradeDate, err := time.Parse("2006-01-02", cols.get(rec, "TradDt"))
		if err != nil {
			continue
		}
		rows = append(rows, []string{
			tradeDate.Format("2006-01-02"),
			cols.get(rec, "FinInstrmId"),
			cols.get(rec, "TckrSymb"),
			cols.get(rec, "ISIN"),
			cols.get(rec, "FinInstrmNm"),
			cols.get(rec, "SctySrs"),
			cols.get(rec, "OpnPric"),
			cols.get(rec, "HghPric"),
			cols.get(rec, "LwPric"),
			cols.get(rec, "ClsPric"),
			cols.get(rec, "LastPric"),
			cols.get(rec, "PrvsClsgPric"),
			cols.get(rec, "TtlNbOfTxsExctd"),
			cols.get(rec, "TtlTradgVol"),
			cols.get(rec, "TtlTrfVal"),
		})
	}
	return rows, nil
}
