import { useLogout } from "@ofa/client";
import { useNavigate } from "@tanstack/react-router";

/** Sign out, then go to the login page. */
export function useSignOut(): { signOut: () => void; pending: boolean } {
  const logout = useLogout();
  const navigate = useNavigate();
  return {
    signOut: () => logout.mutate(undefined, { onSuccess: () => navigate({ to: "/login" }) }),
    pending: logout.isPending,
  };
}
