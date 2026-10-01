import type { TenantContext } from "@ofa/core";
import type { Database } from "../client";
import { agent, message, thread, threadMember } from "../schema/index";
import { withTenant } from "../tenant";

const SAMPLE_AGENTS = [
  {
    slug: "researcher",
    name: "Researcher",
    description: "Searches the web, reads sources and writes short, cited summaries.",
    spec: { role: "research", tier: "standard", autonomy: "ask-first" },
  },
  {
    slug: "inbox",
    name: "Inbox Assistant",
    description: "Triages email and drafts replies for approval.",
    spec: { role: "inbox", tier: "fast", autonomy: "ask-first" },
  },
] as const;

/**
 * Development sample data for one workspace: two agents and a welcome thread.
 * Safe to run repeatedly; existing rows are left alone.
 */
export async function seedSampleData(
  db: Database,
  ctx: TenantContext,
): Promise<{ agentsCreated: number; threadCreated: boolean }> {
  return withTenant(db, ctx, async (tx) => {
    const created = await tx
      .insert(agent)
      .values(
        SAMPLE_AGENTS.map((a) => ({
          ...a,
          spec: { ...a.spec },
          workspaceId: ctx.workspaceId,
          createdBy: ctx.userId,
        })),
      )
      .onConflictDoNothing({ target: [agent.workspaceId, agent.slug] })
      .returning({ id: agent.id, slug: agent.slug });

    const researcher = created.find((a) => a.slug === "researcher");
    if (!researcher) return { agentsCreated: created.length, threadCreated: false };

    const [welcome] = await tx
      .insert(thread)
      .values({
        workspaceId: ctx.workspaceId,
        kind: "direct",
        title: "Welcome",
        createdBy: ctx.userId,
      })
      .returning({ id: thread.id });
    if (!welcome) throw new Error("thread insert returned no row");

    await tx.insert(threadMember).values([
      {
        workspaceId: ctx.workspaceId,
        threadId: welcome.id,
        memberType: "user",
        userId: ctx.userId,
      },
      {
        workspaceId: ctx.workspaceId,
        threadId: welcome.id,
        memberType: "agent",
        agentId: researcher.id,
      },
    ]);
    await tx.insert(message).values({
      workspaceId: ctx.workspaceId,
      threadId: welcome.id,
      authorType: "system",
      content: "Sample thread created by the dev seed. Agents start answering in M2.",
    });

    return { agentsCreated: created.length, threadCreated: true };
  });
}
