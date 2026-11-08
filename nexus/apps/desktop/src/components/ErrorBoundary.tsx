import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "@/lib/errors";

interface Props {
  children: ReactNode;
  area: string;
}
interface State {
  error: Error | null;
}

/** Shows a readable error card instead of a blank screen, and records it in the core's log. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(error, `${this.props.area}${info.componentStack ? `\n${info.componentStack.slice(0, 1500)}` : ""}`);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="surface-elevated silver-edge max-w-[640px] p-6">
          <p className="text-[15px] font-semibold text-fg">This page hit an error</p>
          <p className="mt-1 text-[12.5px] text-fg-2">
            It has been written to <span className="font-mono">data/logs/core.log</span>. A screenshot of this box is enough to diagnose it.
          </p>
          <pre className="selectable mt-4 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-xl bg-black/30 p-3 font-mono text-[11.5px] text-danger">
            {`${this.props.area}: ${error.name}: ${error.message}\n${(error.stack ?? "").split("\n").slice(0, 8).join("\n")}`}
          </pre>
          <div className="mt-4 flex gap-2">
            <button className="btn-liquid press h-8 rounded-full px-4 text-[12.5px] font-medium" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="press h-8 rounded-full border border-white/10 px-4 text-[12.5px] text-fg-2" onClick={() => window.location.reload()}>
              Reload NEXUS
            </button>
          </div>
        </div>
      </div>
    );
  }
}
