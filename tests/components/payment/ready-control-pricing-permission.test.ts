import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideReadyControlPermission } from "@/lib/billing/ready-control-permission";

// Review 3780286321 — READY-CONTROL PERMISSION.
//
// `ready` is the only attempt status carrying a money-moving control, and it
// may expose that control ONLY while current authoritative pricing is
// `resolved`.
//
// The previous gate was free-only, so an attempt whose service price had since
// been cleared to NULL, whose custom pricing had become ambiguous, or whose
// pricing read had failed still rendered Run charge. Execution already refuses
// all of those — money safety was intact — but the practitioner saw an
// apparently runnable control and only discovered the block after submitting.
// Worse, the pricing explanations were gated on `showPrepareForm`, which is
// false whenever an attempt is active, so the explanation was suppressed
// exactly when the stale ready attempt was on screen.
//
// The card is a client component whose branches are pure functions of
// (activeAttempt.status, amountResult.kind), so this proves the state machine
// by evaluating those conditions directly, then pins the source wiring.

const CARD = readFileSync(
  join(process.cwd(), "components/session-payment-prepare-card.tsx"),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l) && !/^\s*\{\/\*/.test(l))
    .join("\n");
}

type Kind =
  | "resolved"
  | "free"
  | "missing_price"
  | "missing_service"
  | "ambiguous_custom_pricing";

// The card's derived flags, mirrored exactly from the component.
function model(status: string | null, kind: Kind | null) {
  const activeAttempt = status === null ? null : { status };
  const amountResult = kind === null ? null : { kind };
  const isFreeNow = amountResult?.kind === "free";
  const settledOrInFlightAttempt =
    activeAttempt !== null && activeAttempt.status !== "ready";
  // The REAL decision, not a re-implementation of it. NC43 proved why: with a
  // mirrored copy, reverting the component's gate left these cases green.
  const readyAttemptBlocked = decideReadyControlPermission(
    activeAttempt?.status ?? null,
    (amountResult ?? null) as never,
  ).blocked;
  // An active attempt always makes showPrepareForm false.
  const showPrepareForm = activeAttempt === null;

  return {
    // the panel carries Run charge for a ready attempt
    runChargeVisible: activeAttempt !== null && !readyAttemptBlocked,
    freeNoticeVisible: !!isFreeNow && !settledOrInFlightAttempt,
    unavailableExplanation:
      (showPrepareForm || readyAttemptBlocked) && !amountResult,
    unresolvedExplanation:
      (showPrepareForm || readyAttemptBlocked) &&
      !!amountResult &&
      amountResult.kind !== "resolved" &&
      amountResult.kind !== "free",
  };
}

