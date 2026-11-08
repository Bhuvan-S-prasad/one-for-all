import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Wordmark } from "@/components/wordmark";
import { gsap, scrollToTarget, ScrollTrigger } from "@/lib/motion";
import { REPO_URL } from "@/lib/site";

// A plain bar that steps out of the way while you scroll down and comes back
// as soon as you scroll up.

export function Nav() {
  const bar = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const show = gsap.quickTo(el, "yPercent", { duration: 0.45, ease: "power3.out" });
    const st = ScrollTrigger.create({
      start: 0,
      end: "max",
      onUpdate: (self) => {
        if (self.scroll() < 120) show(0);
        else show(self.direction === 1 ? -130 : 0);
      },
    });
    return () => st.kill();
  }, []);

  return (
    <header
      ref={bar}
      className="gutter fixed inset-x-0 top-0 z-50 flex items-center justify-between py-5"
    >
      <Link
        to="/"
        aria-label="One-for-All, home"
        className="rounded-full bg-[#0e0e0f]/90 px-4 py-2.5 text-foreground"
      >
        <Wordmark />
      </Link>
      <nav
        aria-label="Main"
        className="flex items-center gap-1 rounded-full bg-[#0e0e0f]/90 p-1.5 text-[15px] text-foreground"
      >
        <button
          type="button"
          onClick={() => scrollToTarget("#demo")}
          className="hidden rounded-full px-4 py-2 transition-colors hover:bg-[#222225] sm:block"
        >
          Try it
        </button>
        <button
          type="button"
          onClick={() => scrollToTarget("#day")}
          className="hidden rounded-full px-4 py-2 transition-colors hover:bg-[#222225] md:block"
        >
          A day
        </button>
        <Link to="/docs" className="rounded-full px-4 py-2 transition-colors hover:bg-[#222225]">
          Docs
        </Link>
        <a
          href={REPO_URL}
          className="rounded-full bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-95"
        >
          GitHub
        </a>
      </nav>
    </header>
  );
}
