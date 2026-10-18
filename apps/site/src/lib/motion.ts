import gsap from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { Flip } from "gsap/Flip";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import Lenis from "lenis";
import { useEffect, type RefObject } from "react";
import { reducedMotion } from "./site";

// The landing page's motion engine: Lenis smooth scrolling on GSAP's ticker
// (so ScrollTrigger reads the same position), one shared pointer, familiars
// whose eyes follow it, and magnetic controls. Everything stops under reduced
// motion, and the page reads complete before any of it runs.

gsap.registerPlugin(ScrollTrigger, SplitText, DrawSVGPlugin, ScrambleTextPlugin, CustomEase, Flip);
CustomEase.create("hatch", "M0,0 C0.18,0.9 0.32,1.18 0.5,1.08 0.66,0.99 0.8,1 1,1");
CustomEase.create("silk", "M0,0 C0.16,1 0.3,1 1,1");

export { Flip, gsap, ScrollTrigger, SplitText };

let lenis: Lenis | null = null;

export function useSmoothScroll(): void {
  useEffect(() => {
    if (reducedMotion()) return;
    const instance = new Lenis({ lerp: 0.08, smoothWheel: true });
    lenis = instance;
    instance.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => instance.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      instance.destroy();
      lenis = null;
    };
  }, []);
}

export function scrollToTarget(target: string | number): void {
  if (lenis) lenis.scrollTo(target, { duration: 1.6 });
  else if (typeof target === "number") window.scrollTo({ top: target });
  else document.querySelector(target)?.scrollIntoView();
}

export function stopScroll(stop: boolean): void {
  if (!lenis) return;
  if (stop) lenis.stop();
  else lenis.start();
}

// ── The pointer, shared ─────────────────────────────────────────────────────

export const pointer = { x: -9999, y: -9999, active: false };

if (typeof window !== "undefined") {
  const move = (x: number, y: number) => {
    pointer.x = x;
    pointer.y = y;
    pointer.active = true;
  };
  window.addEventListener("pointermove", (e) => move(e.clientX, e.clientY), { passive: true });
  window.addEventListener("pointerdown", (e) => move(e.clientX, e.clientY), { passive: true });
}

// ── Eyes that follow ────────────────────────────────────────────────────────

/**
 * Every familiar under `root` looks at the pointer: its pupils slide up to
 * 3.2 units of its 120-unit drawing toward it, eased, each frame.
 */
export function useEyes(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion()) return;
    const state = new WeakMap<Element, { x: number; y: number }>();
    const tick = () => {
      if (!pointer.active) return;
      const svgs = el.querySelectorAll<SVGSVGElement>("svg.familiar");
      for (const svg of svgs) {
        const r = svg.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight || r.width === 0) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height * 0.42;
        const dx = pointer.x - cx;
        const dy = pointer.y - cy;
        const d = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, d / (r.width * 1.6));
        const tx = (dx / d) * 3.2 * reach;
        const ty = (dy / d) * 3 * reach;
        const prev = state.get(svg) ?? { x: 0, y: 0 };
        const next = { x: prev.x + (tx - prev.x) * 0.18, y: prev.y + (ty - prev.y) * 0.18 };
        state.set(svg, next);
        const pupils = svg.querySelector<SVGGElement>(".familiar-pupils");
        pupils?.setAttribute("transform", `translate(${next.x.toFixed(2)} ${next.y.toFixed(2)})`);
      }
    };
    gsap.ticker.add(tick);
    return () => gsap.ticker.remove(tick);
  }, [root]);
}

// ── Magnetic controls ───────────────────────────────────────────────────────

/** Elements marked `data-magnetic` lean toward the pointer while it is near. */
export function useMagnetic(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion() || !window.matchMedia("(pointer: fine)").matches) return;
    const items = [...el.querySelectorAll<HTMLElement>("[data-magnetic]")];
    const cleanups = items.map((item) => {
      const x = gsap.quickTo(item, "x", { duration: 0.6, ease: "elastic.out(1, 0.4)" });
      const y = gsap.quickTo(item, "y", { duration: 0.6, ease: "elastic.out(1, 0.4)" });
      const move = (e: PointerEvent) => {
        const r = item.getBoundingClientRect();
        x((e.clientX - (r.left + r.width / 2)) * 0.35);
        y((e.clientY - (r.top + r.height / 2)) * 0.35);
      };
      const leave = () => {
        x(0);
        y(0);
      };
      item.addEventListener("pointermove", move);
      item.addEventListener("pointerleave", leave);
      return () => {
        item.removeEventListener("pointermove", move);
        item.removeEventListener("pointerleave", leave);
      };
    });
    return () => cleanups.forEach((c) => c());
  }, [root]);
}

/** Section parts marked `data-rise` rise in, in small staggered groups. */
export function useRise(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion()) return;
    const items = el.querySelectorAll<HTMLElement>("[data-rise]");
    const ctx = gsap.context(() => {
      gsap.set(items, { autoAlpha: 0, y: 40 });
      ScrollTrigger.batch(items, {
        start: "top 90%",
        once: true,
        onEnter: (batch) =>
          gsap.to(batch, {
            autoAlpha: 1,
            y: 0,
            duration: 1.1,
            ease: "silk",
            stagger: 0.09,
            overwrite: true,
          }),
      });
    }, el);
    return () => ctx.revert();
  }, [root]);
}
