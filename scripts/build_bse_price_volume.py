"""BSE price_volume table, sourced from D:/raw/bse/bhavcopy.

Two eras with unrelated schemas:
  2006-2023: EQ<DDMMYY>_CSV.ZIP, inner CSV = SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,
             OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,NO_TRADES,NO_OF_SHRS,NET_TURNOV,...
             (no date column -> date comes from the filename)
  2024-now : BhavCopy_BSE_CM_..._YYYYMMDD_F_0000.CSV (plain, not zipped), the
             new BSE unified format (TradDt, TckrSymb, OpnPric, ... ISIN, etc.)
             filtered to Sgmt=CM / FinInstrmTp=STK (equities).
"""
import glob
import re
import sys
import pandas as pd
sys.path.insert(0, "D:/project_x/scripts")
from common import add_partition_cols, write_partitioned, clean_str

SRC = "D:/raw/bse/bhavcopy"
DST = "D:/project_x/bse/price_volume"

FINAL_COLS = [
    "trade_date", "symbol", "ticker", "isin", "security_name", "series",
    "open", "high", "low", "close", "last", "prev_close",
    "no_trades", "volume", "turnover",
]


def parse_old(path):
    m = re.search(r"EQ(\d{6})_CSV\.ZIP", path, re.IGNORECASE)
    if not m:
        return None, f"{path}: cannot extract date from filename"
    trade_date = pd.to_datetime(m.group(1), format="%d%m%y", errors="coerce")
    if pd.isna(trade_date):
        return None, f"{path}: bad date {m.group(1)}"
    try:
        df = pd.read_csv(path)
    except Exception as e:
        return None, f"{path}: {e}"
    df.columns = [c.strip() for c in df.columns]
    out = pd.DataFrame({
        "trade_date": trade_date,
        "symbol": clean_str(df["SC_CODE"].astype(str)),
        "ticker": pd.array([pd.NA] * len(df), dtype="string"),
        "isin": pd.array([pd.NA] * len(df), dtype="string"),
        "security_name": clean_str(df["SC_NAME"]),
        "series": clean_str(df["SC_GROUP"]),
        "open": pd.to_numeric(df["OPEN"], errors="coerce"),
        "high": pd.to_numeric(df["HIGH"], errors="coerce"),
        "low": pd.to_numeric(df["LOW"], errors="coerce"),
        "close": pd.to_numeric(df["CLOSE"], errors="coerce"),
        "last": pd.to_numeric(df["LAST"], errors="coerce"),
        "prev_close": pd.to_numeric(df["PREVCLOSE"], errors="coerce"),
        "no_trades": pd.to_numeric(df["NO_TRADES"], errors="coerce"),
        "volume": pd.to_numeric(df["NO_OF_SHRS"], errors="coerce"),
        "turnover": pd.to_numeric(df["NET_TURNOV"], errors="coerce"),
    })
    return out, None


def parse_new(path):
    try:
        df = pd.read_csv(path)
    except Exception as e:
        return None, f"{path}: {e}"
    df = df[(df["Sgmt"] == "CM") & (df["FinInstrmTp"] == "STK")]
    out = pd.DataFrame({
        "trade_date": pd.to_datetime(df["TradDt"], errors="coerce"),
        # FinInstrmId is the same numeric scrip code used as SC_CODE pre-2024 -
        # keep 'symbol' as that stable canonical id across the whole history
        # (matches delivery/block_deals, which are always scrip-code-keyed);
        # the human-readable ticker goes in its own column.
        "symbol": df["FinInstrmId"].astype(str),
        "ticker": clean_str(df["TckrSymb"]),
        "isin": clean_str(df["ISIN"]),
        "security_name": clean_str(df["FinInstrmNm"]),
        "series": clean_str(df["SctySrs"]),
        "open": pd.to_numeric(df["OpnPric"], errors="coerce"),
        "high": pd.to_numeric(df["HghPric"], errors="coerce"),
        "low": pd.to_numeric(df["LwPric"], errors="coerce"),
        "close": pd.to_numeric(df["ClsPric"], errors="coerce"),
        "last": pd.to_numeric(df["LastPric"], errors="coerce"),
        "prev_close": pd.to_numeric(df["PrvsClsgPric"], errors="coerce"),
        "no_trades": pd.to_numeric(df["TtlNbOfTxsExctd"], errors="coerce"),
        "volume": pd.to_numeric(df["TtlTradgVol"], errors="coerce"),
        "turnover": pd.to_numeric(df["TtlTrfVal"], errors="coerce"),
    })
    return out, None


def main():
    old_files = sorted({p.lower(): p for p in glob.glob(f"{SRC}/*/*.ZIP") + glob.glob(f"{SRC}/*/*.zip")}.values())
    new_files = sorted({p.lower(): p for p in glob.glob(f"{SRC}/*/*.CSV") + glob.glob(f"{SRC}/*/*.csv")}.values())
    print(f"found {len(old_files)} old-format + {len(new_files)} new-format files")

    errors = []
    by_year = {}

    for i, f in enumerate(old_files):
        df, err = parse_old(f)
        if err:
            errors.append(err)
            continue
        yr = df["trade_date"].iloc[0].year
        by_year.setdefault(yr, []).append(df[FINAL_COLS])
        if (i + 1) % 1000 == 0:
            print(f"  old parsed {i+1}/{len(old_files)}")

    for i, f in enumerate(new_files):
        df, err = parse_new(f)
        if err or df.empty:
            if err:
                errors.append(err)
            continue
        yr = df["trade_date"].dt.year.iloc[0]
        by_year.setdefault(yr, []).append(df[FINAL_COLS])
        if (i + 1) % 200 == 0:
            print(f"  new parsed {i+1}/{len(new_files)}")

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
