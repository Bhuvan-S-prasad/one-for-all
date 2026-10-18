import { RUN_EVENT_TYPES } from "@ofa/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { inlineText, parseMarkdown } from "@/lib/markdown";
import { repoFile } from "@/lib/site";
import { decisionById, DECISIONS } from "./decisions";
import { DocsFrame, type TocEntry } from "./layout";
import { headingIds, MarkdownView } from "./markdown-view";
import { pageBySlug } from "./pages";

// The docs' pages: a written page, the decision index, one decision, and the
// run events read from the contracts.

function useMarkdown(source: string) {
  return useMemo(() => {
    const blocks = parseMarkdown(source);
    const ids = headingIds(blocks);
    const toc: TocEntry[] = [];
    for (const b of blocks) {
      const id = ids.get(b);
      if (id && b.type === "heading")
        toc.push({ id, text: inlineText(b.children), level: b.level });
    }
    return { blocks, toc };
  }, [source]);
}

export function NotFound() {
  return (
    <DocsFrame slug="" title="Not here" summary="There is no page at this address.">
      <p className="text-[17px]">
        Go back to the{" "}
        <Link to="/docs" className="underline decoration-primary decoration-2 underline-offset-4">
          start of the docs
        </Link>
        .
      </p>
    </DocsFrame>
  );
}

export function WrittenPage({ slug }: { slug: string }) {
  const page = pageBySlug.get(slug);
  const { blocks, toc } = useMarkdown(page?.source ?? "");
  if (!page?.source) return <NotFound />;
  return (
    <DocsFrame slug={page.slug} title={page.title} summary={page.summary} toc={toc}>
      <MarkdownView blocks={blocks} />
    </DocsFrame>
  );
}

