import type { Approval } from "@ofa/contracts";
import { describe, expect, it } from "vitest";
import { alertText, newRequests } from "./notifications";

const approval = (id: string, summary = "Send the email “Tuesday” to sam@example.com") =>
  ({ id, summary, tool: "gmail.send_draft" }) as Approval;

describe("approval alerts", () => {
  it("alerts only for requests that arrive after the first list", () => {
    const first = newRequests([approval("a")], null);
    expect(first.fresh).toEqual([]);
    const next = newRequests([approval("b"), approval("a")], first.seen);
    expect(next.fresh.map((a) => a.id)).toEqual(["b"]);
    // Shown once: still there on the next refresh, no second alert.
    expect(newRequests([approval("b"), approval("a")], next.seen).fresh).toEqual([]);
  });

  it("says who needs you and what for", () => {
    expect(alertText(approval("a"), "Mailroom")).toEqual({
      title: "Mailroom needs you",
      body: "It wants to send the email “Tuesday” to sam@example.com",
    });
  });
});
