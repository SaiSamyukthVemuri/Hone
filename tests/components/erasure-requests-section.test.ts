import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErasureRequestsSection } from "@/app/(app)/settings/data/ErasureRequestsSection";
import type { ErasureRequestRow } from "@/lib/erasure/requests";

// What the owner actually sees (rendered output, not a source grep). Prepared, not wired.
const noop = async () => {};
const row = (id: string, client: string, state: ErasureRequestRow["state"]): ErasureRequestRow => ({ id, client_id: client, state, reason: "Asked in writing", requested_at: "2026-11-04T10:00:00Z" });
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const render = (requests: ErasureRequestRow[], clients = {}) => renderToStaticMarkup(createElement(ErasureRequestsSection, { requests, clients, onRequest: noop, onAdvance: noop, onWithdraw: noop, onCorrect: noop, onClear: noop }));

describe("erasure requests section (R5, prepared)", () => {
  it("says, above everything else, that recording a request deletes nothing and erasure is not available", () => {
    const html = render([]);
    expect(html).toContain("Recording a request deletes nothing. Erasure itself is not available yet.");
    expect(html.indexOf("deletes nothing")).toBeLessThan(html.indexOf("erasure-request-form"));
    expect(html).toContain("No erasure requests.");
  });
  it("the execution control is rendered DISABLED with its explanation, not hidden", () => {
    const html = render([row("r1", C1, "confirmed")]);
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="erasure-execute"|<button[^>]*data-testid="erasure-execute"[^>]*disabled/);
    expect(html).toContain("is not available yet. Recording a request does not start it");
    expect(html).toContain('aria-describedby="erasure-unavailable"');
  });
  it("each state offers only its own actions", () => {
    const html = (s: ErasureRequestRow["state"]) => render([row("r1", C1, s)]);
    expect(html("requested")).toContain("Start review");
    expect(html("requested")).toContain("Withdraw request");
    expect(html("requested")).not.toContain("Confirm request");
    expect(html("under_review")).toContain("Confirm request");
    expect(html("confirmed")).not.toContain("Start review");
    expect(html("confirmed")).not.toContain("Confirm request");
    expect(html("confirmed")).toContain("Withdraw request");
    expect(html("withdrawn")).not.toContain("Withdraw request");
    expect(html("withdrawn")).not.toContain("Start review");
  });
  it("a confirmed request is labelled as not erased; no state label claims a deletion", () => {
    expect(render([row("r1", C1, "confirmed")])).toContain("Recorded as confirmed. Nothing has been erased.");
  });
  it("clients appear by preferred name or 'Name on file'; the legal name never reaches the page", () => {
    const html = render([row("r1", C1, "requested"), row("r2", C2, "requested")], {
      [C1]: { preferred_name: "Jo", name: "Joanne Legalname" },
      [C2]: { preferred_name: null, name: "Another Legalname" },
    });
    expect(html).toContain(">Jo<");
    expect(html).toContain("Name on file");
    expect(html).not.toContain("Legalname");
  });
  it("the request form posts only the client and the reason; the studio is never a field", () => {
    const html = render([]);
    expect(html).toContain('name="client_id"');
    expect(html).toContain('name="reason"');
    expect(html).not.toMatch(/name="(studio|studio_id|requested_by|actor)"/);
    expect(html).toContain('maxLength="300"');
  });
  it("warns before the owner types, says the reason can be corrected, and offers a correct/clear form per row", () => {
    const html = render([row("r1", C1, "under_review")]);
    expect(html).toContain("Do not include personal details about the client here.");
    expect(html).toContain("correct or clear the reason");
    expect(html).toContain('data-testid="erasure-correct-form"');
    expect(html).toContain("Replace the reason");
    expect(html).not.toContain("leave blank");
    // Save requires text; clearing is its own control and is not offered once cleared (Privacy DP1, Insurance U-1).
    expect(html).toMatch(/id="erasure-correct-r1"[^>]*required/);
    expect(html).toContain('data-testid="erasure-clear-form"');
    expect(html).toContain("Clear reason");
    expect(render([{ ...row("r1", C1, "confirmed"), reason: null }])).not.toContain('data-testid="erasure-clear-form"');
  });
  it("a cleared reason is shown as cleared, never as blank or null", () => {
    const html = render([{ ...row("r1", C1, "confirmed"), reason: null }]);
    expect(html).toContain('data-testid="erasure-reason">Reason cleared<');
  });
  it("no retention period and no statement about backups appears anywhere on the section", () => {
    const text = render([row("r1", C1, "under_review")]).replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\b(\d+ (days?|weeks?|months?|years?)|retention|backups?)\b/i);
  });
});
