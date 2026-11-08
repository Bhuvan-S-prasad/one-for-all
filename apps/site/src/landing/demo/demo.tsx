import { AppWindow } from "./window";

// "Watch them work": the app, rebuilt so a visitor can use it on the page.
// The Operator is mid-task and needs a sign-in; the other conversations each
// show one thing a team of agents does. Nothing here talks to a server.

export function Demo() {
  return (
    <section
      id="demo"
      aria-labelledby="demo-title"
      className="gutter relative py-[clamp(72px,12vh,140px)]"
    >
      <div className="mx-auto mb-10 flex max-w-[1180px] flex-col gap-5 md:mb-14 md:flex-row md:items-end md:justify-between">
        <h2
          id="demo-title"
          data-rise
          className="max-w-[8em] text-[clamp(48px,7vw,120px)] leading-[0.9] font-extrabold tracking-[-0.05em]"
        >
          Watch them work.
        </h2>
        <div
          data-rise
          className="flex max-w-[420px] flex-col gap-3 text-[17px] text-muted-foreground"
        >
          <p>
            <span className="text-foreground">This is the app, and you can use it.</span> The
            Operator is reordering coffee on its own computer and needs you to sign in. Press{" "}
            <span className="text-foreground">Take over</span>.
          </p>
          <p className="text-[13.5px]">
            A demo: Kestrel Coffee and Green Field are made up, and nothing leaves this page.
          </p>
        </div>
      </div>
      <div data-rise>
        <AppWindow />
      </div>
    </section>
  );
}
