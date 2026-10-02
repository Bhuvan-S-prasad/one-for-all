import { useAgent, useUpdateAgent } from "@ofa/client";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AgentEditor, toRequest } from "@/components/agent-editor";
import { ErrorAlert } from "@/components/ui/alert";

export const Route = createFileRoute("/_app/agents/$agentId/edit")({
  staticData: { title: "Edit agent" },
  component: EditAgentPage,
});

function EditAgentPage() {
  const { agentId } = Route.useParams();
  const navigate = useNavigate();
  const { data: agent, error } = useAgent(agentId);
  const update = useUpdateAgent(agentId);
  const back = () => void navigate({ to: "/agents/$agentId", params: { agentId } });

  if (error) return <ErrorAlert>{error.message}</ErrorAlert>;
  if (!agent) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <AgentEditor
      mode="edit"
      initial={{
        name: agent.name,
        voice: agent.spec.voice,
        look: agent.spec.avatar,
        job: agent.spec.job,
        description: agent.description,
        tier: agent.spec.modelTier,
        tools: agent.grants.filter((g) => g.mode !== "blocked").map((g) => g.tool),
      }}
      saving={update.isPending}
      error={update.error}
      onCancel={back}
      onSave={(draft) => {
        const request = toRequest(draft);
        update.mutate(
          {
            name: request.name,
            description: request.description,
            spec: { ...agent.spec, ...request.spec },
            grants: request.grants,
          },
          { onSuccess: back },
        );
      }}
    />
  );
}
