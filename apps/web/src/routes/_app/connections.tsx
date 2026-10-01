import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "@/components/coming-soon";
import { HOUSEHOLD } from "@/lib/familiars";

export const Route = createFileRoute("/_app/connections")({
  staticData: { title: "Connections" },
  component: ConnectionsPage,
});

function ConnectionsPage() {
  return (
    <ComingSoon familiar={HOUSEHOLD.tinker} mood="thinking" heading="Nothing connected">
      Add your OpenRouter key, MCP servers, apps like Gmail and GitHub, and channels like Telegram
      and Slack.
    </ComingSoon>
  );
}
