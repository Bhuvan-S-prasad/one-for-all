import {
  FAMILIAR_COLORS,
  FAMILIAR_EYES,
  FAMILIAR_FORMS,
  FAMILIAR_MARKS,
  FAMILIAR_SKINS,
  type FamiliarColor,
  type FamiliarLook,
  type FamiliarMood,
} from "@ofa/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Familiar } from "@/components/familiar";
import { gsap, ScrollTrigger, SplitText } from "@/lib/motion";
import { reducedMotion, REPO_URL } from "@/lib/site";
import { bySlug, CHIEF } from "@/lib/team";

// The first screen is a hatchery. The name stands huge, and the team sits on
// its letters. Every familiar's eyes follow you; click anywhere and a new one
// hatches where you clicked and drops to the floor. Scroll, and the words
// slide apart and the team flies off.

const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const COLORS = Object.keys(FAMILIAR_COLORS).filter((c) => c !== "ink") as FamiliarColor[];

function randomLook(): FamiliarLook {
  return {
    form: pick(FAMILIAR_FORMS),
    eyes: pick(FAMILIAR_EYES),
    skin: pick(FAMILIAR_SKINS),
    color: pick(COLORS),
    mark: pick(FAMILIAR_MARKS),
  };
}

/** The team, perched on the letters: positions in em of the headline. */
const PERCHED: readonly {
  look: FamiliarLook;
  mood: FamiliarMood;
  label: string;
  style: CSSProperties;
  line: 0 | 1;
}[] = [
  {
    look: CHIEF.look,
    mood: "idle",
    label: "Chief of staff",
    line: 0,
    style: { left: "0.08em", top: "-0.36em", width: "0.5em" },
  },
  {
    look: bySlug.get("researcher")!.look,
    mood: "thinking",
    label: "Researcher",
    line: 0,
    style: { left: "2.02em", top: "-0.46em", width: "0.42em" },
  },
  {
    look: bySlug.get("operator")!.look,
    mood: "working",
    label: "Operator",
    line: 1,
    style: { left: "0.56em", top: "-0.44em", width: "0.46em" },
  },
  {
    look: bySlug.get("inbox")!.look,
    mood: "waiting",
    label: "Gmail agent",
    line: 1,
    style: { left: "0.06em", top: "-0.2em", width: "0.36em" },
  },
  {
    look: bySlug.get("writer")!.look,
    mood: "idle",
    label: "Writer",
    line: 0,
    style: { left: "2.82em", top: "-0.24em", width: "0.38em" },
  },
];

interface Hatchling {
  readonly id: number;
  readonly look: FamiliarLook;
  readonly x: number;
  readonly y: number;
}

