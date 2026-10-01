import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "@/components/coming-soon";
import { HOUSEHOLD } from "@/lib/familiars";

export const Route = createFileRoute("/_app/activity")({
  staticData: { title: "Activity" },
  component: ActivityPage,
});

function ActivityPage() {
  return (
    <ComingSoon familiar={HOUSEHOLD.ledger} mood="asleep" heading="Nothing has run yet">
      Every run will appear here as a timeline: model calls, tool calls, policy decisions and
      approvals, in order.
    </ComingSoon>
  );
}
