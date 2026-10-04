import { useAgent, useUpdateAgent } from "@ofa/client";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AgentEditor, toRequest } from "@/components/agent-editor";
import { ErrorAlert } from "@/components/ui/alert";
import { toast } from "@/lib/toast";

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
  if (!agent) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the agent">
        <div className="skeleton h-10 w-64" />
        <div className="skeleton h-[480px] w-full rounded-xl" />
      </div>
    );
  }

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
        // What it was, so Undo can put it back (UX.15).
        const before = {
          name: agent.name,
          description: agent.description,
          spec: agent.spec,
          grants: agent.grants,
        };
        update.mutate(
          {
            name: request.name,
            description: request.description,
            spec: { ...agent.spec, ...request.spec },
            grants: request.grants,
          },
          {
            onSuccess: (saved) => {
              back();
              toast({
                message: `Saved ${saved.name}`,
                action: {
                  label: "Undo",
                  onClick: () =>
                    update.mutate(before, {
                      onSuccess: () => toast(`${agent.name} is back as it was`),
                      onError: (e) => toast({ message: e.message, tone: "error" }),
                    }),
                },
              });
            },
          },
        );
      }}
    />
  );
}
