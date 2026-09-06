import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, CheckCircle2, XCircle, Loader2, Circle } from "lucide-react";
import { fetchUpdateStatus, triggerUpdate, type UpdateStepResult } from "@/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STEP_LABELS: Record<string, string> = {
  nse_price_volume: "NSE Price/Volume",
  nse_delivery: "NSE Delivery",
  nse_bulk_deals: "NSE Bulk Deals",
  nse_block_deals: "NSE Block Deals",
  nse_short_selling: "NSE Short Selling",
  bse_price_volume: "BSE Price/Volume",
  bse_delivery: "BSE Delivery",
  bse_block_deals: "BSE Block Deals",
  bse_index_sensex: "BSE Sensex Index",
  bse_reference: "BSE Reference Catalog",
};

function StepIcon({ status }: { status: UpdateStepResult["status"] }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-danger" />;
    case "running":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground opacity-40" />;
  }
}

export default function UpdateMarketButton() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ["update-status"],
    queryFn: fetchUpdateStatus,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1200 : false),
  });

  const running = statusQuery.data?.status === "running";
  const order = statusQuery.data?.order ?? Object.keys(STEP_LABELS);

  const handleClick = async () => {
    setOpen(true);
    if (running) return;
    await triggerUpdate();
    queryClient.invalidateQueries({ queryKey: ["update-status"] });
    statusQuery.refetch();
  };

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={handleClick}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      >
        <RefreshCw className={cn("h-3.5 w-3.5", running && "animate-spin")} />
        {running ? `Updating… ${statusQuery.data?.percent ?? 0}%` : "Update Market Data"}
      </Button>

      {open && statusQuery.data && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-border bg-popover py-2 shadow-lg">
          <div className="flex items-center justify-between px-3 pb-2 text-xs font-medium text-muted-foreground">
            <span>{statusQuery.data.message}</span>
            {!running && (
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                ✕
              </button>
            )}
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {order.map((id) => {
              const step = statusQuery.data!.steps[id] ?? { status: "pending" as const };
              return (
                <li key={id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <StepIcon status={step.status} />
                  <span className="flex-1">{STEP_LABELS[id] ?? id}</span>
                  {step.status === "done" && step.rowsAdded !== undefined && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {step.rowsAdded > 0 ? `+${step.rowsAdded.toLocaleString("en-IN")}` : "up to date"}
                    </span>
                  )}
                  {step.status === "failed" && (
                    <span className="max-w-32 truncate text-xs text-danger" title={step.error}>
                      {step.error}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
