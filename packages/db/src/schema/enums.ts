import { pgEnum } from "drizzle-orm/pg-core";

export const membershipRole = pgEnum("membership_role", ["owner", "admin", "member"]);

export const devicePlatform = pgEnum("device_platform", ["ios", "android", "web", "other"]);

export const agentStatus = pgEnum("agent_status", ["active", "paused", "archived"]);

export const threadKind = pgEnum("thread_kind", ["direct", "group"]);

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
