import { useMemo, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import type { Deal } from "@/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtPrice, fmtQty } from "@/lib/format";

type ScreenerDeal = Deal & { deal_type?: string };
const columnHelper = createColumnHelper<ScreenerDeal>();

export default function DealsTable({ deals, nets }: { deals: ScreenerDeal[]; nets?: Map<string, number> }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "trade_date", desc: true }]);
  const hasClient = deals.some((row) => row.client_name != null);

  const columns = useMemo(() => {
    const cols = [
      columnHelper.accessor("trade_date", {
        header: "Date",
        cell: (c) => c.getValue().slice(0, 10),
      }),
      columnHelper.accessor("symbol", {
        header: "Symbol",
        cell: (c) => <span className="font-medium">{c.getValue()}</span>,
      }),
      columnHelper.accessor("security_name", {
        header: "Security",
        cell: (c) => c.getValue() ?? "",
      }),
    ];
    cols.push(columnHelper.accessor("deal_type", {
      header: "Type",
      cell: (c) => ({ bulk_deals: "Bulk", block_deals: "Block", short_selling: "Short" })[c.getValue() ?? ""] ?? "--",
    }) as never);
    if (hasClient) {
      cols.push(
        columnHelper.accessor("client_name", {
          header: "Client",
          cell: (c) => c.getValue() ?? "",
        }) as never,
        columnHelper.accessor("buy_sell", {
          header: "Side",
          cell: (c) => {
            const v = c.getValue();
            return v ? <Badge variant={v === "BUY" ? "success" : "danger"}>{v}</Badge> : null;
          },
        }) as never
      );
    }
    cols.push(
      columnHelper.accessor("quantity", {
        header: "Quantity",
        cell: (c) => (c.getValue() != null ? fmtQty.format(c.getValue() as number) : ""),
      }) as never
    );
    if (hasClient) {
      cols.push(
        columnHelper.accessor("price", {
          header: "Price",
          cell: (c) => (c.getValue() != null ? fmtPrice.format(c.getValue() as number) : ""),
        }) as never
      );
    }
    if (nets) cols.push(columnHelper.accessor((row) => nets.get(`${row.symbol}:${row.trade_date.slice(0, 10)}`) ?? 0, {
      id: "session_net", header: "Session net",
      cell: (c) => <span className={c.getValue() > 0 ? "text-success" : c.getValue() < 0 ? "text-danger" : ""}>{fmtQty.format(c.getValue())}</span>,
    }) as never);
    return cols;
  }, [hasClient, nets]);

  const table = useReactTable({
    data: deals,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageIndex: 0, pageSize: 25 } },
  });

  if (deals.length === 0) {
    return <p className="text-sm text-muted-foreground">No deals in this range.</p>;
  }

  return (
    <div className="scanner-table-wrap">
    <div className="max-h-[600px] overflow-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((header) => {
                const sortDir = header.column.getIsSorted();
                const numeric = ["quantity", "price", "session_net"].includes(header.column.id);
                return (
                  <TableHead
                    key={header.id}
                    className={cn("cursor-pointer select-none", numeric && "text-right")}
                    aria-sort={sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : "none"}
                  >
                    <button onClick={header.column.getToggleSortingHandler()} className={cn("inline-flex items-center gap-1", numeric && "flex-row-reverse")}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {sortDir === "asc" && <ArrowUp className="h-3 w-3" />}
                      {sortDir === "desc" && <ArrowDown className="h-3 w-3" />}
                      {!sortDir && <ArrowUpDown className="h-3 w-3 opacity-30" />}
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => {
                const numeric = ["quantity", "price", "session_net"].includes(cell.column.id);
                return (
                  <TableCell key={cell.id} className={cn(numeric && "text-right tabular-nums")}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    <footer className="scanner-pagination">
      <span>{table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1}-{Math.min((table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize, deals.length)} of {fmtQty.format(deals.length)} trades</span>
      <Select
        aria-label="Rows per page"
        value={table.getState().pagination.pageSize}
        onChange={(e) => table.setPageSize(Number(e.target.value))}
        className="w-[110px]"
      >
        {[25, 50, 100].map((count) => <option key={count} value={count}>{count} rows</option>)}
      </Select>
      <Button
        variant="outline"
        size="icon"
        aria-label="Previous deals page"
        title="Previous page"
        disabled={!table.getCanPreviousPage()}
        onClick={() => table.previousPage()}
      >
        <ChevronLeft size={16} />
      </Button>
      <span className="tabular-nums">{table.getState().pagination.pageIndex + 1} / {table.getPageCount()}</span>
      <Button
        variant="outline"
        size="icon"
        aria-label="Next deals page"
        title="Next page"
        disabled={!table.getCanNextPage()}
        onClick={() => table.nextPage()}
      >
        <ChevronRight size={16} />
      </Button>
    </footer>
    </div>
  );
}
