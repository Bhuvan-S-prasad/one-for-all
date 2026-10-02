import type { MemoryStore } from "@ofa/core";
import { insertMemory, searchMemories, type Database } from "@ofa/db";

// The self-host `MemoryStore` (ARCHITECTURE.md §8). Recall is Postgres
// full-text search, which needs no embedding model and costs no quota. When a
// provider with embeddings is configured, vectors join the ranking here
// (`memory.embedding` is ready for them); callers do not change.

export function createPgMemoryStore(db: Database): MemoryStore {
  return {
    async write(ctx, memory) {
      const content = memory.content.replace(/\s+/g, " ").trim();
      return insertMemory(db, ctx, { ...memory, content });
    },
    async recall(ctx, query) {
      return searchMemories(db, ctx, query);
    },
  };
}
