import { useAgent, useAgents, useShareLogin, useUpdateAgent } from "@ofa/client";
import type { Agent } from "@ofa/contracts";
import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AgentEditor, toRequest } from "@/components/agent-editor";
import { usesBrowser } from "@/components/computer/computer-panel";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <div className="flex flex-col gap-4">
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
      {usesBrowser(agent) && <ShareLoginCard agent={agent} />}
    </div>
  );
}

/**
 * Share one site's login from this agent's browser with another agent's
 * (ADR-0010). Each agent's logins are its own until a person does this.
 */
function ShareLoginCard({ agent }: { agent: Agent }) {
  const { data: agents } = useAgents();
  const share = useShareLogin(agent.id);
  const others = (agents ?? []).filter((a) => a.id !== agent.id && usesBrowser(a));
  const [site, setSite] = useState("");
  const [to, setTo] = useState("");
  const target = others.find((a) => a.id === to) ?? others[0];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!site.trim() || !target) return;
    share.mutate(
      { to: target.id, site: site.trim() },
      {
        onSuccess: ({ cookies }) =>
          toast(
            cookies
              ? `${target.name} is now signed in to ${site.trim()} like ${agent.name}`
              : `${agent.name} isn't signed in to ${site.trim()}, so there was nothing to share`,
          ),
        onError: (e) => toast({ message: e.message, tone: "error" }),
      },
    );
  };

  return (
    <Card className="flex flex-col gap-4 px-6 py-5">
      <div className="flex flex-col gap-1">
        <CardTitle>Share a login</CardTitle>
        <p className="text-sm text-muted-foreground">
          {agent.name}'s browser logins are its own. Copy one site's login to another agent only if
          that agent should act as you there too.
        </p>
      </div>
      {others.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No other agent can use a browser yet. Turn on &ldquo;Use a browser&rdquo; for one first.
        </p>
      ) : (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="share-site">Site</Label>
            <Input
              id="share-site"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="github.com"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="share-to">With</Label>
            <select
              id="share-to"
              value={target?.id ?? ""}
              onChange={(e) => setTo(e.target.value)}
              className="h-13 rounded-md border border-input bg-field px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            >
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={share.isPending || !site.trim()}>
            Share login
          </Button>
        </form>
      )}
    </Card>
  );
}
