"""BSE index_sensex table, sourced from c:/Workdesk/raw/bse/index/sensex.

Files are one long historical export plus a few small overlapping recent
top-ups; de-duplicated by Date after concatenation.
"""
import glob
import sys
import pandas as pd
sys.path.insert(0, "c:/Workdesk/project_x/scripts")
from common import add_partition_cols, write_partitioned

SRC = "c:/Workdesk/raw/bse/index/sensex"
DST = "c:/Workdesk/project_x/bse/index_sensex"


def main():
    files = sorted({p.lower(): p for p in glob.glob(f"{SRC}/*.csv") + glob.glob(f"{SRC}/*.CSV")}.values())
    print(f"found {len(files)} sensex files")
    frames = []
    for f in files:
        df = pd.read_csv(f)
        df.columns = [c.strip() for c in df.columns]
        df["Date"] = pd.to_datetime(df["Date"], format="%d-%B-%Y", errors="coerce")
        frames.append(df)

    full = pd.concat(frames, ignore_index=True)
    full = full.rename(columns={"Date": "trade_date", "Open": "open", "High": "high", "Low": "low", "Close": "close"})
    full = full.dropna(subset=["trade_date"]).drop_duplicates(subset=["trade_date"])
    full = add_partition_cols(full, "trade_date")
    total_rows = 0
    for yr, year_df in full.groupby("year"):
        n = write_partitioned(year_df, DST)
        total_rows += n
    print(f"TOTAL rows written: {total_rows}")


if __name__ == "__main__":
    main()
