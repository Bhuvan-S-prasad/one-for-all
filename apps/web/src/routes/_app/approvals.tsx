import { useAgents, useApprovals } from "@ofa/client";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApprovalCard } from "@/components/approval-card";
import { ComingSoon } from "@/components/coming-soon";
import { Familiar } from "@/components/familiar";
import { ErrorAlert } from "@/components/ui/alert";
import { HOUSEHOLD } from "@/lib/familiars";
import { shortTime } from "@/lib/format";

// Every request waiting for a person, newest first, answered in place. The
// same cards appear in each agent's chat while its run waits.

export const Route = createFileRoute("/_app/approvals")({
  staticData: { title: "Approvals" },
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const { data: approvals, isPending, error } = useApprovals();
  const { data: agents } = useAgents();

  if (error) return <ErrorAlert>{error.message}</ErrorAlert>;
  if (isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading approvals">
        {[0, 1].map((i) => (
          <div key={i} className="skeleton h-36 w-full rounded-[18px]" />
        ))}
      </div>
    );
  }
  if (!approvals?.length) {
    return (
      <ComingSoon
        familiar={HOUSEHOLD.inbox}
        mood="idle"
        badge="All clear"
        heading="No approvals waiting"
      >
        When an agent wants to do something that needs your OK, such as clicking on a site after
        reading outside content, the request waits here and in its chat.
      </ComingSoon>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        {approvals.length === 1
          ? "One request is waiting for you."
          : `${approvals.length} requests are waiting for you.`}{" "}
        Each agent waits until you answer.
      </p>
      {approvals.map((approval) => {
        const agent = agents?.find((a) => a.id === approval.agentId);
        const name = agent?.name ?? "An agent";
        return (
          <article key={approval.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              {agent && <Familiar look={agent.spec.avatar} size={22} ring="var(--background)" />}
              <span className="font-semibold text-foreground">{name}</span>
              <span aria-hidden>·</span>
              <span>asked at {shortTime(approval.createdAt)}</span>
              {agent && (
                <Link
                  to="/agents/$agentId"
                  params={{ agentId: agent.id }}
                  search={approval.threadId ? { thread: approval.threadId } : {}}
                  className="ml-auto underline-offset-2 hover:underline"
                >
                  Open the chat
                </Link>
              )}
            </div>
            <ApprovalCard approval={approval} agent={{ name }} />
          </article>
        );
      })}
    </div>
  );
}
