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
    expect(p.detail).toMatch(/may be incomplete/);
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
    expect(paymentsPanel("ready").tone).toBe("ready");
    expect(paymentsPanel("unknown").tone).toBe("unknown");
    for (const c of ["not_connected", "onboarding_started", "charges_disabled", "charges_enabled_payouts_pending"] as const) {
      expect(paymentsPanel(c).tone, c).toBe("attention");
    }
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

  it("reads under the owner's own session and never calls a provider or the admin client", () => {
    expect(PAGE).not.toMatch(/createAdminClient|admin-server/);
    expect(PAGE).not.toMatch(/refreshAccountStatusFromStripe|lib\/stripe\/account|lib\/sms\/provider|twilio/i);
    expect(PAGE).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });

  it("a payment read error is passed on as unknown, never as not connected", () => {
    expect(PAGE).toMatch(/payment\.error\s*\?\s*undefined/);
  });
});
