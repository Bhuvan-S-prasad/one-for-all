import type { FamiliarLook, FamiliarMood } from "@ofa/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Familiar } from "@/components/familiar";
import { gsap, ScrollTrigger } from "@/lib/motion";
import { reducedMotion } from "@/lib/site";
import { bySlug, CHIEF } from "@/lib/team";
import { DraftCard, PlanFragment, RoutineFragment } from "./fragments";

// A day with the team, scrolled sideways: the page pins, the day slides past
// scene by scene, and a clock the size of the screen keeps the time. Each
// scene is a field of its own colour. On a phone the scenes stack.

const researcher = bySlug.get("researcher")!.look;
const operator = bySlug.get("operator")!.look;
const inbox = bySlug.get("inbox")!.look;
const writer = bySlug.get("writer")!.look;

interface Scene {
  readonly time: string;
  readonly title: string;
  readonly text: string;
  readonly bg: string;
  readonly ink: string;
  readonly soft: string;
  readonly art: ReactNode;
  /** Art that is already as wide as its half of the scene isn't enlarged. */
  readonly fullSize?: boolean;
}

function Fam({ look, mood, size }: { look: FamiliarLook; mood: FamiliarMood; size: number }) {
  return <Familiar look={look} mood={mood} animate size={size} />;
}

/** The chief hands two pieces of work out: lines draw from it to each teammate. */
function HandoffArt() {
  return (
    <div className="relative aspect-[5/4] w-full max-w-[560px]" data-scene-art>
      <svg
        viewBox="0 0 500 400"
        className="absolute inset-0 size-full overflow-visible"
        aria-hidden
      >
        <path
          data-draw
          d="M120 200 C 250 200, 260 90, 390 90"
          fill="none"
          stroke="#f4f4f0"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          data-draw
          d="M120 200 C 250 200, 260 310, 390 310"
          fill="none"
          stroke="#f4f4f0"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute top-1/2 left-[2%] w-[26%] -translate-y-1/2">
        <Familiar look={CHIEF.look} mood="thinking" animate size="100%" />
      </div>
      <div
        data-arrive
        className="absolute top-[5%] right-0 flex w-[34%] flex-col items-center gap-2"
      >
        <span className="block w-[62%]">
          <Familiar look={researcher} mood="working" animate size="100%" />
        </span>
        <span className="rounded-full bg-[#f4f4f0] px-3 py-1 text-[12px] font-semibold whitespace-nowrap text-[#0e0e0f] sm:text-[13px]">
          Researcher · laptops
        </span>
      </div>
      <div
        data-arrive
        className="absolute right-0 bottom-[2%] flex w-[34%] flex-col items-center gap-2"
      >
        <span className="block w-[62%]">
          <Familiar look={operator} mood="working" animate size="100%" />
        </span>
        <span className="rounded-full bg-[#f4f4f0] px-3 py-1 text-[12px] font-semibold whitespace-nowrap text-[#0e0e0f] sm:text-[13px]">
          Operator · report
        </span>
      </div>
    </div>
  );
}

const SCENES: readonly Scene[] = [
  {
    time: "07:30",
    title: "Before you wake, a routine runs.",
    text: "The inbox agent sweeps your mail on a schedule, in your time zone, and posts only what needs you.",
    bg: "#161618",
    ink: "#f4f4f0",
    soft: "#a8a8ad",
    art: (
      <div className="flex w-full max-w-[460px] flex-col items-start gap-6">
        <div data-arrive>
          <Fam look={inbox} mood="working" size={130} />
        </div>
        <div data-arrive className="w-full">
          <RoutineFragment />
        </div>
      </div>
    ),
  },
  {
    time: "09:12",
    title: "You ask, in plain words.",
    text: "One message to your chief of staff. No prompt engineering, no picking tools.",
    bg: "#0e0e0f",
    ink: "#f4f4f0",
    soft: "#a8a8ad",
    art: (
      <div className="flex w-full max-w-[560px] flex-col gap-5">
        <p
          data-arrive
          className="self-end rounded-[36px_36px_8px_36px] bg-primary px-7 py-5 font-display text-[clamp(22px,2.2vw,34px)] leading-tight font-bold text-primary-foreground"
        >
          Find me a work laptop under $1,200 and leave a recommendation in my drafts.
        </p>
        <div data-arrive className="flex items-center gap-3 text-[16px] text-[#a8a8ad]">
          <Fam look={CHIEF.look} mood="thinking" size={56} /> Chief of staff is planning…
        </div>
      </div>
    ),
  },
  {
    time: "09:13",
    title: "The chief makes a plan.",
    text: "Every item gets an owner, chosen by what each agent can actually do.",
    bg: "#6ef0c2",
    ink: "#0e0e0f",
    soft: "#1f4d3c",
    art: (
      <div data-arrive className="w-full max-w-[470px]">
        <PlanFragment />
      </div>
    ),
  },
  {
    time: "09:14",
    title: "It hands the work out.",
    text: "Each teammate gets a brief, works on its own, and reports back. Several at once.",
    bg: "#3d5bff",
    ink: "#f4f4f0",
    soft: "#ffffff",
    art: <HandoffArt />,
  },
  {
    time: "09:31",
    title: "Then it waits for you.",
    text: "It read pages from the web, so the draft waits for your answer. Edit it, approve it, or say no.",
    bg: "#d4ff3a",
    ink: "#0e0e0f",
    soft: "#3f5c00",
    art: (
      <div data-arrive className="w-full max-w-[440px] lg:rotate-[-2deg]">
        <DraftCard />
      </div>
    ),
  },
  {
    time: "23:00",
    title: "At night, it tidies its memory.",
    text: "Duplicates merge, stale facts expire, and good habits become skills for you to approve.",
    bg: "#0b0b12",
    ink: "#f4f4f0",
    soft: "#a8a8ad",
    fullSize: true,
    art: (
      <div className="flex flex-wrap items-end gap-6">
        {[CHIEF.look, researcher, operator, inbox, writer].map((look, i) => (
          <div key={i} data-arrive>
            <Fam look={look} mood="asleep" size={i === 0 ? 140 : 96} />
          </div>
        ))}
      </div>
    ),
  },
];

