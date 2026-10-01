import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { RouterContext } from "@/router-context";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

function CenteredMessage(props: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-3xl font-semibold">{props.title}</h1>
      {props.children}
    </main>
  );
}

function NotFound() {
  return (
    <CenteredMessage title="Page not found">
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link to="/" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
        Go to Home
      </Link>
    </CenteredMessage>
  );
}

function RootError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <CenteredMessage title="Something went wrong">
      <p className="max-w-md text-muted-foreground">
        {error instanceof Error ? error.message : "An unexpected error occurred."}
      </p>
      <Button variant="outline" onClick={() => router.invalidate()}>
        Try again
      </Button>
    </CenteredMessage>
  );
}
