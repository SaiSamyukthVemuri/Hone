// STUDIO-READY-03a (#824): the studio owner console's panel summaries.
//
// PURE: no I/O, no clock, no provider. Each panel turns ONE existing
// authority's answer into what the console shows. The authorities are the
// modules that already own each truth, and nothing here re-derives one:
//   booking setup -> getNewClientReadiness (lib/booking/new-client-readiness)
//   phone / SMS   -> presentSenderStatus   (lib/sms/sender-status)
//   payments      -> deriveConnectCapability (lib/payments/payment-status-presenter)
//
// THE ONE RULE: an authority that could not answer is UNKNOWN. It is never
// "ready" and never "needs setup" (contract §3; the same three-state rule
// new-client-readiness applies).

import type { NewClientReadiness } from "@/lib/booking/new-client-readiness";
import { SUPPRESSED_WHEN_CLOSED } from "@/lib/booking/new-client-readiness";
import type { SenderStatusView } from "@/lib/sms/sender-status";
import type { ConnectCapability, RuntimeMode } from "@/lib/payments/payment-status-presenter";

/** "chosen" is a deliberate owner state: not ready, and not unfinished setup. */
export type PanelTone = "ready" | "attention" | "chosen" | "unknown" | "unavailable";

export type ConsolePanel = {
  key: "booking" | "team" | "phone" | "payments" | "delivery" | "notifications";
  title: string;
  tone: PanelTone;
  /** A short state, e.g. "Ready" or "2 steps left". */
  status: string;
  detail: string;
  href: string | null;
};

export function bookingPanel(readiness: NewClientReadiness | null): ConsolePanel {
  const base = { key: "booking" as const, title: "Booking setup", href: "/settings/launch" };
  if (readiness == null || readiness.status === "unknown") {
    return { ...base, tone: "unknown", status: "Unknown", detail: "Setup could not be checked just now. Nothing is assumed." };
  }
  if (readiness.status === "ready") {
    return { ...base, tone: "ready", status: "Ready", detail: "Clients can book online." };
  }
  // A deliberate admission mode (waitlist or closed) is a CHOICE, not a step
  // the owner left unfinished, so it is never counted as one (Codex P2
  // 4244007433 on #851; the Launch page renders it "manual" for the same
  // reason). It is still stated, because clients cannot book online.
  const admission = readiness.blockers.filter((b) => ADMISSION_CHOICES.has(b.key));
  const setup = readiness.blockers.length - admission.length;
  // A CLOSED studio suppresses the structural authorities, so an unreadable
  // `services` or `availability` cannot reveal another setup step and must not
  // become "setup may still need steps" (Codex P2 4301288046 on #851). Only
  // authorities that can STILL change this studio's answer make the count a
  // lower bound. `treatment_consent` is not suppressed and still counts. The
  // suppression set is imported, never restated, so this cannot drift from the
  // module that owns the rule.
  const closed = admission.some((b) => b.key === "admission_closed");
  const consequential = readiness.unavailable.filter(
    (a) => !(closed && SUPPRESSED_WHEN_CLOSED.has(a)),
  );
  const partial = consequential.length > 0;
  // Something WAS unreadable even if it cannot change the answer; that is
  // still stated, just never as possible extra setup.
  const unreadableButMoot = closed && consequential.length === 0 && readiness.unavailable.length > 0;
  const chosen = admission.map((b) => b.label).join(" ");
  if (setup === 0 && admission.length > 0) {
    return {
      ...base,
      tone: "chosen",
      status: admission.some((b) => b.key === "admission_closed") ? "Not accepting new clients" : "Waitlist only",
      detail: partial
        ? `${chosen} This is a choice in your settings. Some checks could not run, so setup may still need steps.`
        : unreadableButMoot
          ? `${chosen} This is a choice in your settings, not unfinished setup. Some checks could not run, but while the studio is closed they cannot change this.`
          : `${chosen} This is a choice in your settings, not unfinished setup.`,
    };
  }
  // A proven blocker is real, so the tone stays "attention". But when some
  // checks could not run, the COUNT is a lower bound and is never stated as
  // exact (Codex P2 4243961742 on #851).
  const steps = `${setup} step${setup === 1 ? "" : "s"} left`;
  const more = partial
    ? " Some checks could not run, so there may be more."
    : unreadableButMoot
      ? " Some checks could not run. They cannot change the closed status; recheck them before allowing direct booking."
      : "";
  // MIXED STATE: a deliberate admission choice sits alongside unfinished setup.
  // Finishing the counted steps does NOT override the choice, so the
  // instruction must not promise online booking (Codex P2 4301111467 on #851).
  // The old copy said "Finish setup before clients can book online" and then
  // appended "clients join the waitlist", which contradicted itself. The two
  // conditions are independent and BOTH have to change.
  const detail =
    admission.length > 0
      ? `${chosen} Finishing the remaining setup does not change that: clients can book online once setup is complete AND that setting allows direct booking.${more}`
      : readiness.unavailable.includes("admission")
        ? `The admission setting could not be checked. Clients can book online once setup is complete AND that setting allows direct booking.${more}`
        : `Finish setup before clients can book online.${more}`;
  return {
    ...base,
    tone: "attention",
    status: partial ? `At least ${steps}` : steps,
    detail,
  };
}

const ADMISSION_CHOICES: ReadonlySet<string> = new Set(["wait_admission", "admission_closed"]);

