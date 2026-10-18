import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollTrigger, useEyes, useMagnetic, useRise, useSmoothScroll } from "@/lib/motion";
import { Cursor } from "./cursor";
import { Day } from "./day";
import { Finale } from "./finale";
import { Hatchery } from "./hatchery";
import { Install } from "./install";
import { Manifesto } from "./manifesto";
import { Marquee } from "./marquee";
import { Nav } from "./nav";
import { Preloader } from "./preloader";
import { Routing } from "./routing";
import { Stack } from "./stack";
import { Taint } from "./taint";

// The landing page: a hatchery of familiars, what it is read word by word, a
// day with the team scrolled sideways, taint played out, the routing you can
// try, a deck of what every agent gets, what it is built on, three commands,
// and a lime close. The familiars' eyes follow the pointer throughout.

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);

  useSmoothScroll();
  useRise(root);
  useEyes(root);
  useMagnetic(root);

  useEffect(() => {
    document.title = "One-for-All: a self-hosted team of AI agents";
  }, []);

  // Measure once everything is in place: triggers in page order, after the
  // fonts have loaded (they change every height), so pinned sections start
  // exactly where they should instead of jumping as you reach them.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const settle = () => {
      if (cancelled) return;
      ScrollTrigger.sort();
      ScrollTrigger.refresh();
    };
    const frame = requestAnimationFrame(settle);
    void document.fonts?.ready.then(settle);
    window.addEventListener("load", settle);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("load", settle);
    };
  }, [ready]);

  return (
    <div ref={root} className="overflow-x-clip">
      <Preloader onDone={onReady} />
      <Cursor />
      <Nav />
      <main>
        <Hatchery ready={ready} />
        <Manifesto />
        <Day />
        <Taint />
        <Routing />
        <Stack />
        <Marquee />
        <Install />
      </main>
      <Finale />
    </div>
  );
}
