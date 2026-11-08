import type {
  DiscussionStartedEvent,
  DiscussionStoppedEvent,
  RunCancelledEvent,
} from "@ofa/contracts";
import {
  AppError,
  asId,
  DEFAULT_DISCUSSION_ROUNDS,
  MAX_DISCUSSION_ROUNDS,
  type AgentId,
  type DiscussionStore,
  type MessageId,
  type RunId,
  type TenantContext,
  type ThreadId,
} from "@ofa/core";
import {
  activeDiscussionRuns,
  getDiscussion,
  listAgents,
  openDiscussion,
  openDiscussionIn,
  startDiscussionTurn,
  updateDiscussion,
  type Database,
} from "@ofa/db";
import type { BusPayload } from "@ofa/events";
import { stableUuid } from "./team";

// Group discussions (ADR-0050): opening one, its turns' runs, and stopping
// it. The orchestrator runs the turns (`runDiscussion`); this is the store it
// runs them on, and what the API and the `ask_group` tool open them with.

export interface DiscussionServiceOptions {
  /** Hand the discussion to the orchestrator (`group/discussion.started`). */
  readonly start: (event: DiscussionStartedEvent) => Promise<void>;
  /** End it between turns (`group/discussion.stopped`). */
  readonly stop: (event: DiscussionStoppedEvent) => Promise<void>;
  /** Stop a turn's run at its next step boundary (`agent/run.cancelled`). */
  readonly cancelRun: (event: RunCancelledEvent) => Promise<void>;
  /** Tell open clients something changed. */
  readonly publish?: (workspaceId: string, payload: BusPayload) => Promise<void>;
}

export interface OpenDiscussionInput {
  /** Stable for the request, so a retry opens one. */
  readonly key: string;
  readonly threadId: string;
  readonly question:
    { readonly messageId: string } | { readonly agentId: string; readonly content: string };
  readonly startedByRunId: string | null;
  readonly coordinatorAgentId: string;
  readonly memberIds: readonly string[];
  readonly rounds?: number;
  readonly tainted: boolean;
}

export interface DiscussionService extends DiscussionStore {
  /** Open a discussion and start it; a conflict while another is open in the thread. */
  open(ctx: TenantContext, input: OpenDiscussionInput): Promise<{ readonly discussionId: string }>;
  /** Stop the discussion open in a thread, if there is one. */
  stopIn(ctx: TenantContext, threadId: string): Promise<boolean>;
}

export function createDiscussionService(
  db: Database,
  options: DiscussionServiceOptions,
): DiscussionService {
  const changed = async (ctx: TenantContext, threadId: string, discussionId: string) => {
    await options
      .publish?.(ctx.workspaceId, { kind: "discussion.updated", threadId, discussionId })
      .catch(() => {});
  };

  const service: DiscussionService = {
    async open(ctx, input) {
      if (input.memberIds.length === 0) {
        throw new AppError("bad_request", "Nobody in this group can take part in a discussion");
      }
      const rounds = Math.min(
        MAX_DISCUSSION_ROUNDS,
        Math.max(1, Math.round(input.rounds ?? DEFAULT_DISCUSSION_ROUNDS)),
      );
      const id = stableUuid(`${ctx.workspaceId}:${input.key}:discussion`);
      const opened = await openDiscussion(db, ctx, {
        id,
        threadId: input.threadId,
        question: input.question,
        startedByRunId: input.startedByRunId,
        coordinatorAgentId: input.coordinatorAgentId,
        memberIds: input.memberIds.slice(0, 6),
        rounds,
        tainted: input.tainted,
      });
      if (!opened) {
        throw new AppError(
          "conflict",
          "A discussion is already going on in this chat. Wait for it to close, or say stop.",
        );
      }
      if (opened.created && "agentId" in input.question) {
        await options
          .publish?.(ctx.workspaceId, {
            kind: "message.created",
            threadId: input.threadId,
            messageId: opened.discussion.questionMessageId,
          })
          .catch(() => {});
      }
      // Sent again on a retry: Inngest drops a second event for the same discussion.
      await options.start({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        discussionId: id,
        threadId: input.threadId,
      });
      await changed(ctx, input.threadId, id);
      return { discussionId: id };
    },

    async stopIn(ctx, threadId) {
      const open = await openDiscussionIn(db, ctx, threadId);
      if (!open) return false;
      await updateDiscussion(db, ctx, open.id, { status: "stopped" });
      await options.stop({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        discussionId: open.id,
      });
      // A turn running or already waiting its turn stops too, so nothing posts after a stop.
      for (const runId of await activeDiscussionRuns(db, ctx, open.id)) {
        await options.cancelRun({ workspaceId: ctx.workspaceId, userId: ctx.userId, runId });
      }
      await changed(ctx, threadId, open.id);
      return true;
    },

    async get(ctx, discussionId) {
      const row = await getDiscussion(db, ctx, discussionId);
      if (!row) return null;
      const agents = new Map(
        (await listAgents(db, ctx)).map((a) => [a.id, { id: asId<AgentId>(a.id), name: a.name }]),
      );
      const coordinator = agents.get(row.coordinatorAgentId);
      if (!coordinator) return null;
      return {
        id: row.id,
        threadId: asId<ThreadId>(row.threadId),
        questionMessageId: asId<MessageId>(row.questionMessageId),
        coordinator,
        // In order; an agent removed since is left out.
        members: row.memberIds.flatMap((m) => agents.get(m) ?? []),
        rounds: row.rounds,
        status: row.status,
        tainted: row.tainted,
      };
    },

    async startTurn(ctx, discussionId, turn) {
      const runId = stableUuid(
        `${ctx.workspaceId}:${discussionId}:${turn.round}:${turn.position ?? "close"}:turn`,
      );
      const started = await startDiscussionTurn(db, ctx, {
        discussionId,
        runId,
        agentId: turn.agentId,
        round: turn.round,
        position: turn.position,
      });
      if (!started) return null;
      const row = await getDiscussion(db, ctx, discussionId);
      if (row) {
        await options.publish?.(ctx.workspaceId, { kind: "run.updated", runId }).catch(() => {});
        await changed(ctx, row.threadId, discussionId);
      }
      return { runId: asId<RunId>(runId) };
    },

    async update(ctx, discussionId, patch) {
      const moved = await updateDiscussion(db, ctx, discussionId, patch);
      if (!moved) return;
      const row = await getDiscussion(db, ctx, discussionId);
      if (row) await changed(ctx, row.threadId, discussionId);
    },
  };
  return service;
}
