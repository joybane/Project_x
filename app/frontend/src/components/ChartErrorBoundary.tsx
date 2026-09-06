import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  // When this changes, a previously-tripped boundary clears itself so the
  // next render gets a real shot instead of staying stuck on the error card.
  resetKey: string;
  onReset: () => void;
}

interface State {
  hasError: boolean;
}

// lightweight-charts has a real internal bug (not something in this app's
// own code) where panning through enough accumulated history can throw a
// "Value is null" deep in its own autoscale caching - reproduced with clean,
// deduped, gapless data. Several specific triggers for it are worked around
// upstream of this (capped initial load, debounced range changes, suppressed
// false edge-detection), but there is no way to be certain every path into
// that bug is closed. Without this boundary, an exception like that unwinds
// past React's root with nothing to catch it, unmounting the entire app and
// leaving a blank window - which is what was reported. This turns that into
// a recoverable card instead of a dead app.
export default class ChartErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Chart crashed and was caught by ChartErrorBoundary:", error);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card p-16 text-center">
          <p className="max-w-md text-sm text-muted-foreground">
            The chart hit an internal rendering error while updating and had to stop. Your data is fine - this is a bug in the charting
            library itself, usually triggered by panning through a lot of history quickly.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              this.props.onReset();
              this.setState({ hasError: false });
            }}
          >
            Reset chart
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