function SceneView({ scene, showTime }: { scene: Scene; showTime: boolean }) {
  return (
    <div
      data-scene
      className="gutter relative flex min-h-svh w-full shrink-0 flex-col justify-center gap-10 overflow-hidden pt-32 pb-20 lg:grid lg:w-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-16 lg:py-0"
      style={{ background: scene.bg, color: scene.ink }}
    >
      <div className="flex flex-col gap-5 lg:pt-[18vh]">
        {showTime && (
          <span className="font-display text-[clamp(72px,18vw,140px)] leading-none font-extrabold tracking-[-0.05em] tabular-nums">
            {scene.time}
          </span>
        )}
        <h3
          data-arrive
          className="max-w-[9em] text-[clamp(40px,6vw,116px)] leading-[0.92] font-extrabold tracking-[-0.05em]"
        >
          {scene.title}
        </h3>
        <p
          data-arrive
          className="max-w-[34ch] text-[clamp(17px,1.4vw,21px)] leading-relaxed"
          style={{ color: scene.soft }}
        >
          {scene.text}
        </p>
      </div>
      <div
        className={`flex w-full min-w-0 items-center justify-center lg:pt-[10vh] ${scene.fullSize ? "" : "lg:[&>*]:scale-[1.35]"}`}
      >
        {scene.art}
      </div>
    </div>
  );
}

export function Day() {
  const root = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const [wide] = useState(
    () => !reducedMotion() && window.matchMedia("(min-width: 1024px)").matches,
  );

  useEffect(() => {
    if (reducedMotion()) return;
    const ctx = gsap.context(() => {
      if (!wide) {
        // Phones: each scene's parts rise as it arrives.
        gsap.utils.toArray<HTMLElement>("[data-scene]").forEach((scene) => {
          gsap.from(scene.querySelectorAll("[data-arrive]"), {
            y: 50,
            autoAlpha: 0,
            stagger: 0.1,
            duration: 1,
            ease: "silk",
            scrollTrigger: { trigger: scene, start: "top 70%" },
          });
        });
        return;
      }
      const el = track.current!;
      // Exactly to the last scene's left edge: scaled art inside a scene can
      // overflow it, and scrollWidth would then slide past the end.
      const last = el.lastElementChild as HTMLElement;
      const distance = () => last.offsetLeft;
      let shown = -1;
      const slide = gsap.to(el, {
        x: () => -distance(),
        ease: "none",
        scrollTrigger: {
          trigger: root.current,
          pin: true,
          scrub: 0.8,
          anticipatePin: 1,
          end: () => `+=${distance()}`,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            const i = Math.round(self.progress * (SCENES.length - 1));
            if (i === shown || !clock.current) return;
            shown = i;
            const scene = SCENES[i]!;
            gsap.to(clock.current, {
              duration: 0.6,
              scrambleText: { text: scene.time, chars: "0123456789", speed: 0.6 },
              color: scene.ink,
            });
          },
        },
      });

      gsap.utils.toArray<HTMLElement>("[data-scene]").forEach((scene) => {
        gsap.from(scene.querySelectorAll("[data-arrive]"), {
          x: 140,
          autoAlpha: 0,
          rotate: 3,
          stagger: 0.08,
          duration: 1,
          ease: "silk",
          scrollTrigger: {
            trigger: scene,
            containerAnimation: slide,
            start: "left 70%",
            toggleActions: "play none none reverse",
          },
        });
        scene.querySelectorAll<SVGPathElement>("[data-draw]").forEach((path) => {
          gsap.from(path, {
            drawSVG: "0%",
            ease: "none",
            scrollTrigger: {
              trigger: scene,
              containerAnimation: slide,
              start: "left 55%",
              end: "left 5%",
              scrub: true,
            },
          });
        });
      });
    }, root);
    ScrollTrigger.refresh();
    return () => ctx.revert();
  }, [wide]);

  return (
    <section
      ref={root}
      id="day"
      aria-label="A day with your team"
      className="relative overflow-hidden"
    >
      {wide && (
        <span
          ref={clock}
          aria-hidden
          className="gutter pointer-events-none absolute top-[7vh] left-0 z-10 font-display text-[clamp(96px,13vw,240px)] leading-none font-extrabold tracking-[-0.055em] text-[#f4f4f0] tabular-nums"
        >
          {SCENES[0]!.time}
        </span>
      )}
      <div ref={track} className={wide ? "flex w-max" : "flex flex-col"}>
        {SCENES.map((s) => (
          <SceneView key={s.time} scene={s} showTime={!wide} />
        ))}
      </div>
    </section>
  );
}
