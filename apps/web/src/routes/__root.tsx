import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import type { FamiliarLook, FamiliarMood } from "@ofa/contracts";
import type { ReactNode } from "react";
import { Familiar } from "@/components/familiar";
import { Button } from "@/components/ui/button";
import { HOUSEHOLD } from "@/lib/familiars";
import type { RouterContext } from "@/router-context";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

function CenteredMessage(props: {
  title: string;
  familiar: FamiliarLook;
  mood: FamiliarMood;
  children: ReactNode;
}) {
  return (
    <main className="bg-dots flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <Familiar look={props.familiar} mood={props.mood} gaze="auto" size={160} />
      <h1 className="text-5xl leading-[0.95] font-extrabold tracking-[-0.04em]">{props.title}</h1>
      {props.children}
    </main>
  );
}

function NotFound() {
  return (
    <CenteredMessage title="Page not found" familiar={HOUSEHOLD.sentinel} mood="idle">
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link
        to="/"
        className="text-sm font-semibold text-highlight underline-offset-4 hover:underline"
      >
        Go to Home
      </Link>
    </CenteredMessage>
  );
}

function RootError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <CenteredMessage title="Something went wrong" familiar={HOUSEHOLD.inbox} mood="error">
      <p className="max-w-md text-muted-foreground">
        {error instanceof Error ? error.message : "An unexpected error occurred."}
      </p>
      <Button variant="outline" onClick={() => router.invalidate()}>
        Try again
      </Button>
    </CenteredMessage>
  );
}
