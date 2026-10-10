import { useState } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { desktopNotificationsSupported, useDesktopNotifications } from "@/lib/notifications";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// When an agent needs you (M4.08): inside the app a toast always says so;
// desktop notifications reach you with the tab in the background. They are
// per device and need the browser's permission.

export function NotificationsCard() {
  const [on, setOn] = useDesktopNotifications();
  const supported = desktopNotificationsSupported();
  const [permission, setPermission] = useState(() =>
    supported ? Notification.permission : "denied",
  );
  const active = on && permission === "granted";

  const toggle = async () => {
    if (active) return setOn(false);
    const answer =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    setPermission(answer);
    if (answer === "granted") {
      setOn(true);
      toast("Desktop notifications are on for this browser");
    } else {
      toast({
        message: "The browser blocked notifications. Allow them for this site in its settings.",
        tone: "error",
      });
    }
  };

  return (
    <Card className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <CardTitle>Notifications</CardTitle>
        <p className="text-sm text-muted-foreground">
          When an agent needs you, the app shows it wherever you are. Desktop notifications also
          reach you when this tab is in the background, on this device only.
        </p>
        {!supported && (
          <p className="text-sm text-muted-foreground">
            Not available at this address: browsers allow them only over https or on this computer.
          </p>
        )}
        {supported && permission === "denied" && (
          <p className="text-sm text-muted-foreground">
            Blocked by the browser. Allow notifications for this site in its settings, then try
            again.
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label="Desktop notifications"
        disabled={!supported}
        onClick={() => void toggle()}
        className={cn(
          "eyebrow h-9 w-16 shrink-0 self-start rounded-full text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:self-center",
          active ? "bg-primary text-primary-foreground" : "border text-muted-foreground",
        )}
      >
        {active ? "On" : "Off"}
      </button>
    </Card>
  );
}
