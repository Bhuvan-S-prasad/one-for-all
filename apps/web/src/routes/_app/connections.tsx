import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "@/components/coming-soon";

export const Route = createFileRoute("/_app/connections")({
  staticData: { title: "Connections" },
  component: ConnectionsPage,
});

function ConnectionsPage() {
  return (
    <ComingSoon heading="Nothing connected">
      Add your OpenRouter key, MCP servers, apps like Gmail and GitHub, and channels like Telegram
      and Slack.
    </ComingSoon>
  );
}