export function teamPanel(input: { practitioners: number; pendingInvitations: number } | null): ConsolePanel {
  const base = { key: "team" as const, title: "Team", href: "/settings/team" };
  if (input == null) return { ...base, tone: "unknown", status: "Unknown", detail: "The team could not be loaded just now." };
  const { practitioners, pendingInvitations } = input;
  const people = `${practitioners} active practitioner${practitioners === 1 ? "" : "s"}`;
  const pending = pendingInvitations > 0 ? `, ${pendingInvitations} invitation${pendingInvitations === 1 ? "" : "s"} pending` : "";
  return { ...base, tone: "ready", status: people, detail: `Invitations, roles and deactivation.${pending ? ` ${pending.slice(2)}.` : ""}` };
}

export function phonePanel(view: SenderStatusView): ConsolePanel {
  const base = { key: "phone" as const, title: "Phone and text messages", href: "/settings/integrations" };
  const tone: PanelTone =
    view.tone === "live" ? "ready" : view.tone === "unknown" ? "unknown" : "attention";
  return { ...base, tone, status: view.headline, detail: view.detail };
}

const CONNECT_COPY: Record<ConnectCapability, { tone: PanelTone; status: string; detail: string }> = {
  ready: { tone: "ready", status: "Live payments ready", detail: "Live card payments and payouts are enabled." },
  charges_enabled_payouts_pending: {
    tone: "attention",
    // HEDGED, matching connectBannerCopy's approved wording. The console must
    // not make a STRONGER money claim than the page that owns this truth: the
    // approved copy says charges MAY be enabled, never "cards can be charged".
    status: "Payouts pending",
    detail: "Charges may be enabled, but payouts are not ready yet.",
  },
  onboarding_started: { tone: "attention", status: "Setup in progress", detail: "Stripe onboarding is not finished." },
  charges_disabled: { tone: "attention", status: "Charges disabled", detail: "Stripe is not accepting charges for this account." },
  not_connected: { tone: "attention", status: "Not connected", detail: "No payment account is connected." },
  unknown: { tone: "unknown", status: "Unknown", detail: "Payment status could not be read just now. Nothing is assumed." },
};

// TEST-MODE copy, declared for EVERY capability (Codex P2 4301040473 on #851).
// The first fix handled only `ready`, so `charges_enabled_payouts_pending` fell
// through to the live copy and told an owner "Cards can be charged" when only
// TEST cards could be. The console has no separate mode indicator, so the mode
// has to live in the panel's own words. A full Record (not a Partial) makes
// this exhaustive: a new ConnectCapability will not compile until it is
// answered here, instead of silently inheriting a live-money claim.
const TEST_MODE_COPY: Record<ConnectCapability, { tone?: PanelTone; status: string; detail: string }> = {
  ready: {
    tone: "chosen",
    status: "Test mode ready",
    detail: "Test payment setup is ready. Test mode charges no real cards, so no real money moves.",
  },
  charges_enabled_payouts_pending: {
    // Worded to avoid a phrase that
    // tests/source-guards/payment-messaging-guards.test.ts bans in runtime
    // source outside a mode-aware ternary. That guard reads RAW FILE TEXT, so
    // a comment naming the banned phrase trips it too — this comment cannot
    // quote it. The meaning is identical and the guard's allowlist stays
    // untouched; widening a money-messaging guard to fit new copy is the
    // wrong direction.
    status: "Test mode: payouts pending",
    detail: "Charges may be enabled in test mode, but payouts are not ready yet. No real cards can be charged.",
  },
  onboarding_started: {
    status: "Test mode: setup in progress",
    detail: "Stripe onboarding is not finished. No real cards can be charged in test mode.",
  },
  charges_disabled: {
    status: "Test mode: charges disabled",
    detail: "Stripe is not accepting charges for this account in test mode. No real cards can be charged.",
  },
  not_connected: {
    status: "Test mode: not connected",
    detail: "No payment account is connected. No real cards can be charged in test mode.",
  },
  // UNKNOWN STAYS UNKNOWN. The deployment mode is a fact and is safe to state,
  // but nothing about the ACCOUNT may be asserted from a read that failed.
  unknown: {
    status: "Unknown",
    detail:
      "Payment status could not be read just now. Nothing is assumed. No real cards can be charged in test mode.",
  },
};

export function paymentsPanel(capability: ConnectCapability, mode: RuntimeMode): ConsolePanel {
  const base = { key: "payments" as const, title: "Payments", href: "/settings/payments" };
  const live = CONNECT_COPY[capability];
  // Test-mode readiness is never shown as live readiness: no real money can
  // move (Codex P2 4244007430 on #851; the same split as connectBannerCopy).
  // Every state is now answered, not just `ready` (Codex P2 4301040473).
  if (mode === "test") {
    const { tone, ...copy } = TEST_MODE_COPY[capability];
    return { ...base, tone: tone ?? live.tone, ...copy };
  }
  return { ...base, ...live };
}

/** Panels whose authority does not exist yet. Stated plainly, never implied to be fine. */
export function notYetAvailablePanel(key: "delivery" | "notifications"): ConsolePanel {
  return key === "delivery"
    ? {
        key,
        title: "Message delivery problems",
        tone: "unavailable",
        status: "Not available yet",
        detail: "Failed or undelivered messages will be listed here once delivery monitoring is in place.",
        href: null,
      }
    : {
        key,
        title: "Alert recipients",
        tone: "unavailable",
        status: "Not available yet",
        detail: "Choosing who is alerted about problems is not available yet.",
        href: null,
      };
}
