"""BSE reference table (security master/catalog), sourced from D:/raw/bse/reference.

Each file is a full snapshot of the security master as of the date in its
filename (not a daily timeseries) - partitioned the same way for consistency,
with a snapshot_date column identifying which capture each row belongs to.
"""
import glob
import json
import re
import sys
import pandas as pd
sys.path.insert(0, "D:/project_x/scripts")
from common import add_partition_cols, write_partitioned, clean_str

SRC = "D:/raw/bse/reference"
DST = "D:/project_x/bse/reference"


def main():
    files = sorted(glob.glob(f"{SRC}/security_catalog_*.json"))
    print(f"found {len(files)} reference snapshot files")
    frames = []
    for f in files:
        m = re.search(r"security_catalog_(\d{8})\.json", f)
        snap_date = pd.to_datetime(m.group(1), format="%Y%m%d")
        with open(f, "r", encoding="utf-8-sig") as fh:
            d = json.load(fh)
        df = pd.DataFrame(d)
        out = pd.DataFrame({
            "snapshot_date": snap_date,
            "scrip_code": clean_str(df["SCRIP_CD"].astype(str)),
            "scrip_id": clean_str(df["scrip_id"]) if "scrip_id" in df.columns else pd.NA,
            "scrip_name": clean_str(df["Scrip_Name"]) if "Scrip_Name" in df.columns else pd.NA,
            "issuer_name": clean_str(df["Issuer_Name"]) if "Issuer_Name" in df.columns else pd.NA,
            "isin": clean_str(df["ISIN_NUMBER"]) if "ISIN_NUMBER" in df.columns else pd.NA,
            "status": clean_str(df["Status"]) if "Status" in df.columns else pd.NA,
            "group": clean_str(df["GROUP"]) if "GROUP" in df.columns else pd.NA,
            "face_value": pd.to_numeric(df["FACE_VALUE"], errors="coerce") if "FACE_VALUE" in df.columns else pd.NA,
            "industry": clean_str(df["INDUSTRY"]) if "INDUSTRY" in df.columns else pd.NA,
            "segment": clean_str(df["Segment"]) if "Segment" in df.columns else pd.NA,
            "mktcap": pd.to_numeric(df["Mktcap"], errors="coerce") if "Mktcap" in df.columns else pd.NA,
        })
        frames.append(out)

    full = pd.concat(frames, ignore_index=True)
    full = add_partition_cols(full, "snapshot_date")
    n = write_partitioned(full, DST)
    print(f"TOTAL rows written: {n}")


if __name__ == "__main__":
    main()
