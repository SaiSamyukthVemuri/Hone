import { describe, expect, it } from "vitest";
import { ERASURE_DELETES_NOTHING, ERASURE_EXECUTION_UNAVAILABLE, ERASURE_STATE_LABEL, describeErasureRequest, erasureClientLabel, isUuid, validateErasureReason, type ErasureRequestRow } from "@/lib/erasure/requests";

const row = (state: ErasureRequestRow["state"]): ErasureRequestRow => ({ id: "11111111-1111-4111-8111-111111111111", client_id: "22222222-2222-4222-8222-222222222222", state, reason: "Asked in writing", requested_at: "2026-11-04T10:00:00Z" });

describe("erasure request copy and view model (R5, prepared)", () => {
  it("the contract sentences say deletion does not happen, promise no retention period and say nothing about backups", () => {
    expect(ERASURE_DELETES_NOTHING).toBe("Recording a request deletes nothing. Erasure itself is not available yet.");
    for (const t of [ERASURE_DELETES_NOTHING, ERASURE_EXECUTION_UNAVAILABLE, ...Object.values(ERASURE_STATE_LABEL)]) {
      expect(t, t).not.toMatch(/\b(days?|weeks?|months?|years?|retention|backups?)\b/i);
    }
    // No label claims a deletion happened; the confirmed label says the opposite.
    for (const t of [ERASURE_DELETES_NOTHING, ERASURE_EXECUTION_UNAVAILABLE, ERASURE_STATE_LABEL.requested, ERASURE_STATE_LABEL.under_review, ERASURE_STATE_LABEL.withdrawn]) {
      expect(t, t).not.toMatch(/\b(erased|deleted|removed)\b/i);
    }
    expect(ERASURE_STATE_LABEL.confirmed).toContain("Nothing has been erased");
  });
  it("offers exactly one forward step per open state, and none from confirmed or withdrawn", () => {
    expect(describeErasureRequest(row("requested")).next).toEqual({ to: "under_review", label: "Start review" });
    expect(describeErasureRequest(row("under_review")).next).toEqual({ to: "confirmed", label: "Confirm request" });
    expect(describeErasureRequest(row("confirmed")).next).toBeNull();
    expect(describeErasureRequest(row("withdrawn")).next).toBeNull();
  });
  it("withdrawal is offered from every open state and never from a withdrawn request", () => {
    expect(["requested", "under_review", "confirmed"].every((s) => describeErasureRequest(row(s as ErasureRequestRow["state"])).canWithdraw)).toBe(true);
    expect(describeErasureRequest(row("withdrawn")).canWithdraw).toBe(false);
  });
  it("a client is shown by preferred name, else 'Name on file': the legal name is never put in a list", () => {
    expect(erasureClientLabel({ preferred_name: " Jo ", name: "Joanne Legalname" })).toBe("Jo");
    expect(erasureClientLabel({ preferred_name: null, name: "Joanne Legalname" })).toBe("Name on file");
    expect(erasureClientLabel({ preferred_name: "  ", name: "Joanne Legalname" })).toBe("Name on file");
    expect(erasureClientLabel(undefined)).toBe("Unknown client");
  });
  it("reason: required, trimmed, bounded at 300", () => {
    expect(validateErasureReason("  why  ")).toEqual({ ok: true, reason: "why" });
    for (const bad of ["", "   ", null, undefined, 5, "x".repeat(301)]) expect(validateErasureReason(bad).ok, String(bad)).toBe(false);
    expect(validateErasureReason("x".repeat(300)).ok).toBe(true);
  });
  it("isUuid accepts a uuid and nothing else", () => {
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    for (const bad of ["", "not-a-uuid", "11111111-1111-4111-8111-11111111111", null, 1, "'; drop table clients; --"]) expect(isUuid(bad), String(bad)).toBe(false);
  });
});
