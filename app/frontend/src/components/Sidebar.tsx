import { useState } from "react";
import { CandlestickChart, ListFilter, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export type Tab = "stock" | "deals";

const NAV_ITEMS: { tab: Tab; label: string; icon: typeof CandlestickChart }[] = [
  { tab: "stock", label: "Stock", icon: CandlestickChart },
  { tab: "deals", label: "Deals Screener", icon: ListFilter },
];

export default function Sidebar({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "workspace-sidebar flex shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150 ease-in-out",
        collapsed ? "w-14" : "w-56"
      )}
    >
      <div className={cn("flex h-14 items-center border-b border-border", collapsed ? "justify-center px-0" : "gap-2 px-4")}>
        {!collapsed && (
          <>
            <div className="flex h-6 w-6 items-center justify-center rounded bg-primary text-xs font-bold text-primary-foreground">
              X
            </div>
            <span className="text-sm font-semibold tracking-tight">project_x</span>
          </>
        )}
        {collapsed && (
          <div className="flex h-6 w-6 items-center justify-center rounded bg-primary text-xs font-bold text-primary-foreground">
            X
          </div>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {NAV_ITEMS.map(({ tab: itemTab, label, icon: Icon }) => {
          const active = tab === itemTab;
          return (
            <button
              key={itemTab}
              title={collapsed ? label : undefined}
              onClick={() => onChange(itemTab)}
              className={cn(
                "flex items-center gap-2.5 rounded-md py-2 text-left text-sm font-medium transition-colors",
                collapsed ? "justify-center px-0" : "px-3",
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
              {!collapsed && label}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-border p-2">
        <button
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((c) => !c)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            collapsed ? "justify-center px-0" : "px-3"
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4 shrink-0" strokeWidth={2} />
          ) : (
            <>
              <PanelLeftClose className="h-4 w-4 shrink-0" strokeWidth={2} />
              Collapse
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
