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
