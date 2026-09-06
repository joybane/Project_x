"""BSE delivery table, sourced from D:/raw/bse/delivery (SCBSEALL*.zip -> pipe-delimited TXT).

Columns: DATE|SCRIP CODE|DELIVERY QTY|DELIVERY VAL|DAY'S VOLUME|DAY'S TURNOVER|DELV. PER.
Format is stable across the whole history; DATE column (DDMMYYYY) is authoritative.
"""
import glob
import sys
import pandas as pd
sys.path.insert(0, "D:/project_x/scripts")
from common import add_partition_cols, write_partitioned, clean_str

SRC = "D:/raw/bse/delivery"
DST = "D:/project_x/bse/delivery"


def parse_file(path):
    try:
        df = pd.read_csv(path, sep="|")
    except Exception as e:
        return None, f"{path}: {e}"
    # a couple of files use a backtick instead of an apostrophe in the header
    df.columns = [c.strip().replace("`", "'") for c in df.columns]
    out = pd.DataFrame({
        "trade_date": pd.to_datetime(df["DATE"].astype(str).str.zfill(8), format="%d%m%Y", errors="coerce"),
        "symbol": clean_str(df["SCRIP CODE"].astype(str)),
        "deliv_qty": pd.to_numeric(df["DELIVERY QTY"], errors="coerce"),
        "deliv_val": pd.to_numeric(df["DELIVERY VAL"], errors="coerce"),
        "volume": pd.to_numeric(df["DAY'S VOLUME"], errors="coerce"),
        "turnover": pd.to_numeric(df["DAY'S TURNOVER"], errors="coerce"),
        "deliv_pct": pd.to_numeric(df["DELV. PER."], errors="coerce"),
    })
    return out.dropna(subset=["trade_date"]), None


def main():
    files = sorted({p.lower(): p for p in glob.glob(f"{SRC}/*/*.zip") + glob.glob(f"{SRC}/*/*.ZIP")}.values())
    print(f"found {len(files)} BSE delivery files")
    errors = []
    by_year = {}
    for i, f in enumerate(files):
        df, err = parse_file(f)
        if err or df is None or df.empty:
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
