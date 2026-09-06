"""NSE price_volume table, sourced from c:/Workdesk/raw/nse/cm_bhavcopy_legacy.

Schema evolves over time:
  1994-~2001: SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP
  ~2001-now : ...,TOTALTRADES,ISIN added
Missing columns (TOTALTRADES/ISIN) are filled with NULL for old rows.
"""
import glob
import sys
import pandas as pd
sys.path.insert(0, "c:/Workdesk/project_x/scripts")
from common import add_partition_cols, write_partitioned, clean_str

SRC = "c:/Workdesk/raw/nse/cm_bhavcopy_legacy"
DST = "c:/Workdesk/project_x/nse/price_volume"

FINAL_COLS = [
    "trade_date", "symbol", "series", "open", "high", "low", "close", "last",
    "prev_close", "ttl_trd_qty", "ttl_trd_val", "total_trades", "isin",
]


def parse_file(path):
    try:
        df = pd.read_csv(path)
    except Exception as e:
        return None, f"{path}: {e}"
    df.columns = [c.strip().upper() for c in df.columns]
    df = df.loc[:, [c for c in df.columns if c != ""]]
    if "TOTALTRADES" not in df.columns:
        df["TOTALTRADES"] = pd.NA
    if "ISIN" not in df.columns:
        df["ISIN"] = pd.NA
    ts = df["TIMESTAMP"].astype(str).str.strip()
    trade_date = pd.to_datetime(ts, format="%d-%b-%Y", errors="coerce")
    still_bad = trade_date.isna()
    if still_bad.any():
        trade_date.loc[still_bad] = pd.to_datetime(ts[still_bad], format="%d-%b-%y", errors="coerce")
    out = pd.DataFrame({
        "trade_date": trade_date,
        "symbol": clean_str(df["SYMBOL"]),
        "series": clean_str(df["SERIES"]),
        "open": pd.to_numeric(df["OPEN"], errors="coerce"),
        "high": pd.to_numeric(df["HIGH"], errors="coerce"),
        "low": pd.to_numeric(df["LOW"], errors="coerce"),
        "close": pd.to_numeric(df["CLOSE"], errors="coerce"),
        "last": pd.to_numeric(df["LAST"], errors="coerce"),
        "prev_close": pd.to_numeric(df["PREVCLOSE"], errors="coerce"),
        "ttl_trd_qty": pd.to_numeric(df["TOTTRDQTY"], errors="coerce"),
        "ttl_trd_val": pd.to_numeric(df["TOTTRDVAL"], errors="coerce"),
        "total_trades": pd.to_numeric(df["TOTALTRADES"], errors="coerce"),
        "isin": df["ISIN"].astype("string").str.strip(),
    })
    return out, None


def main():
    files = sorted({p.lower(): p for p in glob.glob(f"{SRC}/*/*/*.zip") + glob.glob(f"{SRC}/*/*/*.ZIP")}.values())
    print(f"found {len(files)} legacy bhavcopy files")
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
        year_df = pd.concat(by_year[yr], ignore_index=True)[FINAL_COLS]
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
