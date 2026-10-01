import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "@/components/coming-soon";

export const Route = createFileRoute("/_app/activity")({
  staticData: { title: "Activity" },
  component: ActivityPage,
});

function ActivityPage() {
  return (
    <ComingSoon heading="Nothing has run yet">
      Every run will appear here as a timeline: model calls, tool calls, policy decisions and
      approvals, in order.
    </ComingSoon>
  );
}
