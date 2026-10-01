import type { FamiliarLook, FamiliarMood } from "@ofa/contracts";
import { Familiar } from "@/components/familiar";

/** Empty state for sections that arrive in later milestones. */
export function ComingSoon(props: {
  heading: string;
  children: string;
  familiar: FamiliarLook;
  mood?: FamiliarMood;
}) {
  return (
    <section className="bg-dots flex flex-col items-center gap-3.5 rounded-xl border bg-card px-6 pt-12 pb-14 text-center md:px-8">
      <Familiar look={props.familiar} mood={props.mood} size={190} ring="var(--card)" />
      <span className="eyebrow rounded-full bg-primary px-2.5 py-1 text-[11px] text-primary-foreground">
        Coming soon
      </span>
      <h2 className="text-[40px] leading-[0.95] font-extrabold tracking-[-0.04em] md:text-5xl">
        {props.heading}
      </h2>
      <p className="max-w-[480px] text-base leading-normal text-muted-foreground">
        {props.children}
      </p>
    </section>
  );
}
