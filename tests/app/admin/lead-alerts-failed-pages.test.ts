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

// Codex P2 4276616247: an alert that MAY already have been sent is not offered
// a silent Retry; the console says so and asks for an explicit confirmation.
describe("possible duplicates are said out loud", () => {
  const one = (code: string, attempts: number): LeadAlertsView => ({
    ...view(1, 1),
    failed: [{ ...failedRow(0), last_error_code: code, attempt_count: attempts }],
  });

  it.each([
    ["provider_timeout", 5],
    ["provider_exception", 3],
    ["provider_unavailable", 5],
    ["lease_expired", 5],
    ["expired", 2],
  ])("%s (%i attempts): a warning and 'Send again anyway', which carries the confirmation", (code, attempts) => {
    const html = render(one(code, attempts));
    expect(html).toContain('data-testid="lead-alert-possible-duplicate"');
    expect(html).toContain("may already have reached the operator inbox");
    expect(html).toContain('name="confirm_possible_duplicate" value="yes"');
    expect(html).toContain("Send again anyway");
    expect(html).not.toContain(">Retry<");
  });

  it.each([
    ["provider_rejected", 1],
    ["recipient_changed", 1],
    ["render_failed", 1],
    ["expired", 0],
  ])("%s (%i attempts): a plain Retry, no confirmation", (code, attempts) => {
    const html = render(one(code, attempts));
    expect(html).toContain(">Retry<");
    expect(html).not.toContain("confirm_possible_duplicate");
    expect(html).not.toContain("Send again anyway");
  });
});

// Codex P2 4276835172: every failed row links to its own lead, so the
// operator can reconcile the right message before accepting a duplicate risk.
describe("each failed alert links to its lead", () => {
  it("a demo request row links to /admin/leads/demo-request/<id>", () => {
    const html = render({ ...view(1, 1), failed: [{ ...failedRow(0), demo_request_id: "11111111-1111-4111-8111-111111111111", last_error_code: "provider_timeout" }] });
    expect(html).toContain('href="/admin/leads/demo-request/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('data-testid="lead-alert-failed-lead-link"');
  });

  it("an early-access row links to /admin/leads/early-access/<id>", () => {
    const html = render({
      ...view(1, 1),
      failed: [{ ...failedRow(0), lead_kind: "early_access", demo_request_id: null, waitlist_id: "22222222-2222-4222-8222-222222222222" }],
    });
    expect(html).toContain('href="/admin/leads/early-access/22222222-2222-4222-8222-222222222222"');
  });

  it("every row on a full page has its own link", () => {
    const html = render(view(1, 23));
    expect(html.match(/data-testid="lead-alert-failed-lead-link"/g)).toHaveLength(10);
  });
});
