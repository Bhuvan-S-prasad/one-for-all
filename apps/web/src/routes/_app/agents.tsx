import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "@/components/coming-soon";
import { HOUSEHOLD } from "@/lib/familiars";

export const Route = createFileRoute("/_app/agents")({
  staticData: { title: "Agents" },
  component: AgentsPage,
});

function AgentsPage() {
  return (
    <ComingSoon familiar={HOUSEHOLD.scout} mood="idle" heading="No agents yet">
      Each agent does one job, with its own sandboxed computer, the tools you grant it, memory and
      routines.
    </ComingSoon>
  );
}
