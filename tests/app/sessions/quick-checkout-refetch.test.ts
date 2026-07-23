import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Chloe workflow fix — Quick Checkout CTA discoverability.
//
// The modal holds eligibility in client state fetched once per open;
// router.refresh() (called by the card after Prepare) refreshes the underlying
// route's server components but NOT this client-held context, so the persisted
// "ready" attempt never surfaced and the "Run charge" button never mounted —
// the practitioner had to close and reopen to find the CTA. The fix wraps the
// four payment actions so a SUCCESSFUL result silently re-resolves the trusted
// server context here, advancing the card to the persisted next state in place.
//
// These pins lock (a) the wrapper exists and is applied to all four actions,
// (b) it re-resolves ONLY on success and only refreshes THIS modal's view, and
// (c) the fix is isolated to the modal — the shared card and the session detail
// page are NOT rewritten. The end-to-end in-place advance is exercised by the
// WebKit iPhone + Chromium payment E2E.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const MODAL = read("components/quick-checkout-modal.tsx");
const CARD = read("components/session-payment-prepare-card.tsx");
const PAGE = read(
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);

describe("quick checkout: in-place advance after a successful action", () => {
  it("wraps ALL four payment actions with the refresh wrapper", () => {
    for (const a of [
      "prepareSessionPaymentChargeAction",
      "executeSessionPaymentChargeAction",
      "sendPaymentChargeReceiptAction",
      "refundPaymentChargeAttemptAction",
    ]) {
      expect(MODAL).toMatch(new RegExp(`withRefresh\\(${a}\\)`));
    }
  });

  it("re-resolves trusted context ONLY on a successful result", () => {
    // The wrapper must gate the refetch on result.ok — a failed action must
    // not silently reshuffle the card out from under the practitioner.
    expect(MODAL).toMatch(
      /const result = await action\(fd\);\s*\n\s*if \(result\.ok\) void fetchContext\(\{ silent: true \}\)/,
    );
  });

  it("the success refetch is SILENT: it does not tear down the visible card", () => {
    // The silent path must not reset ctx or flip the loading spinner (which
    // would flash "Loading checkout…" over a card mid-flow). The teardown
    // (spinner + ctx reset) must live ONLY inside the !silent branch, which
    // runs on the loud initial open.
    expect(MODAL).toMatch(/const silent = opts\?\.silent \?\? false/);
    const silentGuard =
      MODAL.match(/if \(!silent\) \{[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(silentGuard).toMatch(/setLoading\(true\)/);
    expect(silentGuard).toMatch(/setCtx\(null\)/);
  });

  it("invokes the underlying action exactly once (the wrapper never retries)", () => {
    const wrapper =
      MODAL.match(/const withRefresh = useCallback\([\s\S]*?\[fetchContext\],\s*\);/)?.[0] ??
      "";
    const calls = wrapper.match(/await action\(fd\)/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it("still re-reads server context on open (unchanged) and stays read-only", () => {
    expect(MODAL).toMatch(/getQuickCheckoutContextAction\(appointmentId\)/);
    // No new charge/refund logic sneaks into the modal.
    expect(MODAL).not.toMatch(/paymentIntents|charges\.create|refunds\.create/);
  });
});

describe("quick checkout fix is isolated to the modal", () => {
  it("does NOT thread a modal-specific refresh prop into the shared card", () => {
    // The shared SessionPaymentPrepareCard is used by BOTH the modal and the
    // session detail page; the fix must not change its prop surface.
    expect(CARD).not.toMatch(/onMutated|onRefresh|refetchContext|withRefresh/);
  });

  it("the session detail page passes the canonical actions unchanged (no wrapper)", () => {
    // The page's server components already pick up revalidatePath, so it needs
    // no wrapper. It must pass the raw actions (behavior preserved).
    expect(PAGE).toMatch(/prepareAction=\{prepareSessionPaymentChargeAction\}/);
    expect(PAGE).not.toMatch(/withRefresh/);
  });
});
