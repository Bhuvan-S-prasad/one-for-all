import { skillSlug, zonedParts, type MemoryMaintenance } from "@ofa/core";
import {
  agentsWithMemory,
  closeEpisodes,
  createSkill,
  expireStaleFacts,
  factsToConsolidate,
  insertMemory,
  markWorkspaceConsolidated,
  mergeFacts,
  newEpisodes,
  type ConsolidationCandidate,
  type Database,
} from "@ofa/db";

// The data side of nightly consolidation (ARCHITECTURE.md §8, M5.09). The
// harness decides what to merge, add and propose; the rules here need no
// model.

/** The local hour the nightly pass runs at, in the workspace's time zone. */
export const CONSOLIDATION_HOUR = 3;
/** Unconfirmed facts expire after this long. */
export const UNVERIFIED_DAYS = 30;
/** Facts never recalled in this long expire (preferences stay). */
export const UNUSED_DAYS = 180;
/** Episodes are kept this long. */
export const EPISODE_DAYS = 180;
/** Skills per workspace (SKILLS_PER_WORKSPACE in the contracts). */
const SKILL_LIMIT = 200;

const DAY = 24 * 60 * 60_000;

export interface MaintenanceOptions {
  /** Every workspace with its owner, zone and last pass; reads through the owner connection. */
  readonly candidates: () => Promise<ConsolidationCandidate[]>;
}

export function createMemoryMaintenance(
  db: Database,
  options: MaintenanceOptions,
): MemoryMaintenance {
  return {
    async listDue(now) {
      return (await options.candidates())
        .filter((w) => {
          if (w.consolidatedAt && now.getTime() - w.consolidatedAt.getTime() < 20 * 60 * 60_000) {
            return false;
          }
          try {
            return zonedParts(now, w.timeZone).hour === CONSOLIDATION_HOUR;
          } catch {
            return zonedParts(now, "UTC").hour === CONSOLIDATION_HOUR;
          }
        })
        .map((w) => ({ workspaceId: w.workspaceId, userId: w.userId }));
    },

    agents: (ctx) => agentsWithMemory(db, ctx),

    facts: (ctx, agentId, limit) => factsToConsolidate(db, ctx, agentId, limit),

    async newEpisodes(ctx, agentId, limit) {
      return (await newEpisodes(db, ctx, agentId, limit)).map((e) => ({
        summary: e.summary,
        outcome: e.outcome,
      }));
    },

    async merge(ctx, input) {
      return mergeFacts(db, ctx, { ...input, ids: [...input.ids] });
    },

    async addFact(ctx, input) {
      await insertMemory(
        db,
        { ...ctx, ...(input.agentId ? { agentId: input.agentId as never } : {}) },
        {
          scope: input.agentId ? "agent" : "workspace",
          kind: "fact",
          content: input.content.replace(/\s+/g, " ").trim(),
          verified: input.verified,
        },
      );
    },

    async proposeSkill(ctx, input) {
      try {
        await createSkill(
          db,
          ctx,
          {
            agentId: input.agentId,
            slug: skillSlug(input.name),
            name: input.name,
            description: input.description,
            steps: [...input.steps],
            status: "proposed",
            source: "consolidation",
          },
          SKILL_LIMIT,
        );
        return true;
      } catch {
        // Its handle is taken, or the workspace is full: not proposed.
        return false;
      }
    },

    expireStale: (ctx, now) =>
      expireStaleFacts(db, ctx, { now, unverifiedDays: UNVERIFIED_DAYS, unusedDays: UNUSED_DAYS }),

    closeEpisodes: (ctx, agentId, now) =>
      closeEpisodes(db, ctx, agentId, now, new Date(now.getTime() - EPISODE_DAYS * DAY)),

    finish: (ctx, now) => markWorkspaceConsolidated(db, ctx, now),
  };
}