export function Hatchery({ ready }: { ready: boolean }) {
  const root = useRef<HTMLElement>(null);
  const [born, setBorn] = useState<Hatchling[]>([]);
  const next = useRef(0);

  // The opening: letters drop in, the team pops onto them, the rest rises.
  useEffect(() => {
    if (!ready || reducedMotion()) return;
    const ctx = gsap.context(() => {
      const split = SplitText.create("[data-word]", { type: "chars", charsClass: "inline-block" });
      gsap
        .timeline({ defaults: { ease: "hatch" } })
        .from(split.chars, {
          yPercent: 120,
          rotate: () => gsap.utils.random(-14, 14),
          autoAlpha: 0,
          duration: 1.1,
          stagger: 0.045,
        })
        .from(
          "[data-perched]",
          { scale: 0, transformOrigin: "50% 100%", duration: 0.9, stagger: 0.09 },
          0.55,
        )
        .from("[data-tagline]", { y: 40, autoAlpha: 0, duration: 1, ease: "silk" }, 0.85)
        .from(
          "[data-hero-foot]",
          { y: 30, autoAlpha: 0, duration: 1, stagger: 0.08, ease: "silk" },
          0.7,
        );

      // Each perched familiar sways on its own clock.
      gsap.utils.toArray<HTMLElement>("[data-perched]").forEach((el, i) => {
        gsap.to(el, {
          y: -10 - i * 2,
          rotate: i % 2 ? 4 : -4,
          duration: 1.6 + i * 0.25,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
          delay: 1.4,
        });
      });

      // Scrolling away: the words part, the team flies up at different speeds.
      const out = { trigger: root.current, start: "top top", end: "bottom top", scrub: 0.6 };
      gsap.to("[data-line='0']", { xPercent: -16, ease: "none", scrollTrigger: out });
      gsap.to("[data-line='1']", { xPercent: 16, ease: "none", scrollTrigger: out });
      gsap.utils.toArray<HTMLElement>("[data-perched-wrap]").forEach((el, i) => {
        gsap.to(el, { y: -200 - i * 90, ease: "none", scrollTrigger: out });
      });
      gsap.to("[data-hatchling]", { y: -260, autoAlpha: 0, ease: "none", scrollTrigger: out });
    }, root);
    ScrollTrigger.refresh();
    return () => ctx.revert();
  }, [ready]);

  // A new familiar drops to the floor and bounces.
  useEffect(() => {
    const last = born.at(-1);
    if (!last || reducedMotion()) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-id="${last.id}"]`);
    const floor = root.current?.querySelector<HTMLElement>("[data-floor]");
    if (!el || !floor) return;
    const box = root.current!.getBoundingClientRect();
    const fall = floor.getBoundingClientRect().top - box.top - last.y - 64;
    gsap
      .timeline()
      .from(el, {
        scale: 0,
        rotate: gsap.utils.random(-40, 40),
        duration: 0.55,
        ease: "back.out(3)",
      })
      .to(el, { y: Math.max(0, fall), duration: 0.9, ease: "bounce.out" }, 0.25)
      .to(el, { rotate: gsap.utils.random(-12, 12), duration: 0.9 }, 0.25);
  }, [born]);

  const hatch = (e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as Element).closest("a, button, input")) return;
    const box = root.current!.getBoundingClientRect();
    const id = next.current++;
    setBorn((list) => [
      ...list.slice(-17),
      { id, look: randomLook(), x: e.clientX - box.left - 36, y: e.clientY - box.top - 36 },
    ]);
  };

  return (
    <section
      ref={root}
      aria-label="One-for-All"
      onClick={hatch}
      className="relative flex min-h-svh flex-col overflow-hidden select-none"
    >
      <div className="gutter relative flex flex-1 flex-col justify-center pt-32 pb-10 md:pt-44">
        <h1
          aria-label="One for all."
          className="font-display text-[clamp(84px,19vw,330px)] leading-[0.8] font-extrabold tracking-[-0.06em]"
        >
          {(["One for", "all."] as const).map((text, line) => (
            <div
              key={text}
              data-line={line}
              className={`relative w-max ${line === 1 ? "mt-[0.06em] ml-auto" : ""}`}
            >
              <span data-word aria-hidden className="block overflow-visible">
                {text}
              </span>
              {PERCHED.filter((p) => p.line === line).map((p) => (
                <span
                  key={p.label}
                  data-perched-wrap
                  className="pointer-events-none absolute aspect-square"
                  style={p.style}
                >
                  <span data-perched className="block size-full">
                    <Familiar look={p.look} mood={p.mood} animate size="100%" label={p.label} />
                  </span>
                </span>
              ))}
            </div>
          ))}
        </h1>
        {/* The name, explained: one job each, all for you. */}
        <p
          data-tagline
          className="mt-[3vh] ml-auto w-fit text-right font-display text-[clamp(28px,3.8vw,64px)] leading-none font-extrabold tracking-[-0.04em] text-primary"
        >
          One job each. All for you.
        </p>
        <p
          data-hero-foot
          className="absolute bottom-[14%] left-[max(20px,env(safe-area-inset-left,0px))] hidden max-w-[24ch] text-[clamp(20px,1.7vw,28px)] leading-snug font-medium md:block md:left-[max(40px,env(safe-area-inset-left,0px))]"
        >
          A team of AI agents that lives on your own machine. Each one has a job, its own computer
          and a memory, and it asks you before anything leaves.
        </p>
      </div>

      {born.map((b) => (
        <span
          key={b.id}
          data-id={b.id}
          data-hatchling
          className="pointer-events-none absolute z-10 size-[72px]"
          style={{ left: b.x, top: b.y }}
        >
          <Familiar look={b.look} mood="idle" animate size={72} />
        </span>
      ))}

      <div
        data-floor
        className="gutter relative z-20 grid gap-8 pb-8 md:grid-cols-[1fr_auto] md:items-end"
      >
        <p data-hero-foot className="text-[clamp(17px,1.4vw,20px)] leading-relaxed md:hidden">
          A team of AI agents that lives on your own machine. Each one has a job, its own computer
          and a memory, and it asks you before anything leaves.
        </p>
        <p data-hero-foot className="hidden text-center text-[15px] text-muted-foreground md:block">
          {born.length
            ? `${born.length} hatched. Keep going.`
            : "Click anywhere to hatch a familiar"}
        </p>
        <div data-hero-foot className="flex items-center gap-3">
          <Link
            to="/docs"
            className="rounded-full px-4 py-3 text-[16px] underline-offset-4 hover:underline"
          >
            Read the docs
          </Link>
          <a
            href={REPO_URL}
            data-magnetic
            className="flex size-[124px] items-center justify-center rounded-full bg-primary text-center text-[16px] leading-tight font-semibold text-primary-foreground"
          >
            Clone it
            <br />
            on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
