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
import type { DestinationReadiness, ReadinessState } from "@/lib/sms/sender-readiness";
import type { PaymentCountrySummary } from "@/lib/billing/payment-jurisdiction";

// STUDIO-READY-03a (#824): the owner console never turns an unanswered
// authority into "ready", and the page stays owner-only and provider-free.

const row = (destination: "CA" | "US", state: ReadinessState): DestinationReadiness => ({
  destination,
  state,
  label: state === "active" ? "Active" : state === "unavailable" ? "Unavailable" : "Requires information",
  detail: `${destination} detail`,
  nextAction: state === "active" ? null : `${destination} next`,
  actor: "none",
  senderCountry: null,
});
const country = (tone: PaymentCountrySummary["tone"]): PaymentCountrySummary => ({
  tone,
  heading: "United States · charges in USD",
  detail: `country ${tone}`,
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

  it("phone: per recipient country (SMS-SENDER-READY-01); ready only when EVERY destination is active", () => {
    expect(phonePanel([row("CA", "active"), row("US", "active")])).toMatchObject({
      tone: "ready",
      status: "Canada: Active · US: Active",
    });
    const usWaiting = phonePanel([row("CA", "active"), row("US", "requires_information")]);
    expect(usWaiting).toMatchObject({ tone: "attention", status: "Canada: Active · US: Requires information" });
    expect(usWaiting.detail).toBe("US detail US next");
  });

  it("phone: an unread destination is UNKNOWN, never ready; a proven gap still wins as attention", () => {
    expect(phonePanel([row("CA", "active"), row("US", "unavailable")]).tone).toBe("unknown");
    expect(phonePanel([row("CA", "unavailable"), row("US", "requires_information")]).tone).toBe("attention");
    expect(phonePanel([]).tone).toBe("unknown");
  });

  it("payments: only a fully enabled account is ready; an unread status is unknown", () => {
    expect(paymentsPanel("ready", "live", null)).toMatchObject({ tone: "ready", status: "Live payments ready" });
    for (const m of ["live", "test"] as const) {
      expect(paymentsPanel("unknown", m, null).tone).toBe("unknown");
      for (const c of ["not_connected", "onboarding_started", "charges_disabled", "charges_enabled_payouts_pending"] as const) {
        expect(paymentsPanel(c, m, null).tone, `${c} ${m}`).toBe("attention");
      }
    }
  });

  it("payments: an UNREAD country never claims cards can be charged", () => {
    // The charge path refuses when the jurisdiction read is `read_failed` or
    // `missing` (session-payment-charge's country check), so money does not
    // move while the country is unread. The panel must not say otherwise.
    const panel = paymentsPanel("charges_enabled_payouts_pending", "live", country("unknown"));
    expect(panel.detail, "no chargeability claim while the country is unread").not.toMatch(
      /cards can be charged/i,
    );
    // The payout warning is INDEPENDENT of the country read and is retained.
    expect(panel.detail).toMatch(/payouts are not enabled yet/i);
    // The tone is not quietly downgraded away from attention.
    expect(panel.tone).toBe("attention");

    // CONTROL: with a readable country the chargeability copy is still there,
    // so the assertion above is about the UNREAD state and not about the copy
    // having been deleted outright.
    const readable = paymentsPanel("charges_enabled_payouts_pending", "live", country("ok"));
    expect(readable.detail).toMatch(/cards can be charged/i);
  });

  it("payments: the payment COUNTRY gates Connect (PAY-CCY): blocked or unread can never read ready", () => {
    const live = paymentsPanel("ready", "live", country("ok"));
    expect(live).toMatchObject({ tone: "ready", status: "Live payments ready" });
    expect(live.detail).toMatch(/^United States · charges in USD\./);
    expect(paymentsPanel("ready", "live", country("blocked"))).toMatchObject({
      tone: "attention",
      status: "Charges blocked",
    });
    expect(paymentsPanel("ready", "live", country("unknown"))).toMatchObject({ tone: "unknown", status: "Unknown" });
    expect(paymentsPanel("ready", "live", country("attention")).tone).toBe("attention");
    // A Connect gap is not hidden by an unread country, and an unread Connect
    // status is not upgraded by a country that needs attention.
    expect(paymentsPanel("not_connected", "live", country("unknown"))).toMatchObject({ tone: "attention", status: "Not connected" });
    expect(paymentsPanel("unknown", "live", country("attention")).tone).toBe("unknown");
  });

  it("payments: TEST-mode readiness never reads as live readiness (Codex P2 4244007430)", () => {
    const p = paymentsPanel("ready", "test", null);
    expect(p.tone).not.toBe("ready");
    expect(p.status).toBe("Test mode ready");
    expect(p.detail).toMatch(/no real money moves/);
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

  it("booking: a CLOSED studio does not invent setup uncertainty (Codex P2 4301288046)", () => {
    const closed = { key: "admission_closed", label: "This studio is not accepting new clients." };
    const wait = { key: "wait_admission", label: "New clients join the waitlist instead of booking directly." };
    const panel = (blockers: unknown[], unavailable: unknown[] = []) =>
      bookingPanel({ status: "not_ready", blockers: blockers as never, nextStep: null, unavailable: unavailable as never });

    // computeNewClientReadiness suppresses the structural blockers for a closed
    // studio (structuralApplies), so an unreadable services/availability CANNOT
    // reveal another step. Claiming it might is invented uncertainty.
    for (const moot of [["services"], ["availability"], ["services", "availability"]]) {
      const p = panel([closed], moot);
      expect(p.detail, `${moot}: must not claim setup may still need steps`).not.toMatch(
        /may still need steps/,
      );
      // It is still honest that something could not be read.
      expect(p.detail, `${moot}: the unread check is still stated`).toMatch(
        /Some checks could not run/,
      );
      expect(p.detail).toMatch(/cannot change this/);
    }

    // NON-VACUITY, three ways — the filter must be narrow, not a blanket mute:
    // 1. treatment_consent is NOT suppressed, so it still makes the count a
    //    lower bound even when closed.
    expect(panel([closed], ["treatment_consent"]).detail).toMatch(/may still need steps/);
    // 2. the same unreadable authority on a WAITLIST studio still counts,
    //    because only a closure suppresses the structural questions.
    expect(panel([wait], ["services"]).detail).toMatch(/may still need steps/);
    // 3. with nothing unreadable, neither caveat appears at all.
    const clean = panel([closed]).detail;
    expect(clean).not.toMatch(/may still need steps/);
    expect(clean).not.toMatch(/Some checks could not run/);
  });

  it("booking: mixed closed states disclose unread checks before reopening (Codex P2 4325253096)", () => {
    for (const unavailable of [["services"], ["availability"], ["services", "availability"]]) {
      const p = bookingPanel({
        status: "not_ready",
        blockers: [
          { key: "admission_closed", label: "This studio is not accepting new clients." },
          { key: "booking_link", label: "Choose a booking link." },
        ] as never,
        nextStep: null,
        unavailable: unavailable as never,
      });
      expect(p).toMatchObject({ tone: "attention", status: "1 step left" });
      expect(p.detail).toContain("Some checks could not run");
      expect(p.detail).toContain("recheck them before allowing direct booking");
      expect(p.detail).not.toMatch(/may still need steps|there may be more/);
    }
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

  it("booking: unreadable admission cannot promise booking after setup", () => {
    const p = bookingPanel({
      status: "not_ready", blockers: [{ key: "availability", label: "Set availability" }] as never,
      nextStep: null, unavailable: ["admission"],
    });
    expect(p.status).toBe("At least 1 step left");
    expect(p.detail).not.toMatch(/Finish setup before clients can book online/);
    expect(p.detail).toMatch(/admission setting could not be checked/);
    expect(p.detail).toMatch(/allows direct booking/);
  });

  it("panels without an authority yet say so, and link nowhere", () => {
    expect(notYetAvailablePanel("notifications")).toMatchObject({ tone: "unavailable", status: "Not available yet", href: null });
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
    // Booking admission comes from the already owner-authorized studio row,
    // including explicit unknown evidence; no privileged admission fallback.
    // Payment-country reads remain the existing financial authority's scope.
    expect(PAGE).toMatch(/getNewClientReadiness\(studio, resolveAdmission\(\{/);
    expect(PAGE).toContain("storedMode: studio.new_client_admission_mode");
    expect(PAGE).toContain("storedSetAt: studio.new_client_admission_mode_set_at");
    expect(PAGE).not.toMatch(/createAdminClient|admin-server/);
    expect(PAGE).not.toMatch(/refreshAccountStatusFromStripe|lib\/stripe\/account|lib\/sms\/provider|twilio/i);
    expect(PAGE).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });

  it("a payment read error is passed on as unknown, never as not connected", () => {
    expect(PAGE).toMatch(/payment\.error\s*\?\s*undefined/);
  });

  it("composes the authorities it does not own instead of re-deriving them", () => {
    // Delivery: the delivery lane's card, mounted as-is (#846), and no longer on Launch.
    expect(PAGE).toMatch(/<OwnerDeliveryCard studioId=\{studio\.id\} timezone=\{studio\.timezone\} \/>/);
    const LAUNCH = readFileSync(path.join(process.cwd(), "app/(app)/settings/launch/page.tsx"), "utf8");
    expect(LAUNCH).not.toMatch(/OwnerDeliveryCard/);
    // SMS: the per-country rows Integrations shows, from the owner's own session.
    expect(PAGE).toMatch(/studioSenderReadiness\(sender, usRegistration\)/);
    expect(PAGE).toMatch(/readOwnSenderRegistrations\(supabase, liveSender\.id\)/);
    // Payments: the country summary, and a failed read is "could not verify".
    expect(PAGE).toMatch(/getStudioPaymentCountryStatus\(studio\.id, livemode\)/);
    expect(PAGE).toMatch(/describePaymentCountry\(\{ jurisdiction: null, account: \{ kind: "unknown" \} \}\)/);
  });
});
