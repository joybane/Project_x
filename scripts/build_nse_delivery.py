"""NSE delivery table, sourced from c:/Workdesk/raw/nse/delivery_mto (MTO .DAT files).

Two record formats for the '20,' data rows:
  old (~2002-2004): 20,SYMBOL,SERIES,QTY_TRADED                (no delivery data published)
  new (2005-now)  : 20,SR_NO,SYMBOL,SERIES,QTY_TRADED,DELIV_QTY,DELIV_PCT
Trade date is read from the '10,MTO,DDMMYYYY,...' header line (authoritative,
independent of filename/folder date) so mis-filed snapshots don't get miscounted.

Some days have multiple captured snapshots (plain file + '__v<ts>__<hash>'
duplicates) - rows are de-duplicated after concatenation.
"""
import glob
import sys
import pandas as pd
sys.path.insert(0, "c:/Workdesk/project_x/scripts")
from common import add_partition_cols, write_partitioned

SRC = "c:/Workdesk/raw/nse/delivery_mto"
DST = "c:/Workdesk/project_x/nse/delivery"


def parse_file(path):
    try:
        with open(path, "r", errors="replace") as fh:
            lines = fh.readlines()
    except Exception as e:
        return None, f"{path}: {e}"

    trade_date = None
    rows = []
    for line in lines:
        line = line.strip()
        if line.startswith("10,MTO,"):
            parts = line.split(",")
            ddmmyyyy = parts[2]
            trade_date = pd.to_datetime(ddmmyyyy, format="%d%m%Y", errors="coerce")
        elif line.startswith("20,"):
            parts = [p.strip() for p in line.split(",")]
            # parts[0] == '20'
            rest = parts[1:]
            if len(rest) == 6:
                # SR_NO, SYMBOL, SERIES, QTY, DELIV_QTY, DELIV_PCT
                _, symbol, series, qty, deliv_qty, deliv_pct = rest
                rows.append((symbol, series, qty, deliv_qty, deliv_pct))
            elif len(rest) == 3:
                # SYMBOL, SERIES, QTY  (no delivery data available)
                symbol, series, qty = rest
                rows.append((symbol, series, qty, None, None))
            # else: unexpected shape, skip row

    if trade_date is None or pd.isna(trade_date) or not rows:
        return None, f"{path}: no trade_date/rows parsed"

    df = pd.DataFrame(rows, columns=["symbol", "series", "qty_traded", "deliv_qty", "deliv_pct"])
    df["trade_date"] = trade_date
    df["qty_traded"] = pd.to_numeric(df["qty_traded"], errors="coerce")
    df["deliv_qty"] = pd.to_numeric(df["deliv_qty"], errors="coerce")
    df["deliv_pct"] = pd.to_numeric(df["deliv_pct"], errors="coerce")
    return df[["trade_date", "symbol", "series", "qty_traded", "deliv_qty", "deliv_pct"]], None


def main():
    files = sorted({p.lower(): p for p in glob.glob(f"{SRC}/*/*/*/*.DAT") + glob.glob(f"{SRC}/*/*/*/*.dat")}.values())
    print(f"found {len(files)} MTO files")
    errors = []
    by_year = {}
    for i, f in enumerate(files):
        df, err = parse_file(f)
        if err:
            errors.append(err)
            continue
        yr = df["trade_date"].dt.year.iloc[0]
        by_year.setdefault(yr, []).append(df)
        if (i + 1) % 1000 == 0:
            print(f"  parsed {i+1}/{len(files)}")

    total_rows = 0
    for yr in sorted(by_year):
        year_df = pd.concat(by_year[yr], ignore_index=True)
        year_df = year_df.drop_duplicates(subset=["trade_date", "symbol", "series"])
        year_df = add_partition_cols(year_df, "trade_date")
        n = write_partitioned(year_df, DST)
        total_rows += n
        print(f"  year {yr}: {n} rows")

    print(f"TOTAL rows written: {total_rows}")
    print(f"errors: {len(errors)}")
    for e in errors[:20]:
        print("  ERR", e)


if __name__ == "__main__":
    main()
