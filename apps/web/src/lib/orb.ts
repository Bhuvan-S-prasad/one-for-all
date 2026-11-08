import type { OrbState } from "thinking-orbs";
import type { RunPhase } from "@/lib/run-steps";

// Which thinking orb shows a run's phase: each of the orb's nine states is
// a verb, so the phase picks the verb it is doing. Pure, so it is tested
// without a canvas.

/** Tools grouped by what they look like from outside. */
const BY_TOOL: Record<string, OrbState> = {
  // Looking for something.
  "web.search": "searching",
  recall: "searching",
  "browser.snapshot": "searching",
  "desktop.snapshot": "searching",
  "desktop.screenshot": "searching",
  "files.list": "searching",
  // Taking something in.
  "web.read_url": "listening",
  "files.read": "listening",
  "artifacts.read": "listening",
  // Making something.
  "files.write": "composing",
  "todo.write": "shaping",
  remember: "composing",
  save_skill: "composing",
  // Reaching another place or person.
  use_saved_login: "connecting",
  "files.send": "connecting",
  "browser.open": "connecting",
  "desktop.open": "connecting",
  delegate_task: "weaving",
  message_agent: "weaving",
  ask_group: "weaving",
};

export function orbStateFor(
  phase: Pick<RunPhase, "kind" | "tool" | "after" | "waitingFor">,
): OrbState {
  switch (phase.kind) {
    case "queued":
      return "connecting";
    case "waiting":
      // Waiting on a person is listening for them; on the model, a slow breath.
      return phase.waitingFor === "you" ? "listening" : "breathing";
    case "thinking":
      if (phase.after === "compaction") return "shaping";
      return phase.after === "tools" ? "weaving" : "solving";
    case "working": {
      const tool = phase.tool ?? "";
      if (BY_TOOL[tool]) return BY_TOOL[tool];
      // Clicking, typing, running commands and app tools: hands-on work.
      return "working";
    }
  }
}
