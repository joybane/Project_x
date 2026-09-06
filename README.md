# Project X — NSE/BSE Market Terminal

A local, self-hosted market-data terminal for Indian equities (NSE + BSE): a Go
backend that serves candlestick price/volume, delivery %, and bulk/block/short-selling
deal data straight out of Parquet files via DuckDB, plus a React/Vite frontend for
charting and screening.

## Architecture

```
scripts/       Python ETL - downloads and normalizes raw NSE/BSE files into
                partitioned Parquet under nse/ and bse/ (not checked into git,
                see "Data" below)
app/server/    Go backend (module stockapp/server). Queries the Parquet data
                with the duckdb CLI, exposes a small JSON API, and embeds the
                built frontend so it can run as a single executable that opens
                its own chromeless window ("desktop" mode)
app/frontend/  React + TypeScript + Vite UI - candlestick charts
                (lightweight-charts), tables (@tanstack/react-table), data
                fetching (@tanstack/react-query)
```

API surface (`app/server/main.go`):
- `GET /api/symbols?exchange=&q=` — ticker/company search
- `GET /api/price?exchange=&symbol=&from=&to=` — OHLCV candles
- `GET /api/delivery?exchange=&symbol=&from=&to=` — delivery % data
- `GET /api/deals?exchange=&type=&symbol=&from=&to=&page=&pageSize=` — bulk/block/short-selling deals
- `GET|POST /api/update` — check/trigger a refresh of the local Parquet tables

## Data

`nse/` and `bse/` (raw + processed Parquet, several GB) are intentionally excluded
from this repo via `.gitignore` — they're proprietary exchange data, regenerated
locally by the ETL scripts in `scripts/`. Nothing in `app/` needs them to be
tracked in git; they just need to exist on disk at `D:/project_x/nse` and
`D:/project_x/bse` (that path is currently hardcoded as `dataRoot` in
`app/server/main.go`).

## Prerequisites

- Go 1.25+
- Node.js 18+ and npm
- [DuckDB CLI](https://duckdb.org/docs/installation/) on `PATH` — the Go server shells out to it
- Python 3.10+ with `pandas`, `pyarrow`, `numpy` (only needed to run the ETL scripts)
- Windows with Microsoft Edge installed — desktop mode opens a chromeless `msedge --app` window

## Running it

### 1. Desktop app (single window, production-style)

Runs the Go server, which serves both the API and the already-built frontend,
and pops open its own app window — no browser tabs, no second terminal.

```bash
cd app/server
go run .
```

This opens a chromeless window at `http://127.0.0.1:8787`. If that port is
already serving (another instance already running), it just opens another
window onto it instead of starting a second backend.

To rebuild the embedded frontend after making UI changes:

```bash
cd app/frontend
npm install
npm run build
rm -rf ../server/web/*
cp -r dist/* ../server/web/
```

Then re-run `go run .` (or `go build -o stockapp_server.exe .`) from `app/server`.

### 2. Browser / dev mode (hot-reload frontend)

Run the backend and frontend as two separate processes — useful while
developing the UI, since Vite hot-reloads on save.

```bash
# terminal 1 - API only
cd app/server
go run .
```

```bash
# terminal 2 - frontend dev server (proxies /api to :8787, see vite.config.ts)
cd app/frontend
npm install
npm run dev -- --host 127.0.0.1
```

Open the printed URL (default `http://127.0.0.1:5173`) in your browser.

> Set `STOCKAPP_NO_WINDOW=1` before `go run .` if you don't want the Go server
> to also pop open its own Edge window while you're using the Vite dev server.

## Refreshing data

`POST /api/update` (there's a control for this in the UI) re-runs the fetch
steps registered in `app/server/update.go`, pulling the latest NSE/BSE files
and appending them to the Parquet tables. `GET /api/update` reports progress
per step. The individual fetch/build steps for each table also exist as
standalone Python scripts in `scripts/`, for one-off backfills.
