import {
  asId,
  MAX_ARTIFACT_BYTES,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactStore,
  type TenantContext,
} from "@ofa/core";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { artifact } from "../schema/index";
import { withTenant } from "../tenant";

// The artifact store in Postgres (M3.06). Content lives in a bytea column;
// the 10 MB limit keeps it reasonable for a self-hosted database.

const columns = {
  id: artifact.id,
  runId: artifact.runId,
  agentId: artifact.agentId,
  kind: artifact.kind,
  name: artifact.name,
  mimeType: artifact.mimeType,
  size: artifact.size,
  untrusted: artifact.untrusted,
  createdAt: artifact.createdAt,
};

type Row = { [K in keyof typeof columns]: (typeof artifact.$inferSelect)[K] };

function toRecord(row: Row): ArtifactRecord {
  return {
    ...row,
    id: asId(row.id),
    runId: asId(row.runId),
    agentId: asId(row.agentId),
    kind: row.kind as ArtifactKind,
  };
}

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export function createArtifactStore(db: Database): ArtifactStore {
  return {
    async put(ctx, input) {
      const content = Buffer.from(input.content);
      if (content.length > MAX_ARTIFACT_BYTES) {
        throw Object.assign(new Error("Too large to keep (over 10 MB)"), { code: "too_large" });
      }
      return withTenant(db, ctx, async (tx) => {
        const [created] = await tx
          .insert(artifact)
          .values({
            workspaceId: ctx.workspaceId,
            runId: ctx.runId,
            agentId: ctx.agentId,
            key: input.key,
            kind: input.kind,
            name: input.name.slice(0, 500),
            mimeType: input.mimeType,
            size: content.length,
            untrusted: input.untrusted,
            content,
          })
          .onConflictDoNothing({ target: [artifact.runId, artifact.key] })
          .returning(columns);
        if (created) return toRecord(created);
        // A retried step: the artifact from the first attempt.
        const [existing] = await tx
          .select(columns)
          .from(artifact)
          .where(and(eq(artifact.runId, ctx.runId), eq(artifact.key, input.key)))
          .limit(1);
        if (!existing) throw new Error("artifact vanished");
        return toRecord(existing);
      });
    },

    async get(ctx: TenantContext, id: string) {
      if (!isUuid(id)) return null;
      const [row] = await withTenant(db, ctx, (tx) =>
        tx.select(columns).from(artifact).where(eq(artifact.id, id)).limit(1),
      );
      return row ? toRecord(row) : null;
    },

    async read(ctx: TenantContext, id: string) {
      if (!isUuid(id)) return null;
      const [row] = await withTenant(db, ctx, (tx) =>
        tx.select({ content: artifact.content }).from(artifact).where(eq(artifact.id, id)).limit(1),
      );
      return row ? new Uint8Array(row.content) : null;
    },

    async listForRun(ctx: TenantContext, runId: string) {
      if (!isUuid(runId)) return [];
      const rows = await withTenant(db, ctx, (tx) =>
        tx
          .select(columns)
          .from(artifact)
          .where(eq(artifact.runId, runId))
          .orderBy(asc(artifact.createdAt)),
      );
      return rows.map(toRecord);
    },
  };
}
