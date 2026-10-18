import { useEffect, useRef, useState } from "react";
import { Spark } from "@/components/wordmark";
import { gsap, stopScroll } from "@/lib/motion";
import { reducedMotion } from "@/lib/site";

// The opening: the spark turns while a count runs to 100, then the curtain
// lifts. Once per visit; never under reduced motion.

const SEEN = "ofa-intro-seen";

function seenBefore(): boolean {
  // Automated browsers (screenshots, checks) skip the opening.
  if (navigator.webdriver) return true;
  try {
    return sessionStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}

export function Preloader({ onDone }: { onDone: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const count = useRef<HTMLSpanElement>(null);
  const [gone, setGone] = useState(() => reducedMotion() || seenBefore());

  useEffect(() => {
    if (gone) {
      onDone();
      return;
    }
    stopScroll(true);
    const n = { v: 0 };
    const ctx = gsap.context(() => {
      gsap
        .timeline({
          onComplete: () => {
            try {
              sessionStorage.setItem(SEEN, "1");
            } catch {
              // A private window: the opening plays again next time.
            }
            stopScroll(false);
            setGone(true);
          },
        })
        .to("[data-spark]", { rotate: 360, scale: 1.25, duration: 1.4, ease: "power2.inOut" }, 0)
        .to(
          n,
          {
            v: 100,
            duration: 1.4,
            ease: "power2.inOut",
            onUpdate: () => {
              if (count.current)
                count.current.textContent = String(Math.round(n.v)).padStart(3, "0");
            },
          },
          0,
        )
        .to("[data-spark]", { scale: 0, duration: 0.35, ease: "back.in(2)" }, 1.45)
        .add(onDone, 1.55)
        .to(root.current, { yPercent: -100, duration: 1.1, ease: "expo.inOut" }, 1.6);
    }, root);
    return () => {
      ctx.revert();
      stopScroll(false);
    };
    // onDone is stable for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (gone) return null;
  return (
    <div
      ref={root}
      aria-hidden
      className="fixed inset-0 z-[90] flex items-center justify-center bg-background"
    >
      <span data-spark className="block">
        <Spark className="size-24 text-primary" />
      </span>
      <span
        ref={count}
        className="gutter absolute right-0 bottom-6 font-display text-[clamp(64px,12vw,200px)] leading-none font-extrabold tracking-[-0.05em] text-foreground tabular-nums"
      >
        000
      </span>
      <span className="gutter absolute bottom-8 left-0 max-w-[24ch] text-[15px] text-muted-foreground">
        Waking the team
      </span>
    </div>
  );
}
