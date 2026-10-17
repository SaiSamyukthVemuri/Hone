import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  bookingPanel,
  notYetAvailablePanel,
  paymentsPanel,
  phonePanel,
  teamPanel,
} from "@/lib/owner-console/summary";
import type { SenderStatusView } from "@/lib/sms/sender-status";

// STUDIO-READY-03a (#824): the owner console never turns an unanswered
// authority into "ready", and the page stays owner-only and provider-free.

const sender = (tone: SenderStatusView["tone"], headline = "H"): SenderStatusView => ({
  status: null,
  tone,
  headline,
  detail: "D",
  phoneNumber: null,
  recovery: { kind: "none" } as unknown as SenderStatusView["recovery"],
  errorCode: null,
  lastTestOkAt: null,
});

describe("the three-state rule", () => {
  it("booking: ready, steps left, or UNKNOWN when readiness could not answer", () => {
    expect(bookingPanel({ status: "ready" }).tone).toBe("ready");
    const notReady = bookingPanel({
      status: "not_ready",
      blockers: [{ key: "availability" }, { key: "booking_link" }] as never,
      nextStep: null,
      unavailable: [],
    });
    expect(notReady).toMatchObject({ tone: "attention", status: "2 steps left" });
    expect(bookingPanel({ status: "unknown", unavailable: ["services"] as never }).tone).toBe("unknown");
    expect(bookingPanel(null).tone).toBe("unknown");
  });

  it("booking: a partial blocker list says so", () => {
    const p = bookingPanel({
      status: "not_ready",
      blockers: [{ key: "availability" }] as never,
      nextStep: null,
      unavailable: ["consent"] as never,
    });
    expect(p.status).toBe("At least 1 step left");
    expect(p.tone).toBe("attention");
    expect(p.detail).toMatch(/there may be more/);
  });

  it("team: a failed read is unknown, never a count of zero", () => {
    expect(teamPanel(null)).toMatchObject({ tone: "unknown", status: "Unknown" });
    expect(teamPanel({ practitioners: 6, pendingInvitations: 1 })).toMatchObject({
      status: "6 active practitioners",
      detail: "Invitations, roles and deactivation. 1 invitation pending.",
    });
  });

  it("phone: only a live sender is ready; an unread sender is unknown", () => {
    expect(phonePanel(sender("live")).tone).toBe("ready");
    expect(phonePanel(sender("unknown")).tone).toBe("unknown");
    for (const t of ["none", "working", "attention", "retired"] as const) {
      expect(phonePanel(sender(t)).tone, t).toBe("attention");
    }
  });

  it("payments: only a fully enabled account is ready; an unread status is unknown", () => {
    expect(paymentsPanel("ready", "live")).toMatchObject({ tone: "ready", status: "Live payments ready" });
    for (const m of ["live", "test"] as const) {
      expect(paymentsPanel("unknown", m).tone).toBe("unknown");
      for (const c of ["not_connected", "onboarding_started", "charges_disabled", "charges_enabled_payouts_pending"] as const) {
        expect(paymentsPanel(c, m).tone, `${c} ${m}`).toBe("attention");
      }
    }
  });

  it("payments: TEST-mode readiness never reads as live readiness (Codex P2 4244007430)", () => {
    const p = paymentsPanel("ready", "test");
    expect(p.tone).not.toBe("ready");
    expect(p.status).toBe("Test mode ready");
    expect(p.detail).toMatch(/no real money moves/);
  });

  // EVERY capability, not just `ready` (Codex P2 4301040473). The first fix
  // guarded `capability === "ready" && mode === "test"`, so payouts-pending
  // fell through to the live copy and read "Cards can be charged" on a test
  // deployment. The console carries no separate mode indicator, so a panel
  // that omits the mode is the whole defect.
  const ALL_CAPABILITIES = [
    "ready",
    "charges_enabled_payouts_pending",
    "onboarding_started",
    "charges_disabled",
    "not_connected",
    "unknown",
  ] as const;

  it("payments: NO test-mode state claims real cards can be charged (Codex P2 4301040473)", () => {
    for (const c of ALL_CAPABILITIES) {
      const p = paymentsPanel(c, "test");
      // Every test-mode panel says so in its own words.
      expect(p.detail, `${c}: test mode must be stated in the panel's words`).toMatch(
        /test mode|no real money moves/i,
      );
      // And none of them asserts real charging.
      expect(p.detail, `${c}: must not claim cards can be charged`).not.toMatch(
        /^Cards can be charged/,
      );
      expect(p.detail, `${c}: must not claim LIVE card payments`).not.toMatch(
        /Live card payments/,
      );
      // The literal "test charge" is BANNED in runtime source outside a
      // mode-aware ternary by tests/source-guards/payment-messaging-guards.
      // Asserted here too, so the phrase cannot creep back into this copy and
      // red the whole validate lane from a source guard this file never runs.
      expect(p.detail, `${c}: must not use the banned "test charge" wording`).not.toMatch(
        /test charge/i,
      );
    }
  });

  it("payments: the regression itself — payouts-pending in test mode (Codex P2 4301040473)", () => {
    const test = paymentsPanel("charges_enabled_payouts_pending", "test");
    expect(test.status).toBe("Test mode: payouts pending");
    expect(test.detail).toMatch(/in test mode/);
    expect(test.detail).toMatch(/No real cards can be charged/);
    // NON-VACUITY: the live panel for the same capability must DIFFER, or this
    // suite would pass just as well against a mode-blind implementation.
    const live = paymentsPanel("charges_enabled_payouts_pending", "live");
    expect(live.status).not.toBe(test.status);
    expect(live.detail).not.toBe(test.detail);
    expect(live.detail).not.toMatch(/test mode/i);
    // The live copy is HEDGED to match connectBannerCopy's approved wording:
    // the console may not out-claim the page that owns the truth.
    expect(live.detail).toMatch(/Charges may be enabled/);
    expect(live.detail).not.toMatch(/^Cards can be charged/);
  });

  it("payments: tone is preserved across modes where it carries meaning", () => {
    // The mode changes the WORDS, not the severity: a pending payout is still
    // "attention" in test mode, and an unread status is still "unknown".
    expect(paymentsPanel("charges_enabled_payouts_pending", "test").tone).toBe("attention");
    expect(paymentsPanel("unknown", "test").tone).toBe("unknown");
    // `ready` is the one deliberate exception: test-ready is never "ready".
    expect(paymentsPanel("ready", "test").tone).toBe("chosen");
  });

  it("booking: a deliberate admission mode is a choice, never a setup step (Codex P2 4244007433)", () => {
    const wait = { key: "wait_admission", label: "New clients join the waitlist instead of booking directly." };
    const closed = { key: "admission_closed", label: "This studio is not accepting new clients." };
    const only = (blockers: unknown[], unavailable: unknown[] = []) =>
      bookingPanel({ status: "not_ready", blockers: blockers as never, nextStep: null, unavailable: unavailable as never });

    expect(only([wait])).toMatchObject({ tone: "chosen", status: "Waitlist only" });
    expect(only([closed])).toMatchObject({ tone: "chosen", status: "Not accepting new clients" });
    expect(only([wait]).status).not.toMatch(/step/);
    // Real steps are counted WITHOUT the choice, and the choice is still stated.
    const mixed = only([{ key: "availability", label: "x" }, wait]);
    expect(mixed).toMatchObject({ tone: "attention", status: "1 step left" });
    expect(mixed.detail).toContain(wait.label);
    // A partial list with only a choice proven never claims setup is complete.
    expect(only([wait], ["consent"]).detail).toMatch(/may still need steps/);
  });

  it("booking: a mixed state never promises booking that admission still blocks (Codex P2 4301111467)", () => {
    const wait = { key: "wait_admission", label: "New clients join the waitlist instead of booking directly." };
    const closed = { key: "admission_closed", label: "This studio is not accepting new clients." };
    const step = { key: "availability", label: "x" };
    const panel = (blockers: unknown[], unavailable: unknown[] = []) =>
      bookingPanel({ status: "not_ready", blockers: blockers as never, nextStep: null, unavailable: unavailable as never });

    for (const choice of [wait, closed]) {
      const mixed = panel([step, choice]);
      // The choice is still stated, and the step count still excludes it.
      expect(mixed.detail).toContain(choice.label);
      expect(mixed.status).toBe("1 step left");
      // THE DEFECT: the old copy promised that finishing setup would let
      // clients book online, while the same sentence said they are waitlisted
      // or refused. The bare promise must be gone.
      expect(mixed.detail, "must not promise booking on setup alone").not.toMatch(
        /Finish setup before clients can book online/,
      );
      // And BOTH conditions must be named, not just the steps.
      expect(mixed.detail).toMatch(/does not change that/);
      expect(mixed.detail).toMatch(/that setting allows direct booking/);
    }

    // NON-VACUITY: with no admission choice, the plain instruction is correct
    // and MUST still be used — otherwise this test would pass against copy
    // that simply dropped the sentence everywhere.
    const setupOnly = panel([step]);
    expect(setupOnly.detail).toMatch(/Finish setup before clients can book online/);
    expect(setupOnly.detail).not.toMatch(/that setting allows direct booking/);

    // The lower-bound clause survives in the mixed state too.
    expect(panel([step, wait], ["consent"]).detail).toMatch(/there may be more/);
  });

  it("panels without an authority yet say so, and link nowhere", () => {
    for (const k of ["delivery", "notifications"] as const) {
      expect(notYetAvailablePanel(k)).toMatchObject({ tone: "unavailable", status: "Not available yet", href: null });
    }
  });
});

