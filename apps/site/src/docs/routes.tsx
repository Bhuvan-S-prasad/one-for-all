import { useParams } from "@tanstack/react-router";
import { DecisionPage, DecisionsIndex, EventsPage, WrittenPage } from "./views";

// The docs' route components, loaded as their own chunk so the landing page
// doesn't carry the docs and the decision records.

export function DocsHome() {
  return <WrittenPage slug="introduction" />;
}

export function DocsPage() {
  const { page } = useParams({ strict: false });
  return <WrittenPage key={page} slug={page ?? ""} />;
}

export function Decisions() {
  return <DecisionsIndex />;
}

export function Decision() {
  const { id } = useParams({ strict: false });
  return <DecisionPage key={id} id={id ?? ""} />;
}

export function Events() {
  return <EventsPage />;
}
export { NotFound } from "./views";
