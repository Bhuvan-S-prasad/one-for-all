import { useEffect, useRef, useState } from "react";
import { gsap } from "@/lib/motion";
import { reducedMotion } from "@/lib/site";

// A cursor of our own on fine pointers: a small lime dot that trails the
// pointer and gives a little when you press.

export function Cursor() {
  const dot = useRef<HTMLDivElement>(null);
  const [on] = useState(() => !reducedMotion() && window.matchMedia("(pointer: fine)").matches);

  useEffect(() => {
    if (!on) return;
    document.documentElement.classList.add("has-cursor");
    const el = dot.current;
    if (!el) return;
    const x = gsap.quickTo(el, "x", { duration: 0.35, ease: "power3.out" });
    const y = gsap.quickTo(el, "y", { duration: 0.35, ease: "power3.out" });
    const move = (e: PointerEvent) => {
      x(e.clientX);
      y(e.clientY);
    };
    const down = () => gsap.to(el, { scale: 0.6, duration: 0.15 });
    const up = () => gsap.to(el, { scale: 1, duration: 0.4, ease: "elastic.out(1, 0.5)" });
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    return () => {
      document.documentElement.classList.remove("has-cursor");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
    };
  }, [on]);

  if (!on) return null;
  return (
    <div ref={dot} aria-hidden className="pointer-events-none fixed top-0 left-0 z-[100]">
      <div
        className="size-3 rounded-full bg-primary"
        style={{ transform: "translate(-50%, -50%)" }}
      />
    </div>
  );
}