describe("the console page", () => {
  const PAGE = readFileSync(path.join(process.cwd(), "app/(app)/settings/overview/page.tsx"), "utf8")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("is owner-only, behind the redirecting practitioner guard", () => {
    expect(PAGE).toMatch(/await requirePractitionerWithStudio\(\)/);
    expect(PAGE).toMatch(/if \(practitioner\.role !== "owner"\)/);
    expect(PAGE.indexOf('practitioner.role !== "owner"')).toBeLessThan(PAGE.indexOf("await createClient()"));
  });

  it("the PAGE reads under the owner's own session and never calls a provider or the admin client itself", () => {
    // Precisely: the page imports no admin client. Its booking-setup authority,
    // getNewClientReadiness, reads the admission mode server-side with the
    // service role internally. That is the same authority the Launch page
    // already uses for this owner (Codex P2 4243961745 on #851).
    expect(PAGE).toMatch(/getNewClientReadiness\(studio\)/);
    expect(PAGE).not.toMatch(/createAdminClient|admin-server/);
    expect(PAGE).not.toMatch(/refreshAccountStatusFromStripe|lib\/stripe\/account|lib\/sms\/provider|twilio/i);
    expect(PAGE).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });

  it("a payment read error is passed on as unknown, never as not connected", () => {
    expect(PAGE).toMatch(/payment\.error\s*\?\s*undefined/);
  });
});
