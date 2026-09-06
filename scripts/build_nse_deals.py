"""NSE bulk_deals, block_deals, short_selling tables.

Sources share one quirky format: BOM-prefixed, quoted CSV, trailing spaces in
header names, numbers using Indian-style comma grouping inside quotes
(e.g. "1,41,600"). Each source folder mixes:
  - <year>/ranges/<name>_<start>_<end>.csv   (pre-consolidated yearly exports)
  - <year>/<mm>/<dd>/bulk-block-short-deals[__v<ts>__<hash>]  (daily snapshots,
    sometimes captured more than once -> exact-duplicate rows after parsing)
Rows are de-duplicated after concatenation so overlapping range/daily/re-capture
files don't double count.
"""
import glob
import os
import sys
import pandas as pd
sys.path.insert(0, "c:/Workdesk/project_x/scripts")
from common import add_partition_cols, write_partitioned, clean_num, clean_str

JOBS = {
    "bulk_deals": {
        "src": "c:/Workdesk/raw/nse/historical_bulk_deals",
        "dst": "c:/Workdesk/project_x/nse/bulk_deals",
        "has_client": True,
    },
    "block_deals": {
        "src": "c:/Workdesk/raw/nse/historical_block_deals",
        "dst": "c:/Workdesk/project_x/nse/block_deals",
        "has_client": True,
    },
    "short_selling": {
        "src": "c:/Workdesk/raw/nse/historical_short_selling",
        "dst": "c:/Workdesk/project_x/nse/short_selling",
        "has_client": False,
    },
}


def parse_file(path, has_client):
    try:
        df = pd.read_csv(path, encoding="utf-8-sig", dtype=str)
    except Exception as e:
        return None, f"{path}: {e}"
    df.columns = [c.strip().strip('"').strip() for c in df.columns]
    col_map = {c: c.lower().replace(".", "").replace("/", "_").replace(" ", "_").strip("_") for c in df.columns}
    df = df.rename(columns=col_map)

    if "date" not in df.columns or "symbol" not in df.columns:
        return None, f"{path}: missing date/symbol columns {list(df.columns)}"

    out = pd.DataFrame()
    out["trade_date"] = pd.to_datetime(clean_str(df["date"]), format="%d-%b-%Y", errors="coerce")
    out["symbol"] = clean_str(df["symbol"])
    if "security_name" in df.columns:
        out["security_name"] = clean_str(df["security_name"])
    if has_client:
        client_col = "client_name" if "client_name" in df.columns else None
        out["client_name"] = clean_str(df[client_col]) if client_col else pd.NA
        bs_col = "buy_sell" if "buy_sell" in df.columns else "buy___sell"
        out["buy_sell"] = clean_str(df[bs_col]) if bs_col in df.columns else pd.NA
        qty_col = "quantity_traded" if "quantity_traded" in df.columns else None
        out["quantity"] = clean_num(df[qty_col]) if qty_col else pd.NA
        price_col = [c for c in df.columns if c.startswith("trade_price")]
        out["price"] = clean_num(df[price_col[0]]) if price_col else pd.NA
    else:
        out["quantity"] = clean_num(df["quantity"]) if "quantity" in df.columns else pd.NA

    out = out.dropna(subset=["trade_date", "symbol"])
    return out, None


def run(name, cfg):
    files = sorted(glob.glob(f"{cfg['src']}/**/*", recursive=True))
    files = [f for f in files if os.path.isfile(f)]
    print(f"[{name}] found {len(files)} files")
    errors = []
    frames = []
    for i, f in enumerate(files):
        df, err = parse_file(f, cfg["has_client"])
        if err:
            errors.append(err)
            continue
        frames.append(df)
        if (i + 1) % 20 == 0:
            print(f"  parsed {i+1}/{len(files)}")

    if not frames:
        print(f"[{name}] no data parsed; errors={errors}")
        return

    full = pd.concat(frames, ignore_index=True)
    before = len(full)
    full = full.drop_duplicates()
    print(f"[{name}] rows before dedup={before} after dedup={len(full)}")

    total_rows = 0
    full = add_partition_cols(full, "trade_date")
    for yr, year_df in full.groupby("year"):
        n = write_partitioned(year_df, cfg["dst"])
        total_rows += n
    print(f"[{name}] TOTAL rows written: {total_rows}, errors: {len(errors)}")
    for e in errors[:10]:
        print("  ERR", e)


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for name, cfg in JOBS.items():
        if only and name != only:
            continue
        run(name, cfg)
