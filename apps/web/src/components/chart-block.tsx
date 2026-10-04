import { parseChartSpec, type ChartSpec } from "@ofa/contracts";
import { useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

// A ```chart block in a reply (UX.16): the spec is checked against
// `chartSpecSchema` and drawn as SVG. Values are printed, series have a legend
// and direct labels, and a table view is one click away, so nothing depends on
// colour alone. An invalid spec is shown as its text.

const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
const W = 640;
const H = 240;
const PAD = { top: 22, right: 16, bottom: 30, left: 44 };

/** 0, and a round number at or above the largest value, with 4 steps. */
function niceScale(min: number, max: number): { lo: number; hi: number; ticks: number[] } {
  const lo = Math.min(0, min);
  const span = Math.max(max, 0) - lo || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const hi = Math.ceil(Math.max(max, 0) / step) * step || step;
  const ticks: number[] = [];
  for (let t = start; t <= hi + step / 2; t += step) ticks.push(Number(t.toPrecision(10)));
  return { lo: start, hi, ticks };
}

function format(value: number, unit?: string): string {
  const text =
    Math.abs(value) >= 10_000
      ? value.toLocaleString(undefined, { notation: "compact" })
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit ? (unit === "%" ? `${text}%` : `${text} ${unit}`) : text;
}

export function ChartBlock({ text, fallback }: { text: string; fallback: React.ReactNode }) {
  const spec = useMemo(() => parseChartSpec(text), [text]);
  const [view, setView] = useState<"chart" | "table">("chart");
  const id = useId();
  if (!spec) return <>{fallback}</>;
  return (
    <figure
      className="flex w-[560px] max-w-full flex-col gap-3 rounded-[16px] border bg-card px-4 py-3.5"
      aria-labelledby={`${id}-title`}
    >
      <div className="flex items-center justify-between gap-3">
        <figcaption id={`${id}-title`} className="text-[14.5px] font-semibold">
          {spec.title ?? (spec.type === "bar" ? "Chart" : "Trend")}
        </figcaption>
        <div
          role="group"
          aria-label="View"
          className="flex gap-0.5 rounded-full border p-0.5 text-[12px]"
        >
          {(["chart", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn(
                "h-7 rounded-full px-2.5 font-semibold capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === v
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      {spec.series.length > 1 && (
        <ul
          className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground"
          aria-label="Series"
        >
          {spec.series.map((s, i) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 rounded-[3px]"
                style={{ background: SERIES[i] }}
              />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      {view === "chart" ? <ChartSvg spec={spec} /> : <ChartTable spec={spec} />}
    </figure>
  );
}

function ChartTable({ spec }: { spec: ChartSpec }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="py-1.5 pr-4 font-semibold">
              {" "}
            </th>
            {spec.series.map((s) => (
              <th key={s.name} scope="col" className="py-1.5 pr-4 text-right font-semibold">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.labels.map((label, i) => (
            <tr key={`${label}-${i}`} className="border-b last:border-b-0">
              <th scope="row" className="py-1.5 pr-4 font-normal">
                {label}
              </th>
              {spec.series.map((s) => (
                <td key={s.name} className="py-1.5 pr-4 text-right font-mono tabular-nums">
                  {format(s.values[i] ?? 0, spec.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartSvg({ spec }: { spec: ChartSpec }) {
  const [hover, setHover] = useState<number | null>(null);
  const all = spec.series.flatMap((s) => s.values);
  const { lo, hi, ticks } = niceScale(Math.min(...all), Math.max(...all));
  const n = spec.labels.length;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const band = plotW / n;
  const cx = (i: number) => PAD.left + band * i + band / 2;
  // Print every value while it stays readable; otherwise the tooltip and table carry them.
  const printAll = n * spec.series.length <= 16;
  const labelEvery = Math.ceil(n / 10);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label={`${spec.type === "bar" ? "Bar" : "Line"} chart: ${spec.series.map((s) => s.name).join(", ")} across ${n} points. Values are in the table view.`}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t) + 4}
              textAnchor="end"
              className="fill-muted-foreground font-mono text-[12px]"
            >
              {format(t)}
            </text>
          </g>
        ))}
        {spec.labels.map((label, i) =>
          i % labelEvery === 0 ? (
            <text
              key={`${label}-${i}`}
              x={cx(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-muted-foreground text-[12px]"
            >
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </text>
          ) : null,
        )}

        {spec.type === "bar"
          ? spec.series.map((s, si) => {
              const groupW = Math.min(band * 0.72, 28 * spec.series.length);
              const barW = groupW / spec.series.length - 2;
              return s.values.map((v, i) => {
                const x = cx(i) - groupW / 2 + si * (barW + 2);
                const top = Math.min(y(v), y(0));
                const height = Math.max(1, Math.abs(y(v) - y(0)));
                return (
                  <g key={`${si}-${i}`}>
                    <rect
                      x={x}
                      y={top}
                      width={Math.max(2, barW)}
                      height={height}
                      rx={Math.min(4, barW / 2)}
                      fill={SERIES[si]}
                      opacity={hover === null || hover === i ? 1 : 0.45}
                    />
                    {(printAll || hover === i) && (
                      <text
                        x={x + barW / 2}
                        y={v >= 0 ? top - 5 : top + height + 12}
                        textAnchor="middle"
                        className="fill-foreground font-mono text-[12px]"
                      >
                        {format(v)}
                      </text>
                    )}
                  </g>
                );
              });
            })
          : spec.series.map((s, si) => {
              const d = s.values.map((v, i) => `${i ? "L" : "M"}${cx(i)},${y(v)}`).join(" ");
              const last = s.values.length - 1;
              return (
                <g key={si}>
                  <path
                    d={d}
                    fill="none"
                    stroke={SERIES[si]}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {s.values.map((v, i) => (
                    <circle
                      key={i}
                      cx={cx(i)}
                      cy={y(v)}
                      r={4}
                      fill={SERIES[si]}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  ))}
                  {(printAll
                    ? s.values.map((v, i) => ({ v, i }))
                    : [{ v: s.values[last] ?? 0, i: last }]
                  ).map(({ v, i }) => (
                    <text
                      key={i}
                      x={cx(i)}
                      y={y(v) - 9}
                      textAnchor="middle"
                      className="fill-foreground font-mono text-[12px]"
                    >
                      {format(v)}
                    </text>
                  ))}
                </g>
              );
            })}

        {hover !== null && spec.type === "line" && (
          <line
            x1={cx(hover)}
            x2={cx(hover)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="var(--muted-foreground)"
            strokeDasharray="3 3"
          />
        )}
        {/* Hit areas a whole column wide, bigger than the marks. */}
        {spec.labels.map((label, i) => (
          <rect
            key={`hit-${i}`}
            x={PAD.left + band * i}
            y={PAD.top}
            width={band}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          >
            <title>{`${label}: ${spec.series.map((s) => `${s.name} ${format(s.values[i] ?? 0, spec.unit)}`).join(", ")}`}</title>
          </rect>
        ))}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 rounded-[10px] border bg-popover px-2.5 py-1.5 text-[12px] shadow-lg"
          style={{
            left: `${(cx(hover) / W) * 100}%`,
            transform: `translateX(${hover > n / 2 ? "-105%" : "5%"})`,
          }}
        >
          <div className="font-semibold">{spec.labels[hover]}</div>
          {spec.series.map((s, i) => (
            <div key={s.name} className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="size-2 rounded-[2px]"
                style={{ background: SERIES[i] }}
              />
              {s.name}{" "}
              <span className="ml-auto pl-2 font-mono text-foreground">
                {format(s.values[hover] ?? 0, spec.unit)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
