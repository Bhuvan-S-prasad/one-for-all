import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "@/components/coming-soon";

export const Route = createFileRoute("/_app/agents")({
  staticData: { title: "Agents" },
  component: AgentsPage,
});

function AgentsPage() {
  return (
    <ComingSoon heading="No agents yet">
      Each agent does one job, with its own sandboxed computer, the tools you grant it, memory and
      routines.
    </ComingSoon>
  );
}
