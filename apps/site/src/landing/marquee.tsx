import { useEffect, useRef } from "react";
import { Familiar } from "@/components/familiar";
import { gsap, ScrollTrigger } from "@/lib/motion";
import { reducedMotion } from "@/lib/site";
import { TEAM, CHIEF } from "@/lib/team";

// Two bands that never stop: what it is built on, and the tools agents use.
// They run faster, and lean, with the speed of your scroll.

const STACK = [
  "Postgres",
  "Inngest",
  "Hono",
  "React",
  "MCP",
  "Docker",
  "Chromium",
  "OpenRouter",
  "Drizzle",
  "noVNC",
  "SearXNG",
  "OpenTelemetry",
];
const TOOLS = [
  "web.search",
  "delegate_task",
  "files.send",
  "gmail.create_draft",
  "shell.run",
  "remember",
  "schedule_task",
  "desktop.open",
  "run_skill",
  "browser.click",
];
const LOOKS = [CHIEF.look, ...TEAM.map((t) => t.look)];

function Band({
  words,
  mono,
  reverse,
}: {
  words: readonly string[];
  mono?: boolean;
  reverse?: boolean;
}) {
  const items = words.flatMap((w, i) => [
    <span key={`w${i}`} className={mono ? "font-mono" : "font-display"}>
      {w}
    </span>,
    <span key={`f${i}`} className="inline-block size-[0.8em] translate-y-[0.06em]">
      <Familiar look={LOOKS[i % LOOKS.length]!} size="100%" />
    </span>,
  ]);
  return (
    <div data-band data-reverse={reverse ? "1" : undefined} className="flex w-max">
      {[0, 1].map((copy) => (
        <div
          key={copy}
          aria-hidden={copy === 1}
          className="flex shrink-0 items-center gap-[0.4em] pr-[0.4em] whitespace-nowrap"
        >
          {items}
        </div>
      ))}
    </div>
  );
}

export function Marquee() {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (reducedMotion()) return;
    const ctx = gsap.context(() => {
      const loops = gsap.utils
        .toArray<HTMLElement>("[data-band]")
        .map((band) =>
          gsap.fromTo(
            band,
            { xPercent: band.dataset.reverse ? -50 : 0 },
            { xPercent: band.dataset.reverse ? 0 : -50, duration: 38, ease: "none", repeat: -1 },
          ),
        );
      const skew = gsap.quickTo("[data-band]", "skewX", { duration: 0.5, ease: "power3" });
      ScrollTrigger.create({
        trigger: root.current,
        start: "top bottom",
        end: "bottom top",
        onUpdate: (self) => {
          const v = self.getVelocity();
          const speed = 1 + Math.min(6, Math.abs(v) / 400);
          loops.forEach((l) => l.timeScale(v < 0 ? -speed : speed));
          skew(gsap.utils.clamp(-12, 12, v / -300));
        },
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section
      ref={root}
      aria-label="Built on"
      className="overflow-hidden py-[clamp(80px,12vh,140px)]"
    >
      <p className="sr-only">
        Built on {STACK.join(", ")}. Agents use tools like {TOOLS.join(", ")}.
      </p>
      <div aria-hidden className="flex flex-col gap-4">
        <div className="text-[clamp(56px,9vw,160px)] leading-none font-extrabold tracking-[-0.05em]">
          <Band words={STACK} />
        </div>
        <div className="text-[clamp(28px,4vw,64px)] leading-none text-muted-foreground">
          <Band words={TOOLS} mono reverse />
        </div>
      </div>
    </section>
  );
}