describe("a READY attempt may run only while pricing is currently resolved", () => {
  it("1 ready + resolved => Run charge visible", () => {
    const m = model("ready", "resolved");
    expect(m.runChargeVisible).toBe(true);
    expect(m.unresolvedExplanation).toBe(false);
    expect(m.unavailableExplanation).toBe(false);
  });

  it("2 ready + free => Run charge absent, No payment required shown", () => {
    const m = model("ready", "free");
    expect(m.runChargeVisible).toBe(false);
    expect(m.freeNoticeVisible).toBe(true);
  });

  it("3 ready + missing_price => Run charge absent, unresolved explanation shown", () => {
    const m = model("ready", "missing_price");
    expect(m.runChargeVisible).toBe(false);
    expect(m.unresolvedExplanation).toBe(true);
  });

  it("3b ready + missing_service => Run charge absent, unresolved explanation shown", () => {
    const m = model("ready", "missing_service");
    expect(m.runChargeVisible).toBe(false);
    expect(m.unresolvedExplanation).toBe(true);
  });

  it("4 ready + ambiguous_custom_pricing => Run charge absent, explanation shown", () => {
    const m = model("ready", "ambiguous_custom_pricing");
    expect(m.runChargeVisible).toBe(false);
    expect(m.unresolvedExplanation).toBe(true);
  });

  it("5 ready + pricing read failure (null) => Run charge absent, unavailable explanation shown", () => {
    const m = model("ready", null);
    expect(m.runChargeVisible).toBe(false);
    expect(m.unavailableExplanation).toBe(true);
  });

  it("6 pending_stripe + pricing unavailable => Processing panel preserved", () => {
    for (const kind of [null, "missing_price", "ambiguous_custom_pricing", "free"] as const) {
      const m = model("pending_stripe", kind as Kind | null);
      expect(m.runChargeVisible, String(kind)).toBe(true); // the panel renders
      expect(m.freeNoticeVisible, String(kind)).toBe(false); // and never claims free
    }
  });

  it("7 succeeded + pricing unavailable => Paid / receipt / refund truth preserved", () => {
    for (const kind of [null, "missing_price", "ambiguous_custom_pricing", "free"] as const) {
      const m = model("succeeded", kind as Kind | null);
      expect(m.runChargeVisible, String(kind)).toBe(true);
      expect(m.freeNoticeVisible, String(kind)).toBe(false);
    }
  });

  it("8 no active attempt: the prepare-side behaviour is unchanged", () => {
    expect(model(null, "resolved").unresolvedExplanation).toBe(false);
    expect(model(null, "missing_price").unresolvedExplanation).toBe(true);
    expect(model(null, null).unavailableExplanation).toBe(true);
    expect(model(null, "free").freeNoticeVisible).toBe(true);
    // and no panel exists without an attempt
    expect(model(null, "resolved").runChargeVisible).toBe(false);
  });

  it("EVERY non-resolved pricing result withdraws the ready control", () => {
    const kinds: Array<Kind | null> = [
      "free",
      "missing_price",
      "missing_service",
      "ambiguous_custom_pricing",
      null,
    ];
    for (const k of kinds) {
      expect(model("ready", k).runChargeVisible, String(k)).toBe(false);
      // and the practitioner is never left with no explanation at all
      const m = model("ready", k);
      expect(
        m.freeNoticeVisible || m.unresolvedExplanation || m.unavailableExplanation,
        `${String(k)} must explain itself`,
      ).toBe(true);
    }
    expect(model("ready", "resolved").runChargeVisible).toBe(true);
  });
});

describe("source wiring", () => {
  it("permission is expressed as resolved-only, not another free special case", () => {
    expect(CARD).toMatch(/decideReadyControlPermission\(/);
    expect(CARD).toMatch(/const readyAttemptBlocked = readyControl\.blocked/);
    const PERM = readFileSync(
      join(process.cwd(), "lib/billing/ready-control-permission.ts"),
      "utf8",
    );
    expect(PERM).toMatch(/const canRun = amountResult\?\.kind === "resolved"/);
    expect(codeOnly(PERM)).not.toMatch(/"free"/); // free is not special-cased
    // the old free-only gate is gone from the panel condition
    expect(codeOnly(CARD)).not.toMatch(/\{activeAttempt && !readyAttemptIsNowFree && \(/);
    expect(CARD).toMatch(/\{activeAttempt && !readyAttemptBlocked && \(/);
  });

  it("explanations are no longer tied to showPrepareForm alone", () => {
    // Both pricing explanations must also fire for a blocked ready attempt,
    // which is exactly when showPrepareForm is false.
    const occurrences =
      codeOnly(CARD).match(/\(showPrepareForm \|\| readyAttemptBlocked\)/g) ?? [];
    expect(occurrences).toHaveLength(2);
  });

  it("execution authority and prepared-amount semantics are untouched", () => {
    // PrepareForm still requires a strictly resolved amount.
    expect(CARD).toMatch(/amountResult\.kind === "resolved" \? amountResult : null/);
    // The card derives no amount of its own. The ONLY amount_cents in code is
    // `expected_amount_cents`, the optimistic-concurrency echo submitted back
    // for confirmation — not a pricing authority.
    const amountRefs = codeOnly(CARD).match(/\w*amount_cents/g) ?? [];
    expect(new Set(amountRefs)).toEqual(new Set(["expected_amount_cents"]));
  });
});
