import { Fragment, useEffect, useRef } from "react";
import { Familiar } from "@/components/familiar";
import { gsap } from "@/lib/motion";
import { reducedMotion } from "@/lib/site";
import { bySlug, CHIEF } from "@/lib/team";

// What it is, read as you scroll: each word lights up as it passes, and the
// familiar beside a phrase pops in when its word does.

type Piece = string | { slug: string };

const TEXT: readonly Piece[] = [
  "Not one assistant that does everything.",
  "A team,",
  { slug: CHIEF.slug },
  "each with one job, its own computer",
  { slug: "operator" },
  "and a memory. It works while you are away,",
  { slug: "researcher" },
  "and it asks you before anything leaves.",
  { slug: "inbox" },
];

export function Manifesto() {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (reducedMotion()) return;
    const ctx = gsap.context(() => {
      const words = gsap.utils.toArray<HTMLElement>("[data-w]");
      gsap.fromTo(
        words,
        { opacity: 0.14 },
        {
          opacity: 1,
          stagger: 0.1,
          ease: "none",
          scrollTrigger: {
            trigger: "[data-text]",
            start: "top 80%",
            end: "bottom 45%",
            scrub: 0.4,
          },
        },
      );
      gsap.utils.toArray<HTMLElement>("[data-inline]").forEach((el) => {
        gsap.from(el, {
          scale: 0,
          rotate: -30,
          ease: "back.out(3)",
          duration: 0.6,
          scrollTrigger: { trigger: el, start: "top 70%", toggleActions: "play none none reverse" },
        });
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={root} aria-label="What it is" className="gutter py-[clamp(120px,22vh,260px)]">
      <p
        data-text
        className="max-w-[17em] font-display text-[clamp(36px,5.4vw,96px)] leading-[1.02] font-bold tracking-[-0.035em]"
      >
        {TEXT.map((piece, i) =>
          typeof piece === "string" ? (
            <Fragment key={i}>
              {piece.split(" ").map((w, j) => (
                <Fragment key={j}>
                  <span data-w>{w}</span>{" "}
                </Fragment>
              ))}
            </Fragment>
          ) : (
            <span
              key={i}
              data-inline
              className="mr-[0.2em] inline-block size-[0.9em] translate-y-[0.12em] align-baseline"
            >
              <Familiar
                look={piece.slug === CHIEF.slug ? CHIEF.look : bySlug.get(piece.slug)!.look}
                size="100%"
                animate
              />
            </span>
          ),
        )}
      </p>
    </section>
  );
}
