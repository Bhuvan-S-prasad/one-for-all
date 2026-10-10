import type { MemoryStore } from "@ofa/core";
import {
  insertMemory,
  searchEpisodes,
  searchMemories,
  upsertEpisode,
  type Database,
} from "@ofa/db";

// The self-host `MemoryStore` (ARCHITECTURE.md §8). Recall is Postgres
// full-text search, which needs no embedding model and costs no quota. When a
// provider with embeddings is configured, vectors join the ranking here
// (`memory.embedding` is ready for them); callers do not change.

/** Episode summaries are short: a sentence or two. */
const EPISODE_CHARS = 600;

export function createPgMemoryStore(db: Database): MemoryStore {
  return {
    async write(ctx, memory) {
      const content = memory.content.replace(/\s+/g, " ").trim();
      return insertMemory(db, ctx, { ...memory, content });
    },
    async recall(ctx, query) {
      return searchMemories(db, ctx, query);
    },
    async writeEpisode(ctx, episode) {
      const flat = episode.summary.replace(/\s+/g, " ").trim();
      await upsertEpisode(db, ctx, {
        ...episode,
        summary: flat.length > EPISODE_CHARS ? `${flat.slice(0, EPISODE_CHARS - 1)}…` : flat,
      });
    },
    async recallEpisodes(ctx, query) {
      return searchEpisodes(db, ctx, query);
    },
  };
}
