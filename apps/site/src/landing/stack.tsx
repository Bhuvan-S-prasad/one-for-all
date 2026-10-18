import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { gsap } from "@/lib/motion";
import { reducedMotion } from "@/lib/site";
import {
  ContinueFragment,
  DesktopFragment,
  MachineFragment,
  MemoryFragment,
  RoutineFragment,
} from "./fragments";

// What every agent gets, as a deck of coloured cards: each one sticks at the
// top while the next slides over it, and the one beneath settles back.

const CARDS: readonly { title: string; text: string; bg: string; ink: string; ui: ReactNode }[] = [
  {
    title: "Its own computer",
    text: "A light desktop for every agent: browser, terminal, files, Python, Word and Excel. Watch it work, and take the mouse when a login needs you.",
    bg: "#3d5bff",
    ink: "#f4f4f0",
    ui: <DesktopFragment />,
  },
  {
    title: "Continue means continue",
    text: "A run that hits its budget answers with what it found. The next one reads the record and carries on, never redoing finished work.",
    bg: "#ff5b3a",
    ink: "#0e0e0f",
    ui: <ContinueFragment />,
  },
  {
    title: "Work on a clock",
    text: "Routines in your time zone. Quiet checks that only speak when something needs you. Reminders and tasks the agents set for themselves.",
    bg: "#6ef0c2",
    ink: "#0e0e0f",
    ui: <RoutineFragment />,
  },
  {
    title: "A memory you can read",
    text: "Facts, an episode of every task, and skills. What it learns from outside waits for you to keep or forget.",
    bg: "#b7a6ff",
    ink: "#0e0e0f",
    ui: <MemoryFragment />,
  },
  {
    title: "It lives at home",
    text: "One Docker bundle on your machine, reachable only from it. Credentials are opened only at the moment a tool runs; no model ever sees them.",
    bg: "#ffc93a",
    ink: "#0e0e0f",
    ui: <MachineFragment />,
  },
];

export function Stack() {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (reducedMotion()) return;
    const ctx = gsap.context(() => {
      const cards = gsap.utils.toArray<HTMLElement>("[data-card]");
      cards.forEach((card, i) => {
        const next = cards[i + 1];
        if (!next) return;
        gsap.to(card, {
          scale: 0.9,
          yPercent: -4,
          rotate: i % 2 ? 1.5 : -1.5,
          ease: "none",
          scrollTrigger: { trigger: next, start: "top bottom", end: "top 8%", scrub: true },
        });
        gsap.to(card.querySelector("[data-shade]"), {
          opacity: 0.5,
          ease: "none",
          scrollTrigger: { trigger: next, start: "top bottom", end: "top 8%", scrub: true },
        });
      });
      cards.forEach((card) => {
        gsap.from(card.querySelectorAll("[data-card-part]"), {
          y: 60,
          autoAlpha: 0,
          stagger: 0.1,
          duration: 1,
          ease: "silk",
          scrollTrigger: { trigger: card, start: "top 60%" },
        });
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={root} aria-label="What every agent gets" className="gutter pb-[12vh]">
      <h2 className="py-[clamp(96px,16vh,200px)] text-[clamp(56px,9vw,170px)] leading-[0.88] font-extrabold tracking-[-0.055em]">
        Real work,
        <br />
        on your terms.
      </h2>
      <div className="flex flex-col gap-[6vh]">
        {CARDS.map((c, i) => (
          <article
            key={c.title}
            data-card
            className="sticky grid min-h-[78svh] origin-top items-center gap-10 rounded-[32px] p-[clamp(24px,4vw,64px)] will-change-transform lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
            style={{ background: c.bg, color: c.ink, top: `calc(6svh + ${i * 14}px)` }}
          >
            <div
              aria-hidden
              data-shade
              className="pointer-events-none absolute inset-0 rounded-[32px] bg-black opacity-0"
            />
            <div className="flex flex-col gap-6">
              <h3
                data-card-part
                className="max-w-[8em] text-[clamp(44px,6vw,108px)] leading-[0.9] font-extrabold tracking-[-0.05em]"
              >
                {c.title}
              </h3>
              <p
                data-card-part
                className="max-w-[34ch] text-[clamp(17px,1.4vw,20px)] leading-relaxed"
              >
                {c.text}
              </p>
            </div>
            <div data-card-part className="mx-auto w-full max-w-[460px] scale-[1.06]">
              {c.ui}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
