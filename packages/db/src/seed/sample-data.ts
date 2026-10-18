import type { AgentGrant, AgentSpec } from "@ofa/contracts";
import type { TenantContext } from "@ofa/core";
import type { Database } from "../client";
import { agent, agentGrant, message, thread, threadMember } from "../schema/index";
import { withTenant } from "../tenant";

const SAMPLE_AGENTS: readonly {
  slug: string;
  name: string;
  description: string;
  spec: AgentSpec;
  grants: readonly AgentGrant[];
}[] = [
  {
    slug: "researcher",
    name: "Researcher",
    description: "Searches the web, reads sources and writes short, cited summaries.",
    spec: {
      job: "Research",
      modelTier: "standard",
      role: "specialist",
      autonomy: "act-with-approval",
      voice: "calm",
      avatar: { form: "bloom", eyes: "googly", skin: "dots", color: "lilac", mark: "spark" },
      memoryScopes: ["agent", "workspace"],
      budgets: { steps: 40, tokens: 120_000 },
    },
    grants: [
      { tool: "web.search", mode: "auto" },
      { tool: "web.read_url", mode: "auto" },
      { tool: "remember", mode: "auto" },
      { tool: "recall", mode: "auto" },
    ],
  },
  {
    slug: "inbox",
    name: "Inbox Assistant",
    description: "Triages email and drafts replies for approval.",
    spec: {
      job: "Inbox triage",
      modelTier: "fast",
      role: "specialist",
      autonomy: "suggest",
      voice: "brief",
      avatar: { form: "drop", eyes: "beans", skin: "stripes", color: "mint", mark: "none" },
      memoryScopes: ["agent", "workspace"],
      budgets: { steps: 20, tokens: 60_000 },
    },
    grants: [{ tool: "recall", mode: "auto" }],
  },
];

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
          slug: a.slug,
          name: a.name,
          description: a.description,
          spec: a.spec,
          workspaceId: ctx.workspaceId,
          createdBy: ctx.userId,
        })),
      )
      .onConflictDoNothing({ target: [agent.workspaceId, agent.slug] })
      .returning({ id: agent.id, slug: agent.slug });

    const grants = created.flatMap((row) =>
      (SAMPLE_AGENTS.find((a) => a.slug === row.slug)?.grants ?? []).map((grant) => ({
        ...grant,
        workspaceId: ctx.workspaceId,
        agentId: row.id,
        createdBy: ctx.userId,
      })),
    );
    if (grants.length > 0) await tx.insert(agentGrant).values(grants);

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
      content: "Sample thread created by the dev seed.",
    });

    return { agentsCreated: created.length, threadCreated: true };
  });
}
