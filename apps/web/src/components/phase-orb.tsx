import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { orbStateFor } from "@/lib/orb";
import type { RunPhase } from "@/lib/run-steps";
import { useTheme } from "@/lib/theme";

// A thinking orb (thinking-orbs) for what an agent is doing right now. The
// words beside it say the same thing, so the orb itself is hidden from
// screen readers. The app's theme is passed in: light mode removes the
// `dark` class rather than adding `light`, which the orb's auto mode
// would read as "follow the OS".

export function PhaseOrb({
  phase,
  state,
  size = 20,
  className,
}: {
  phase?: Pick<RunPhase, "kind" | "tool" | "after" | "waitingFor">;
  /** A fixed state, when there is no run phase to read. */
  state?: OrbState;
  size?: 20 | 64;
  className?: string;
}) {
  const { dark } = useTheme();
  return (
    <ThinkingOrb
      state={state ?? (phase ? orbStateFor(phase) : "working")}
      size={size}
      theme={dark ? "dark" : "light"}
      aria-hidden
      className={className}
    />
  );
}
