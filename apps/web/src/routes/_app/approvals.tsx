import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "@/components/coming-soon";

export const Route = createFileRoute("/_app/approvals")({
  staticData: { title: "Approvals" },
  component: ApprovalsPage,
});

function ApprovalsPage() {
  return (
    <ComingSoon heading="No approvals waiting">
      When an agent wants to do something you marked “ask first”, such as sending an email, the
      request waits here for you.
    </ComingSoon>
  );
}
