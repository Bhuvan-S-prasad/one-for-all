// Diagrams written as fenced blocks in the pages (ADR-0051), drawn as React,
// never from HTML. `flow` and `layers` come from the site's docs; `sequence`
// shows messages between parts over time.

/** `Title | text` per line; a leading `!` marks the step that matters most. */
export function FlowDiagram({ text }: { text: string }) {
  const steps = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const strong = l.startsWith("!");
      const [title, ...rest] = (strong ? l.slice(1) : l).split("|");
      return { title: (title ?? "").trim(), text: rest.join("|").trim(), strong };
    });
  return (
    <ol className="my-8 flex flex-col" aria-label="Diagram">
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-4 pb-4 last:pb-0">
          {i < steps.length - 1 && (
            <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-[2px] bg-popover" />
          )}
          <span
            aria-hidden
            className={`relative z-10 mt-1 flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold tabular-nums ${
              s.strong ? "bg-primary text-primary-foreground" : "bg-popover text-foreground"
            }`}
          >
            {i + 1}
          </span>
          <div
            className={`flex min-w-0 flex-1 flex-col gap-1 rounded-[14px] px-4 py-2.5 ${
              s.strong ? "bg-primary/10" : "bg-card"
            }`}
          >
            <span className="font-semibold text-foreground">{s.title}</span>
            {s.text && <span className="text-[14.5px] text-muted-foreground">{s.text}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** `Name | what it owns | where` per line, drawn top to bottom. */
export function LayersDiagram({ text }: { text: string }) {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("|").map((c) => c.trim()));
  return (
    <div className="my-8 flex flex-col gap-1.5" role="list" aria-label="Diagram">
      {rows.map(([name, owns, where], i) => (
        <div
          key={i}
          role="listitem"
          className="grid gap-x-6 gap-y-1 rounded-[14px] px-4 py-3 sm:grid-cols-[190px_1fr]"
          style={{
            background: `color-mix(in oklab, var(--primary) ${Math.max(4, 22 - i * 2.2)}%, var(--card))`,
          }}
        >
          <span className="font-semibold text-foreground">{name}</span>
          <span className="text-[14.5px]">
            {owns}
            {where && (
              <code className="block font-mono text-[12.5px] text-muted-foreground">{where}</code>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

interface Message {
  readonly from: number;
  readonly to: number;
  readonly label: string;
  /** `-->`: a reply or something that comes back later. */
  readonly reply: boolean;
}

/**
 * `A -> B: what` per line (`-->` for a reply); parts appear left to right in
 * the order they are first named. `note: text` adds a line across the diagram.
 */
export function SequenceDiagram({ text }: { text: string }) {
  const parts: string[] = [];
  const rows: (Message | { note: string })[] = [];
  const indexOf = (name: string) => {
    const at = parts.indexOf(name);
    if (at >= 0) return at;
    parts.push(name);
    return parts.length - 1;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("note:")) {
      rows.push({ note: line.slice(5).trim() });
      continue;
    }
    const m = /^(.+?)\s*(-->|->)\s*(.+?)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ from: indexOf(m[1]!), to: indexOf(m[3]!), label: m[4]!, reply: m[2] === "-->" });
  }
  const width = 100 / parts.length;
  const center = (i: number) => `${(i + 0.5) * width}%`;
  return (
    <figure className="my-8 overflow-x-auto rounded-[16px] border border-border bg-card p-4">
      <div className="relative" style={{ minWidth: `${parts.length * 120}px` }}>
        {/* Lifelines behind everything. */}
        {parts.map((_, i) => (
          <span
            key={i}
            aria-hidden
            className="absolute top-10 bottom-0 w-px border-l border-dashed border-border"
            style={{ left: center(i) }}
          />
        ))}
        <div
          className="relative grid"
          style={{ gridTemplateColumns: `repeat(${parts.length}, 1fr)` }}
        >
          {parts.map((p) => (
            <span
              key={p}
              className="mx-1 rounded-[10px] bg-popover px-2 py-1.5 text-center text-[13px] font-semibold"
            >
              {p}
            </span>
          ))}
        </div>
        <ol className="relative mt-2 flex flex-col" aria-label="Messages, in order">
          {rows.map((r, i) => {
            if ("note" in r) {
              return (
                <li
                  key={i}
                  className="relative z-10 my-2 rounded-[10px] bg-primary/10 px-3 py-1.5 text-center text-[13px]"
                >
                  {r.note}
                </li>
              );
            }
            const left = Math.min(r.from, r.to);
            const right = Math.max(r.from, r.to);
            const self = r.from === r.to;
            const toRight = r.to >= r.from;
            return (
              <li key={i} className="relative h-12">
                <span className="sr-only">
                  {parts[r.from]} to {parts[r.to]}: {r.label}
                </span>
                {/* The whole label, from the arrow's left end; it may run past the arrow. */}
                <span
                  aria-hidden
                  className="absolute top-0.5 ml-1.5 rounded-[6px] bg-card px-1.5 text-[12.5px] whitespace-nowrap text-foreground"
                  style={{ left: center(left) }}
                >
                  <span className="mr-1 text-muted-foreground tabular-nums">{i + 1}.</span>
                  {r.label}
                </span>
                {!self && (
                  <span
                    aria-hidden
                    className={`absolute top-7 h-0 border-t-2 ${r.reply ? "border-dashed border-muted-foreground" : "border-primary"}`}
                    style={{ left: center(left), width: `${(right - left) * width}%` }}
                  >
                    <span
                      className={`absolute -top-[7px] size-0 border-y-[6px] border-y-transparent ${
                        toRight
                          ? `-right-0.5 border-l-[8px] ${r.reply ? "border-l-muted-foreground" : "border-l-primary"}`
                          : `-left-0.5 border-r-[8px] ${r.reply ? "border-r-muted-foreground" : "border-r-primary"}`
                      }`}
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </figure>
  );
}
