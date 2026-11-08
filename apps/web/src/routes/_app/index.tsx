import { useAgents, useConversations, useLlmSettings } from "@ofa/client";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ConversationList } from "@/components/conversation-list";
import { SetupChecklist } from "@/components/setup-checklist";
import { useWide } from "@/lib/use-wide";

// Where the app opens (ADR-0052). On a phone, the conversations are the home
// screen. On a wide screen the sidebar already lists them, so this opens the
// latest one. A new workspace sees its setup checklist first.

export const Route = createFileRoute("/_app/")({
  staticData: { title: "Chats" },
  component: ChatsHome,
});

function ChatsHome() {
  const wide = useWide();
  const { data: agents, isPending: loadingAgents } = useAgents();
  const { data: llm } = useLlmSettings();
  const { data: conversations } = useConversations();
  const loading = !llm || loadingAgents;
  const hasKey = !!llm?.key.configured;
  const hasAgent = (agents?.length ?? 0) > 0;
  const ready = !loading && hasKey && hasAgent;
  const latest = conversations?.find((c) => c.kind === "group" || c.agentIds[0]);

  if (wide && ready && latest) {
    return latest.kind === "group" && latest.threadId ? (
      <Navigate to="/groups/$threadId" params={{ threadId: latest.threadId }} replace />
    ) : (
      <Navigate
        to="/agents/$agentId"
        params={{ agentId: latest.agentIds[0] ?? "" }}
        search={{}}
        replace
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!ready && (
        <div className="flex flex-col gap-4 md:pt-10">
          <h2 className="hidden text-[34px] leading-[1] font-extrabold tracking-[-0.03em] md:block">
            Welcome to One-for-All
          </h2>
          <SetupChecklist hasKey={hasKey} hasAgent={hasAgent} loading={loading} chip={false} />
        </div>
      )}
      {!wide && (
        <div className="-mx-2">
          <ConversationList variant="page" />
        </div>
      )}
      {wide && ready && !latest && (
        <p className="pt-16 text-center text-muted-foreground">Loading your chats…</p>
      )}
    </div>
  );
}