export function DecisionsIndex() {
  const page = pageBySlug.get("decisions")!;
  const areas = [...new Set(DECISIONS.map((d) => d.area))];
  return (
    <DocsFrame
      slug="decisions"
      title={page.title}
      summary={`${DECISIONS.length} records. Each says what problem it answered, what was decided, what was rejected, and what it costs.`}
      toc={areas.map((a) => ({ id: a.toLowerCase(), text: a, level: 2 }))}
    >
      <p className="text-[17px] leading-[1.7]">
        A decision record is written whenever an architectural choice is made or changed, and a
        newer record supersedes an older one rather than editing it. They are read here straight
        from the repository’s{" "}
        <code className="rounded-[6px] bg-popover px-1.5 py-0.5 font-mono text-[0.86em]">
          docs/adr
        </code>{" "}
        folder.
      </p>
      {areas.map((area) => (
        <section key={area} className="mt-14">
          <h2 id={area.toLowerCase()} className="mb-5 scroll-mt-24 text-[32px] font-bold">
            {area}
          </h2>
          <ul className="flex flex-col gap-2">
            {DECISIONS.filter((d) => d.area === area).map((d) => (
              <li key={d.id}>
                <Link
                  to="/docs/decisions/$id"
                  params={{ id: d.id }}
                  className="group grid grid-cols-[56px_1fr] items-baseline gap-4 rounded-[16px] px-4 py-3 transition-colors hover:bg-card"
                >
                  <span className="text-[15px] text-muted-foreground tabular-nums">{d.id}</span>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[17px] leading-snug font-semibold group-hover:text-foreground">
                      {d.title}
                    </span>
                    {!d.status.startsWith("Accepted") && (
                      <span className="text-[14px] text-muted-foreground">{d.status}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </DocsFrame>
  );
}

export function DecisionPage({ id }: { id: string }) {
  const decision = decisionById.get(id);
  const { blocks, toc } = useMarkdown(decision?.body ?? "");
  if (!decision) return <NotFound />;
  const i = DECISIONS.indexOf(decision);
  const prev = DECISIONS[i - 1];
  const next = DECISIONS[i + 1];
  return (
    <DocsFrame
      slug="decisions"
      title={decision.title}
      summary={`Decision ${decision.id} · ${decision.area} · ${decision.status} · ${decision.date}`}
      toc={toc}
    >
      <MarkdownView blocks={blocks} />
      <div className="mt-16 flex flex-wrap items-center justify-between gap-4 text-[15px]">
        <a
          href={repoFile(`docs/adr/${decision.file}`)}
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          This record on GitHub
        </a>
        <span className="flex gap-2">
          {prev && (
            <Link
              to="/docs/decisions/$id"
              params={{ id: prev.id }}
              className="rounded-full bg-card px-4 py-2 hover:bg-popover"
            >
              ← {prev.id}
            </Link>
          )}
          {next && (
            <Link
              to="/docs/decisions/$id"
              params={{ id: next.id }}
              className="rounded-full bg-card px-4 py-2 hover:bg-popover"
            >
              {next.id} →
            </Link>
          )}
        </span>
      </div>
    </DocsFrame>
  );
}

const EVENT_NOTES: Record<string, string> = {
  "run.started": "A run began: what started it and which model tier it uses.",
  "run.waiting":
    "The run is waiting: for a person's approval, or for model capacity, until a time.",
  "run.resumed": "The wait is over and the run carries on.",
  "run.tainted":
    "The run read outside content; outbound actions now need approval. Says where it came from.",
  "run.compacted": "Older turns were turned into notes to make room: tokens before and after.",
  "run.steered": "A message the person sent while the run worked joined it at a step boundary.",
  "check.quiet": "A quiet check found nothing to report, so nothing was posted.",
  "run.ended": "The run ended: how (an answer, a budget, a loop, a stop) and its usage.",
  "model.called":
    "A model call: the model, the prompt versions, tokens in and out, and how long it took.",
  "model.failed": "A model call failed, and whether the gateway will retry another model.",
  "message.created": "The run posted a message in the chat.",
  "tool.called": "A tool call, with its arguments and its idempotency key.",
  "policy.decided": "The policy engine's verdict on a call, and why.",
  "approval.requested": "A call is held for a person: the approval card it made.",
  "approval.decided": "The person's answer: approved, edited, rejected, or expired.",
  "tool.completed":
    "A call finished: how long it took, whether its result was outside content, a preview.",
  "tool.failed": "A call failed, with a code and a message the model reads.",
  "tool.reused":
    "The same search again in this run: its earlier result was given back, and nothing ran.",
  "memory.written": "A fact was saved, and whether it is verified.",
  "delegation.started": "Work handed to another agent: who, and the child run.",
  "delegation.finished": "The handoff came back: its status.",
};

export function EventsPage() {
  const page = pageBySlug.get("events")!;
  return (
    <DocsFrame slug="events" title={page.title} summary={page.summary}>
      <p className="text-[17px] leading-[1.7]">
        Every run writes these events, in order, and never changes one once written. Each carries a
        key chosen by its writer, so a retried step never writes twice. Activity, the step trail
        under each reply, traces and evals all read this log. The list below is read from the
        schemas in{" "}
        <code className="rounded-[6px] bg-popover px-1.5 py-0.5 font-mono text-[0.86em]">
          @ofa/contracts
        </code>
        , so it is always the current set.
      </p>
      <div className="my-8 overflow-x-auto rounded-[16px] bg-card">
        <table className="w-full text-[15px]">
          <thead>
            <tr>
              <th
                /* taste-skill-ignore: a real table */ className="border-b border-border px-4 py-3 text-left font-semibold"
              >
                Event
              </th>
              <th
                /* taste-skill-ignore: a real table */ className="border-b border-border px-4 py-3 text-left font-semibold"
              >
                Means
              </th>
            </tr>
          </thead>
          <tbody>
            {RUN_EVENT_TYPES.map((type) => (
              <tr
                key={type}
                /* taste-skill-ignore: a real table */ className="border-b border-border last:border-0"
              >
                <td className="px-4 py-3 align-top whitespace-nowrap">
                  <code className="font-mono text-[13.5px]">{type}</code>
                </td>
                <td className="px-4 py-3">{EVENT_NOTES[type] ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DocsFrame>
  );
}
