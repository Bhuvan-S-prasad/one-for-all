import { rankByRequest, rosterText } from "@ofa/core";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Familiar } from "@/components/familiar";
import { Flip } from "@/lib/motion";
import { reducedMotion } from "@/lib/site";
import { bySlug, CHIEF, coveredTools, members } from "@/lib/team";

// The live piece: type a request and watch the real routing code from
// @ofa/core rank the team for it, the way a coordinator's team block is
// built (ADR-0044). It runs here, in the browser, with no model call.

const EXAMPLES = [
  "Compare laptops and draft me an email",
  "Put this week's invoices in a spreadsheet",
  "Write the release announcement",
];

function wordsOf(request: string): Set<string> {
  return new Set(
    request
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );
}

export function Routing() {
  const [request, setRequestNow] = useState(EXAMPLES[0]!);
  // Reordering animates: the list's state is taken before each change and
  // played from after it renders.
  const flip = useRef<Flip.FlipState | null>(null);
  const setRequest = (value: string) => {
    flip.current = Flip.getState("[data-rank]");
    setRequestNow(value);
  };
  useLayoutEffect(() => {
    if (!flip.current || reducedMotion()) return;
    Flip.from(flip.current, { duration: 0.7, ease: "power3.inOut", absolute: false });
    flip.current = null;
  }, [request]);
  const ranked = useMemo(() => rankByRequest(members, request), [request]);
  const words = useMemo(() => wordsOf(request), [request]);
  const hidden = useMemo(() => coveredTools(), []);

  const matches = (slug: string) => {
    const m = members.find((x) => x.slug === slug);
    if (!m) return [];
    const about = [
      m.name,
      m.job,
      ...(m.capabilities ?? []).flatMap((c) => [c.area, ...c.abilities]),
    ]
      .join(" ")
      .toLowerCase();
    return [...words].filter((w) => about.includes(w));
  };

  return (
    <section aria-label="Routing a request" className="gutter py-[clamp(96px,13vh,168px)]">
      <div className="flex flex-col gap-4">
        <h2
          data-rise
          className="text-[clamp(56px,9vw,170px)] leading-[0.88] font-extrabold tracking-[-0.055em]"
        >
          Type a request.
          <br />
          <span className="text-muted-foreground">Watch it route.</span>
        </h2>
        <p data-rise className="max-w-[46ch] text-[18px] leading-relaxed">
          This is the routing code from the repository, running in your browser. It ranks the team
          by what each agent can do, from the tools it was granted. The chief of staff reads this
          list, and it no longer has the tools a teammate covers, so it has to hand the work on.
        </p>
      </div>

      <div data-rise className="mt-14">
        <label htmlFor="request" className="sr-only">
          A request for the chief of staff
        </label>
        <div data-ui className="flex items-baseline gap-1 overflow-hidden">
          <input
            id="request"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="w-full min-w-0 border-0 bg-transparent font-display text-[clamp(28px,4vw,68px)] leading-[1.05] font-bold tracking-[-0.035em] text-foreground caret-primary outline-none placeholder:text-muted-foreground"
            placeholder="Ask your team for something"
          />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setRequest(e)}
              className={`rounded-full px-4 py-2 text-[15px] transition-colors active:scale-[0.98] ${
                e === request
                  ? "bg-foreground text-background"
                  : "bg-card text-foreground hover:bg-popover"
              }`}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-14 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
        <ol data-rise className="flex flex-col gap-3">
          {ranked.map((m, i) => {
            const agent = bySlug.get(m.slug)!;
            const hits = matches(m.slug);
            return (
              <li
                key={m.slug}
                data-rank
                data-flip-id={m.slug}
                data-ui
                className={`flex items-start gap-4 rounded-[20px] px-4 py-4 transition-colors duration-300 ${
                  i === 0 && hits.length ? "bg-primary text-primary-foreground" : ""
                }`}
              >
                <Familiar
                  look={agent.look}
                  size={44}
                  mood={i === 0 && hits.length ? "working" : "idle"}
                  animate={i === 0 && hits.length > 0}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-[17px] font-semibold">{m.name}</span>
                    <span className="text-[14px] opacity-75">
                      {hits.length ? `matches ${hits.map((h) => `“${h}”`).join(", ")}` : "no match"}
                    </span>
                  </div>
                  <span className="text-[15px] opacity-80">{m.job}</span>
                </div>
              </li>
            );
          })}
        </ol>

        <div data-rise className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <p className="text-[15px] text-muted-foreground">
              What the chief of staff’s model reads, exactly:
            </p>
            <pre className="overflow-x-auto rounded-[20px] bg-card p-5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">
              <code>{rosterText(ranked)}</code>
            </pre>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Familiar look={CHIEF.look} size={36} />
              <p className="text-[15px]">Tools the chief of staff no longer sees:</p>
            </div>
            <ul className="flex flex-wrap gap-2">
              {hidden.map((h) => (
                <li
                  key={h.tool}
                  className="rounded-full bg-card px-3 py-1.5 text-[14px] text-muted-foreground"
                >
                  <code className="font-mono text-[13px] text-foreground">{h.tool}</code> · left to{" "}
                  {h.by}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
