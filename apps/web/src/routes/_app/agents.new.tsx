import { useCreateAgent } from "@ofa/client";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AgentEditor, randomLook, toRequest, type AgentDraft } from "@/components/agent-editor";
import { BUILTIN_TOOLS } from "@/lib/agents";

export const Route = createFileRoute("/_app/agents/new")({
  staticData: { title: "Hatch an agent" },
  component: HatchPage,
});

function HatchPage() {
  const navigate = useNavigate();
  const create = useCreateAgent();
  // Each visit starts from a fresh random familiar.
  const [initial] = useState<AgentDraft>(() => ({
    name: "",
    voice: "calm",
    look: randomLook(),
    job: "",
    description: "",
    tier: "standard",
    tools: BUILTIN_TOOLS.map((t) => t.name),
  }));

  return (
    <AgentEditor
      mode="hatch"
      initial={initial}
      saving={create.isPending}
      error={create.error}
      onCancel={() => void navigate({ to: "/agents" })}
      onSave={(draft) =>
        create.mutate(toRequest(draft), {
          onSuccess: (agent) =>
            void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } }),
        })
      }
    />
  );
}
