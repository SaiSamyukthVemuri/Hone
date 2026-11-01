import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsAttentionPanel } from "@/app/(app)/dashboard/needs-attention-panel";
import type { NeedsAttention } from "@/lib/dashboard/needs-attention-model";

// "Errors are never shown as zero": an unreadable check must not render the
// all-clear. Synthetic data only.

const empty: NeedsAttention = {
  clients: [],
  studioItems: [],
  itemCount: 0,
  entries: [],
  issueCount: 0,
  others: [],
  notReturnedCount: 0,
  unavailableChecks: [],
  detailsWindow: null,
};
const html = (n: NeedsAttention) =>
  renderToStaticMarkup(createElement(NeedsAttentionPanel, { needs: n }));

describe("Needs attention honest states", () => {
  it("a genuinely empty list says nothing needs attention", () => {
    expect(html(empty)).toContain("Nothing needs attention right now");
  });

  it("an unreadable check on an otherwise empty list is NOT the all-clear", () => {
    const out = html({ ...empty, unavailableChecks: ["payment setup"] });
    expect(out).toContain("Could not check payment setup");
    expect(out).toContain("may be incomplete");
    expect(out).not.toContain("Nothing needs attention right now");
  });

  it("an unreadable check is stated above a non-empty list", () => {
    const out = html({
      ...empty,
      unavailableChecks: ["payment setup"],
      issueCount: 1,
      itemCount: 1,
      clients: [
        {
          clientId: "c1",
          clientName: "Client One",
          tier: "preparation",
          occurredAt: null,
          sharesNameWithAnotherClient: false,
          items: [
            { id: "intake:c1:intake_review", kind: "intake_review", label: "Intake awaiting review", detail: null, href: "/clients/c1", actionLabel: "Review intake" },
          ],
        },
      ],
      entries: [
        {
          id: "intake:c1",
          scope: "intake",
          tier: "preparation",
          clientId: "c1",
          clientName: "Client One",
          occurredAt: null,
          issues: [
            { kind: "intake_review", label: "Intake awaiting review", href: "/clients/c1", actionLabel: "Review intake" },
          ],
        },
      ],
    });
    expect(out).toContain("Client One");
    expect(out.indexOf("Could not check")).toBeLessThan(out.indexOf("Client One"));
  });

  it("the page marks a failed payment read as unavailable, not as no item", () => {
    // Source pin on the loader contract.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require("node:fs").readFileSync("app/(app)/dashboard/page.tsx", "utf8") as string;
    const fn = src.slice(src.indexOf("async function loadPaymentStatus"));
    expect(fn.slice(0, fn.indexOf("const row = "))).toContain("return CHECK_UNAVAILABLE;");
  });

  it("N3: prints the window the details check covers, on the empty state and under a list", () => {
    const empty100 = html({ ...empty, detailsWindow: 100 });
    expect(empty100).toContain("most recent 100 charted sessions");
    expect(empty100).toContain("Nothing needs attention right now");
    expect(html({ ...empty, detailsWindow: null })).not.toContain("charted sessions");
  });
});

describe("Needs attention truncation note", () => {
  it("anything capped away is never an all-clear, even with nothing to list", () => {
    const out = html({ ...empty, notReturnedCount: 3 });
    expect(out).toContain("Older items beyond this list are not included");
    expect(out).not.toContain("Nothing needs attention right now");
  });
  it("nothing capped and nothing listed is the all-clear", () => {
    expect(html(empty)).toContain("Nothing needs attention right now");
  });
});
