import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// LEAD-ALERT-01 (#826), Codex P2 4243922097: every failed alert stays
// reachable for Retry. The list pages, it never silently truncates.

vi.mock("@/app/admin/actions", () => ({ retryLeadAlertAction: async () => undefined }));

import {
  FAILED_PAGE_SIZE,
  failedPageFrom,
  LeadAlertsCard,
  type LeadAlertRow,
  type LeadAlertsView,
} from "@/app/admin/lead-alerts";

const failedRow = (i: number): LeadAlertRow => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  lead_kind: "demo_request",
  demo_request_id: `d${i}`,
  waitlist_id: null,
  status: "failed",
  attempt_count: 5,
  next_attempt_at: "2026-10-12T00:00:00Z",
  accepted_at: null,
  failed_at: "2026-10-12T00:00:00Z",
  last_error_code: "provider_rejected",
  last_error_at: "2026-10-12T00:00:00Z",
  created_at: "2026-10-12T00:00:00Z",
});

function view(page: number, total: number): LeadAlertsView {
  const from = (page - 1) * FAILED_PAGE_SIZE;
  const shown = Math.max(0, Math.min(FAILED_PAGE_SIZE, total - from));
  return {
    loadError: false,
    failedPage: page,
    byDemoRequest: new Map(),
    byWaitlist: new Map(),
    counts: { pending: 0, sending: 0, accepted: 0, failed: total },
    failed: Array.from({ length: shown }, (_, i) => failedRow(from + i)),
  };
}

const render = (v: LeadAlertsView) =>
  renderToStaticMarkup(createElement(LeadAlertsCard, { config: { state: "ready", maskedRecipient: "o•••@h•••.example" }, view: v }));

describe("the failed list pages instead of truncating", () => {
  it("page 1 of 23: ten Retry forms and a link to older ones", () => {
    const html = render(view(1, 23));
    expect(html.match(/name="id"/g)).toHaveLength(10);
    expect(html).toContain("Showing 1–10 of 23");
    expect(html).toContain("leadAlertsFailedPage=2#lead-alerts");
    expect(html).not.toContain(">Newer<");
  });

  it("the last page reaches the 21st to 23rd failures, with Retry for each", () => {
    const html = render(view(3, 23));
    expect(html.match(/name="id"/g)).toHaveLength(3);
    expect(html).toContain("Showing 21–23 of 23");
    expect(html).toContain("leadAlertsFailedPage=2#lead-alerts");
    expect(html).not.toContain(">Older<");
    expect(html).toContain(failedRow(22).id);
  });

  it("a page past the end still offers the way back", () => {
    const html = render(view(9, 23));
    expect(html).toContain("leadAlertsFailedPage=8#lead-alerts");
  });

  it("the page number comes only from a bounded integer", () => {
    expect(failedPageFrom(undefined)).toBe(1);
    expect(failedPageFrom("3")).toBe(3);
    expect(failedPageFrom(["4", "5"])).toBe(4);
    for (const bad of ["0", "-2", "abc", "1e9", "99999"]) expect(failedPageFrom(bad), bad).toBe(1);
  });
});
