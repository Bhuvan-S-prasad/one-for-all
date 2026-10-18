import { useTeamRoster } from "@ofa/client";
import type { AgentGrant } from "@ofa/contracts";

// What a coordinator sees of its team (ADR-0044, TC.07): each other active
// agent with what it can do, from its grants, and which of the coordinator's
// own tools are left to a teammate. Live: the server builds the same cards
// the model reads.

/** Whether a grant rule covers a tool: its exact name, or its app's `app.*`. */
function grants(rules: readonly AgentGrant[], tool: string): boolean {
  return rules.some(
    (g) =>
      g.mode !== "blocked" &&
      (g.tool === tool || (g.tool.endsWith(".*") && tool.startsWith(g.tool.slice(0, -1)))),
  );
}

export function TeamPreview(props: {
  agentId?: string;
  agentName: string;
  /** Built-in tools switched on in the editor. */
  tools: readonly string[];
  grants: readonly AgentGrant[];
}) {
  const roster = useTeamRoster();
  const team = (roster.data ?? []).filter((m) => m.id !== props.agentId);
  const own: AgentGrant[] = [
    ...props.tools.map((tool) => ({ tool, mode: "auto" as const })),
    ...props.grants,
  ];
  // Tool → the teammates that have it, for the coordinator's own tools only.
  const hidden = new Map<string, string[]>();
  for (const member of team) {
    for (const card of member.capabilities) {
      for (const tool of card.tools) {
        if (!grants(own, tool)) continue;
        hidden.set(tool, [...(hidden.get(tool) ?? []), member.slug]);
      }
    }
  }

  return (
    <section aria-labelledby="team-preview" className="flex flex-col gap-2">
      <h4 id="team-preview" className="eyebrow text-xs text-muted-foreground">
        What {props.agentName} sees of its team
      </h4>
      {roster.isPending ? (
        <p className="text-sm text-muted-foreground">Loading the team…</p>
      ) : roster.isError ? (
        <p className="text-sm text-destructive">Couldn't load the team.</p>
      ) : team.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No other active agents yet, so it works alone until you hatch some.
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y rounded-md border">
            {team.map((member) => (
              <li key={member.id} className="flex flex-col gap-0.5 px-4 py-3">
                <span>
                  <span className="font-semibold">{member.name}</span>{" "}
                  <span className="font-mono text-xs text-muted-foreground">@{member.slug}</span>
                </span>
                <span className="text-sm text-muted-foreground">{member.job}</span>
                <span className="text-sm">
                  {member.capabilities.length
                    ? member.capabilities
                        .map((c) => `${c.area}: ${c.abilities.join(", ")}`)
                        .join(" · ")
                    : "No tools; answers from what it knows"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            {hidden.size
              ? `Left to its team, so ${props.agentName} won't use them itself: ${[...hidden]
                  .map(([tool, who]) => `${tool} (${who.map((s) => `@${s}`).join(", ")})`)
                  .join(", ")}.`
              : `None of ${props.agentName}'s own tools are left to a teammate.`}
          </p>
        </>
      )}
    </section>
  );
}
