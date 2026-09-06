"""BSE block_deals table, sourced from c:/Workdesk/raw/bse/events/block_deals (monthly JSON, {"Table": [...]}).

Verified legit per-month data (each file's DEAL_DATE values match its own
filename's year/month), unlike corporate_actions which was skipped.
"""
import glob
import json
import sys
import pandas as pd
sys.path.insert(0, "c:/Workdesk/project_x/scripts")
from common import add_partition_cols, write_partitioned, clean_str

SRC = "c:/Workdesk/raw/bse/events/block_deals"
DST = "c:/Workdesk/project_x/bse/block_deals"


def parse_file(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            d = json.load(fh)
    except Exception as e:
        return None, f"{path}: {e}"
    rows = d.get("Table", []) if isinstance(d, dict) else d
    if not rows:
        return None, None
    df = pd.DataFrame(rows)
    out = pd.DataFrame({
        "trade_date": pd.to_datetime(df["DEAL_DATE"], errors="coerce"),
        "scrip_code": clean_str(df["SCRIP_CODE"].astype(str)),
        "security_name": clean_str(df["scripname"]) if "scripname" in df.columns else pd.NA,
        "transaction_type": clean_str(df["TRANSACTION_TYPE"]) if "TRANSACTION_TYPE" in df.columns else pd.NA,
        "client_name": clean_str(df["CLIENT_NAME"]) if "CLIENT_NAME" in df.columns else pd.NA,
        "quantity": pd.to_numeric(df["QUANTITY"], errors="coerce") if "QUANTITY" in df.columns else pd.NA,
        "price": pd.to_numeric(df["PRICE"], errors="coerce") if "PRICE" in df.columns else pd.NA,
    })
    return out.dropna(subset=["trade_date"]), None


def main():
    files = sorted(glob.glob(f"{SRC}/*/*.json"))
    print(f"found {len(files)} BSE block deal files")
    errors = []
    by_year = {}
    for f in files:
        df, err = parse_file(f)
        if err:
            errors.append(err)
            continue
        if df is None or df.empty:
            continue
        yr = df["trade_date"].dt.year.iloc[0]
        by_year.setdefault(yr, []).append(df)

    total_rows = 0
    for yr in sorted(by_year):
        year_df = pd.concat(by_year[yr], ignore_index=True).drop_duplicates()
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
