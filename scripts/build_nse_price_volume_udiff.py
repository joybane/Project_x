"""Extends nse/price_volume using c:/Workdesk/raw/nse/cm_bhavcopy_udiff (2024-07 onward),
the successor format to cm_bhavcopy_legacy (which stops 2024-07-05).

cm_bhavcopy_udiff uses NSE's newer unified schema (same shape as the BSE UDiFF
files): TradDt, TckrSymb, SctySrs, OpnPric, ... filtered to Sgmt=CM/FinInstrmTp=STK.

Legacy's last trading day is Fri 2024-07-05 (ISO week 27); udiff's first file is
Mon 2024-07-08 (week 28) - the two sources land in disjoint week partitions, so
this is a pure append with no overlapping partition files to merge.
"""
import glob
import sys
import pandas as pd
sys.path.insert(0, "c:/Workdesk/project_x/scripts")
from common import add_partition_cols, write_partitioned, clean_str

SRC = "c:/Workdesk/raw/nse/cm_bhavcopy_udiff"
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
    df = df[(df["Sgmt"] == "CM") & (df["FinInstrmTp"] == "STK")]
    if df.empty:
        return None, None
    out = pd.DataFrame({
        "trade_date": pd.to_datetime(df["TradDt"], errors="coerce"),
        "symbol": clean_str(df["TckrSymb"]),
        "series": clean_str(df["SctySrs"]),
        "open": pd.to_numeric(df["OpnPric"], errors="coerce"),
        "high": pd.to_numeric(df["HghPric"], errors="coerce"),
        "low": pd.to_numeric(df["LwPric"], errors="coerce"),
        "close": pd.to_numeric(df["ClsPric"], errors="coerce"),
        "last": pd.to_numeric(df["LastPric"], errors="coerce"),
        "prev_close": pd.to_numeric(df["PrvsClsgPric"], errors="coerce"),
        "ttl_trd_qty": pd.to_numeric(df["TtlTradgVol"], errors="coerce"),
        "ttl_trd_val": pd.to_numeric(df["TtlTrfVal"], errors="coerce"),
        "total_trades": pd.to_numeric(df["TtlNbOfTxsExctd"], errors="coerce"),
        "isin": df["ISIN"].astype("string").str.strip(),
    })
    return out[FINAL_COLS], None


def main():
    patterns = [f"{SRC}/*/*/*.zip", f"{SRC}/*/*/*.ZIP", f"{SRC}/*/*/*/*.zip", f"{SRC}/*/*/*/*.ZIP"]
    files = sorted({p.lower(): p for pat in patterns for p in glob.glob(pat)}.values())
    print(f"found {len(files)} udiff bhavcopy files")
    errors = []
    by_year = {}
    for i, f in enumerate(files):
        df, err = parse_file(f)
        if err:
            errors.append(err)
            continue
        if df is None or df.empty:
            continue
        yr = df["trade_date"].dt.year.iloc[0]
        by_year.setdefault(yr, []).append(df)
        if (i + 1) % 100 == 0:
            print(f"  parsed {i+1}/{len(files)}")

    total_rows = 0
    for yr in sorted(by_year):
        year_df = pd.concat(by_year[yr], ignore_index=True)
        before = len(year_df)
        year_df = year_df.drop_duplicates(subset=["trade_date", "symbol", "series"])
        year_df = add_partition_cols(year_df, "trade_date")
        n = write_partitioned(year_df, DST)
        total_rows += n
        print(f"  year {yr}: {n} rows (dedup dropped {before - len(year_df)})")

    print(f"TOTAL rows written: {total_rows}")
    print(f"errors: {len(errors)}")
    for e in errors[:20]:
        print("  ERR", e)


if __name__ == "__main__":
    main()
