"""Shared helpers for the project_x ETL scripts.

Every table is written as a Hive-partitioned Parquet dataset:
    <base_dir>/year=YYYY/month=MM/week=WW/part-*.parquet
compressed with zstd, via PyArrow. DuckDB is used upstream for any
SQL-shaped cleanup (union-by-name across schema versions, casts, dedup).
"""
import pandas as pd
import pyarrow as pa
import pyarrow.dataset as ds
import numpy as np


def add_partition_cols(df: pd.DataFrame, date_col: str) -> pd.DataFrame:
    dt = pd.to_datetime(df[date_col])
    bad = dt.isna()
    if bad.any():
        print(f"  [warn] dropping {int(bad.sum())} rows with unparseable {date_col}")
        df = df.loc[~bad].copy()
        dt = dt.loc[~bad]
    else:
        df = df.copy()
    df["year"] = dt.dt.year.astype("int32")
    df["month"] = dt.dt.month.astype("int32")
    df["week"] = dt.dt.isocalendar().week.astype("int32")
    return df


def write_partitioned(df: pd.DataFrame, base_dir: str, partition_cols=("year", "month", "week")):
    """Append/overwrite a dataframe into a hive-partitioned zstd parquet dataset."""
    if df.empty:
        print(f"  [skip] nothing to write for {base_dir}")
        return 0
    table = pa.Table.from_pandas(df, preserve_index=False)
    ds.write_dataset(
        table,
        base_dir=base_dir,
        format="parquet",
        partitioning=list(partition_cols),
        partitioning_flavor="hive",
        existing_data_behavior="overwrite_or_ignore",
        file_options=ds.ParquetFileFormat().make_write_options(compression="zstd"),
        basename_template="part-{i}.parquet",
    )
    return len(df)


def clean_num(series: pd.Series) -> pd.Series:
    """Strip Indian-style thousands separators/quotes and coerce to float."""
    return (
        series.astype(str)
        .str.replace(",", "", regex=False)
        .str.strip()
        .replace({"": np.nan, "-": np.nan, "nan": np.nan})
        .astype(float)
    )


def clean_str(series: pd.Series) -> pd.Series:
    return series.astype(str).str.strip().str.strip('"').str.strip()
