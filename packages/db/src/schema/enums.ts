import { GRANT_MODES, MEMORY_KINDS, MEMORY_SCOPES, VERDICTS } from "@ofa/core";
import { pgEnum } from "drizzle-orm/pg-core";

export const membershipRole = pgEnum("membership_role", ["owner", "admin", "member"]);

export const devicePlatform = pgEnum("device_platform", ["ios", "android", "web", "other"]);

export const agentStatus = pgEnum("agent_status", ["active", "paused", "archived"]);

export const threadKind = pgEnum("thread_kind", ["direct", "group", "handoff"]);

/** Who can be in a thread. */
export const participantType = pgEnum("participant_type", ["user", "agent"]);

/** Who wrote a message or performed an audited action. */
export const actorType = pgEnum("actor_type", ["user", "agent", "system"]);

/** What started a run (ARCHITECTURE.md §5). */
export const runTrigger = pgEnum("run_trigger", [
  "message",
  "routine",
  "delegation",
  "event",
  "manual",
  "schedule",
]);

export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

/** Per-tool setting on an agent (ARCHITECTURE.md §9.1). */
export const grantMode = pgEnum("grant_mode", GRANT_MODES);

export const policyVerdict = pgEnum("policy_verdict", VERDICTS);

/** `in_flight` is written before a tool runs and `done` after (ADR-0015). */
export const toolCallStatus = pgEnum("tool_call_status", ["in_flight", "done", "failed"]);

export const memoryScope = pgEnum("memory_scope", MEMORY_SCOPES);

export const memoryKind = pgEnum("memory_kind", MEMORY_KINDS);

/** A routine runs on its schedule, or waits (M5.06). */
export const routineStatus = pgEnum("routine_status", ["active", "paused"]);

/** What an agent set for later (M5.07). */
export const scheduleKind = pgEnum("schedule_kind", ["task", "reminder"]);

export const scheduleStatus = pgEnum("schedule_status", ["pending", "done", "cancelled", "failed"]);

/** `proposed` skills wait for a person; only `active` ones reach a model (M5.08). */
export const skillStatus = pgEnum("skill_status", ["active", "proposed", "archived"]);

export const skillSource = pgEnum("skill_source", ["person", "agent", "consolidation"]);

/** How a run ended, as its episode says (M5.09). */
export const episodeOutcome = pgEnum("episode_outcome", ["done", "stopped", "failed"]);

/** A routine that does a job, or a read-only check that speaks only when something needs attention (M5.10). */
export const routineKind = pgEnum("routine_kind", ["task", "check"]);
