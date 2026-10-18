import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { gsap } from "@/lib/motion";
import { reducedMotion, REPO_URL } from "@/lib/site";

// Getting it running, typed out as it scrolls into view, then the first
// sign-in in plain words.

const LINES: readonly { prompt?: boolean; text: string; dim?: boolean }[] = [
  { text: "# needs Docker and about 3 GB of free memory", dim: true },
  { prompt: true, text: `git clone ${REPO_URL}.git` },
  { prompt: true, text: "cd one-for-all" },
  { prompt: true, text: "sh infra/scripts/init-env.sh" },
  {
    prompt: true,
    text: "docker compose -f infra/compose/docker-compose.selfhost.yml up -d --build",
  },
  { text: "✓ One-for-All is running. Open it in your browser.", dim: false },
];

export function Install() {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (reducedMotion()) return;
    const el = root.current;
    const ctx = gsap.context(() => {
      const lines = gsap.utils.toArray<HTMLElement>("[data-line-text]");
      // The words come from LINES, not the page: in development React runs this
      // twice, and the first run has already emptied the lines.
      const full = LINES.map((l) => l.text);
      lines.forEach((l) => (l.textContent = ""));
      const tl = gsap.timeline({ scrollTrigger: { trigger: "[data-term]", start: "top 70%" } });
      lines.forEach((line, i) => {
        const text = full[i] ?? "";
        const n = { c: 0 };
        tl.to(n, {
          c: text.length,
          duration: Math.min(1.4, 0.2 + text.length * 0.018),
          ease: "none",
          onUpdate: () => {
            line.textContent = text.slice(0, Math.round(n.c));
          },
        }).to({}, { duration: 0.25 });
      });
      gsap.from("[data-signin]", {
        y: 50,
        autoAlpha: 0,
        stagger: 0.1,
        duration: 1,
        ease: "silk",
        scrollTrigger: { trigger: "[data-signin-list]", start: "top 80%" },
      });
    }, root);
    return () => {
      ctx.revert();
      el?.querySelectorAll<HTMLElement>("[data-line-text]").forEach(
        (l, i) => (l.textContent = LINES[i]?.text ?? ""),
      );
    };
  }, []);

  return (
    <section ref={root} aria-label="Run it" className="gutter py-[clamp(96px,14vh,180px)]">
      <h2 className="text-[clamp(56px,9vw,170px)] leading-[0.88] font-extrabold tracking-[-0.055em]">
        Three commands.
        <br />
        <span className="text-muted-foreground">Your own team.</span>
      </h2>

      <div className="mt-[clamp(48px,8vh,96px)] grid gap-12 lg:grid-cols-[7fr_5fr] lg:gap-16">
        <div
          data-term
          className="overflow-hidden rounded-[24px] bg-[#0a0a0b] ring-1 ring-[#26262a]"
        >
          <div className="flex items-center gap-2 px-5 py-3">
            <span className="size-3 rounded-full bg-[#ff5b3a]" aria-hidden />
            <span className="size-3 rounded-full bg-[#ffc93a]" aria-hidden />
            <span className="size-3 rounded-full bg-[#6ef0c2]" aria-hidden />
            <span className="ml-3 text-[13px] text-muted-foreground">your machine</span>
          </div>
          <pre className="overflow-x-auto px-6 pt-2 pb-8 font-mono text-[clamp(13px,1vw,15px)] leading-[2]">
            <code>
              {LINES.map((l, i) => (
                <span key={i} className="block min-h-[2em]">
                  {l.prompt && <span className="text-primary">$ </span>}
                  <span
                    data-line-text
                    className={
                      l.dim
                        ? "text-muted-foreground"
                        : l.prompt
                          ? "text-foreground"
                          : "text-[#6ef0c2]"
                    }
                  >
                    {l.text}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        </div>

        <div className="flex flex-col gap-6">
          <p className="text-[clamp(22px,2vw,30px)] leading-snug font-semibold">
            Then open it in your browser. The first visit asks you to create the owner account.
          </p>
          <ol data-signin-list className="flex flex-col gap-3">
            {[
              ["Your name", "how agents address you"],
              ["Workspace", "any name, like “Home”"],
              ["Email", "your sign-in name; nothing is sent to it"],
              ["Password", "one you choose"],
            ].map(([k, v]) => (
              <li
                key={k}
                data-signin
                className="flex items-baseline justify-between gap-6 rounded-[18px] bg-card px-5 py-4"
              >
                <span className="font-display text-[22px] font-bold">{k}</span>
                <span className="text-right text-[15px] text-muted-foreground">{v}</span>
              </li>
            ))}
          </ol>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            Running from source instead? The dev seed signs you in as owner@example.com with the
            password dev-password-123 (development only).{" "}
            <Link
              to="/docs/$page"
              params={{ page: "quick-start" }}
              className="text-foreground underline underline-offset-4"
            >
              The quick start
            </Link>{" "}
            has every step.
          </p>
        </div>
      </div>
    </section>
  );
}
