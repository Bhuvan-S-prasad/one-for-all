import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Familiar } from "@/components/familiar";
import { gsap } from "@/lib/motion";
import { reducedMotion, REPO_URL } from "@/lib/site";
import { CHIEF, TEAM } from "@/lib/team";

// The close: a lime field, the whole team climbing up from behind the name,
// and a spinning seal that takes you to the code.

// The chief is lime like this field, so the close shows it in ink.
const LOOKS = [
  TEAM[0]!.look,
  { ...CHIEF.look, color: "ink" as const },
  TEAM[1]!.look,
  TEAM[2]!.look,
  TEAM[3]!.look,
];

function Seal() {
  return (
    <a
      href={REPO_URL}
      data-magnetic
      aria-label="Clone the repository on GitHub"
      className="relative flex size-[clamp(150px,15vw,220px)] shrink-0 items-center justify-center rounded-full bg-[#0e0e0f] text-primary"
    >
      <svg data-seal viewBox="0 0 200 200" className="absolute inset-0 size-full" aria-hidden>
        <defs>
          <path id="seal-ring" d="M100,100 m-74,0 a74,74 0 1,1 148,0 a74,74 0 1,1 -148,0" />
        </defs>
        <text fill="currentColor" fontSize="18" fontWeight="700" letterSpacing="4">
          <textPath href="#seal-ring">CLONE IT · RUN IT · OWN IT ·</textPath>
        </text>
      </svg>
      <svg viewBox="0 0 24 24" className="size-10" aria-hidden>
        <path
          d="M6 18 18 6M9 6h9v9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </a>
  );
}

export function Finale() {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (reducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.to("[data-seal]", {
        rotate: 360,
        duration: 14,
        ease: "none",
        repeat: -1,
        transformOrigin: "50% 50%",
      });
      gsap.from("[data-climber]", {
        yPercent: 110,
        stagger: 0.08,
        duration: 1.1,
        ease: "back.out(1.6)",
        scrollTrigger: { trigger: "[data-big]", start: "top 85%" },
      });
      gsap.from("[data-big] span", {
        yPercent: 100,
        stagger: 0.05,
        duration: 1.1,
        ease: "silk",
        scrollTrigger: { trigger: "[data-big]", start: "top 90%" },
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <footer ref={root} className="relative overflow-hidden bg-primary text-primary-foreground">
      <div className="gutter flex min-h-svh flex-col justify-between gap-12 pt-[clamp(80px,12vh,140px)] pb-8">
        <div className="flex flex-col items-start justify-between gap-10 md:flex-row md:items-end">
          <h2 className="max-w-[10em] text-[clamp(48px,7vw,128px)] leading-[0.9] font-extrabold tracking-[-0.05em]">
            Hatch a team that works while you’re away.
          </h2>
          <Seal />
        </div>

        <div className="relative">
          <div className="pointer-events-none absolute inset-x-0 bottom-[78%] flex justify-around px-[4%]">
            {LOOKS.map((look, i) => (
              <span key={i} data-climber className="block w-[clamp(64px,9vw,150px)]">
                <Familiar look={look} mood={i === 1 ? "working" : "idle"} animate size="100%" />
              </span>
            ))}
          </div>
          <p
            data-big
            aria-label="One for all."
            className="relative overflow-hidden font-display text-[clamp(64px,19.6vw,400px)] leading-[0.82] font-extrabold tracking-[-0.065em] whitespace-nowrap"
          >
            {"One for all.".split("").map((ch, i) => (
              <span key={i} aria-hidden className="inline-block">
                {ch === " " ? " " : ch}
              </span>
            ))}
          </p>
        </div>

        <div className="flex flex-col gap-3 text-[15px] md:flex-row md:items-center md:justify-between">
          <a href={REPO_URL} className="font-semibold underline-offset-4 hover:underline">
            GitHub
          </a>
          <span className="flex gap-6">
            <Link to="/docs" className="underline-offset-4 hover:underline">
              Docs
            </Link>
            <Link to="/docs/decisions" className="underline-offset-4 hover:underline">
              Decisions
            </Link>
            <Link
              to="/docs/$page"
              params={{ page: "architecture" }}
              className="underline-offset-4 hover:underline"
            >
              Architecture
            </Link>
          </span>
          <span>Self-hosted. Your key, your machine. 2026</span>
        </div>
      </div>
    </footer>
  );
}
