import { useSession } from "@ofa/client";
import { createFileRoute, Navigate, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { loadSession, loadSetupStatus } from "@/lib/guards";

/** Layout for every signed-in page. Sends visitors to setup or login first. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const status = await loadSetupStatus(context);
    if (status.needsSetup) throw redirect({ to: "/setup" });
    const session = await loadSession(context);
    if (!session) {
      throw redirect({
        to: "/login",
        search: location.href === "/" ? {} : { redirect: location.href },
      });
    }
    return { session };
  },
  component: AppLayout,
});

function AppLayout() {
  // Live session from the cache: becomes null after sign-out or expiry.
  const { data: session } = useSession();
  const initial = Route.useRouteContext().session;
  if (session === null) return <Navigate to="/login" />;
  return (
    <AppShell session={session ?? initial}>
      <Outlet />
    </AppShell>
  );
}
