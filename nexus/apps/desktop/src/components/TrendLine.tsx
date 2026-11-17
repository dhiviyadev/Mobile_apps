import { DOWN, UP } from "./PriceChart";

/** A tiny trend line of recent closes: blue if the period ended higher than it began, red if lower. */
export function TrendLine({ values, width = 64, height = 22, label }: { values: number[]; width?: number; height?: number; label?: string }) {
  if (values.length < 2) return <span style={{ width, height }} className="inline-block" />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`);
  const up = values[values.length - 1]! >= values[0]!;
  const pct = ((values[values.length - 1]! / values[0]! - 1) * 100).toFixed(1);
  return (
    <svg width={width} height={height} role="img" aria-label={`${label ?? "Trend"}: ${up ? "up" : "down"} ${Math.abs(Number(pct))}% over ${values.length} sessions`} className="flex-none">
      <title>{`${values.length} sessions: ${up ? "+" : ""}${pct}%`}</title>
      <polyline points={pts.join(" ")} fill="none" stroke={up ? UP : DOWN} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
