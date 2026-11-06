import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESOLVED_CLEAR_CAP, resolvedStudioDismissalKeys } from "@/lib/dashboard/needs-attention-visibility";
import type { NeedsAttention } from "@/lib/dashboard/needs-attention-model";

// Privacy AP2 (#1357): a studio reminder's dismissal is cleared when the reminder resolves, so the same state returning later shows again.

const needs = (over: Partial<NeedsAttention> = {}, studioIds: string[] = []): NeedsAttention =>
  ({
    clients: [],
    studioItems: studioIds.map((id) => ({ id })),
    itemCount: studioIds.length,
    entries: [],
    issueCount: 0,
    others: [],
    notReturnedCount: 0,
    unavailableChecks: [],
    detailsWindow: null,
    ...over,
  }) as unknown as NeedsAttention;
const d = (itemKey: string, instanceToken = "x") => ({ itemKey, instanceToken });

describe("resolvedStudioDismissalKeys", () => {
  it("a dismissed studio reminder that is no longer live is cleared", () => {
    expect(resolvedStudioDismissalKeys(needs(), [d("payment_setup:studio", "no_connect")])).toEqual(["payment_setup:studio"]);
  });
  it("NEGATIVE CONTROL: a studio reminder still live keeps its dismissal", () => {
    expect(resolvedStudioDismissalKeys(needs({}, ["payment_setup:studio"]), [d("payment_setup:studio")])).toEqual([]);
  });
  it("supply reminders are studio reminders too", () => {
    expect(resolvedStudioDismissalKeys(needs(), [d("supply_expiry:abc-1", "2026-12-01")])).toEqual(["supply_expiry:abc-1"]);
  });
  it("client and unpaid dismissals are never cleared here", () => {
    expect(resolvedStudioDismissalKeys(needs(), [d("charting:c1"), d("unpaid:a1", "c5000"), d("intake_review:c1")])).toEqual([]);
  });
  it("fails safe: an unreadable check or a capped list clears nothing (missing is unknown, not resolved)", () => {
    expect(resolvedStudioDismissalKeys(needs({ unavailableChecks: ["payment setup"] }), [d("payment_setup:studio")])).toEqual([]);
    expect(resolvedStudioDismissalKeys(needs({ notReturnedCount: 3 }), [d("payment_setup:studio")])).toEqual([]);
  });
  it("is bounded and deterministic", () => {
    const many = Array.from({ length: 40 }, (_, i) => d(`supply_expiry:s${String(i).padStart(2, "0")}`));
    const out = resolvedStudioDismissalKeys(needs(), many);
    expect(out).toHaveLength(RESOLVED_CLEAR_CAP);
    expect(out).toEqual([...out].sort());
  });
});

describe("the clear path is wired, owner-and-gate scoped, and touches nothing else", () => {
  const STACK = readFileSync("app/(app)/dashboard/secondary-stack.tsx", "utf8");
  const STORE = readFileSync("lib/dashboard/attention-dismissal-store.ts", "utf8");
  it("runs only after the dismissals were read, for an owner, with the gate ON", () => {
    const at = STACK.indexOf("restoreResolvedDismissals(props.studioId");
    expect(at).toBeGreaterThan(STACK.indexOf("if (!dashboardDismissalsEnabled())"));
    expect(at).toBeGreaterThan(STACK.indexOf("if (!props.isOwner)"));
    expect(at).toBeGreaterThan(STACK.indexOf("if (!read.ok)"));
  });
  it("uses only the existing restore command: no balance, payment, setup or access table", () => {
    const fn = STORE.slice(STORE.indexOf("export async function restoreResolvedDismissals"));
    expect(fn).toContain('"restore_attention_item"');
    expect(fn).not.toMatch(/\.from\(|payment|balance|charge|settlement|studios|memberships/i);
  });
});

describe("0298 header and registry wording (Privacy ET-1, ET-4)", () => {
  it("the migration header no longer calls the columns opaque", () => {
    expect(readFileSync("supabase/migrations/0298_dashboard_attention_dismissals.sql", "utf8")).not.toContain("opaque");
  });
  it("the registry reason ends where Privacy asked; the erasure note stays in the code comment", () => {
    const src = readFileSync("lib/export/resource-registry.ts", "utf8");
    const at = src.indexOf("dashboard_attention_events: {");
    const block = src.slice(at, src.indexOf("\n  },", at));
    expect(block).toContain("recomputed from records that ARE exported.\",");
    expect(block).not.toContain("must handle it");
    expect(src.slice(at - 1400, at)).toContain("MUST BE HANDLED by any client-erasure, offboarding or account-removal design");
  });
});
