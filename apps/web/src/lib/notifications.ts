import { useApprovals } from "@ofa/client";
import type { Agent, Approval } from "@ofa/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useStoredFlag } from "@/lib/shortcuts";
import { toast } from "@/lib/toast";

// Telling the person when an agent needs them (M4.08). A new approval request
// shows a toast wherever they are in the app, unless its chat is already in
// front of them; with the tab in the background, a desktop notification too,
// if they turned those on in Settings (kept per device, like the sidebar).

export const DESKTOP_NOTIFICATIONS_KEY = "ofa-desktop-notifications";

/** Whether this browser can show desktop notifications here (it needs https or localhost). */
export function desktopNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && window.isSecureContext;
}

export function useDesktopNotifications(): [boolean, (on: boolean) => void] {
  return useStoredFlag(DESKTOP_NOTIFICATIONS_KEY, false);
}

/** "Researcher needs you: send the email “Tuesday” to sam@example.com". */
export function alertText(approval: Approval, agentName: string): { title: string; body: string } {
  const first = approval.summary.split("\n")[0] ?? approval.tool;
  return {
    title: `${agentName} needs you`,
    body: `It wants to ${first.charAt(0).toLowerCase()}${first.slice(1)}`,
  };
}

/** Requests that arrived since `seen` was filled; the first list only fills it. */
export function newRequests(
  approvals: readonly Approval[],
  seen: Set<string> | null,
): { fresh: Approval[]; seen: Set<string> } {
  if (!seen) return { fresh: [], seen: new Set(approvals.map((a) => a.id)) };
  const fresh = approvals.filter((a) => !seen.has(a.id));
  for (const a of fresh) seen.add(a.id);
  return { fresh, seen };
}

export function useApprovalAlerts(agents: readonly Agent[] | undefined): void {
  const { data: approvals } = useApprovals();
  const navigate = useNavigate();
  const [desktop] = useDesktopNotifications();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!approvals) return;
    const result = newRequests(approvals, seen.current);
    seen.current = result.seen;
    for (const approval of result.fresh) {
      const agent = agents?.find((a) => a.id === approval.agentId);
      const { title, body } = alertText(approval, agent?.name ?? "An agent");
      const open = () =>
        void navigate({
          to: "/agents/$agentId",
          params: { agentId: approval.agentId },
          search: approval.threadId ? { thread: approval.threadId } : {},
        });
      const hidden = document.visibilityState === "hidden";
      const inChat = window.location.pathname === `/agents/${approval.agentId}`;
      if (!inChat || hidden) {
        toast({ message: `${title}. ${body}`, action: { label: "Review", onClick: open } });
      }
      if (hidden && desktop && desktopNotificationsSupported()) {
        if (Notification.permission !== "granted") continue;
        const note = new Notification(title, { body, tag: approval.id });
        note.onclick = () => {
          window.focus();
          open();
          note.close();
        };
      }
    }
  }, [approvals, agents, desktop, navigate]);
}
