// STUDIO-READY-03a (#824): the studio owner console's panel summaries.
//
// PURE: no I/O, no clock, no provider. Each panel turns ONE existing
// authority's answer into what the console shows. The authorities are the
// modules that already own each truth, and nothing here re-derives one:
//   booking setup -> getNewClientReadiness (lib/booking/new-client-readiness)
//   phone / SMS   -> studioSenderReadiness (lib/sms/sender-readiness), per
//                    recipient country, the same rows Settings -> Integrations shows
//   payments      -> deriveConnectCapability (lib/payments/payment-status-presenter),
//                    gated by describePaymentCountry (lib/billing/payment-jurisdiction)
//   delivery      -> OwnerDeliveryCard (components/delivery), mounted by the page
//
// THE ONE RULE: an authority that could not answer is UNKNOWN. It is never
// "ready" and never "needs setup" (contract §3; the same three-state rule
// new-client-readiness applies).

import type { NewClientReadiness } from "@/lib/booking/new-client-readiness";
import type { DestinationReadiness } from "@/lib/sms/sender-readiness";
import type { PaymentCountrySummary } from "@/lib/billing/payment-jurisdiction";
import type { ConnectCapability, RuntimeMode } from "@/lib/payments/payment-status-presenter";

/** "chosen" is a deliberate owner state: not ready, and not unfinished setup. */
export type PanelTone = "ready" | "attention" | "chosen" | "unknown" | "unavailable";

export type ConsolePanel = {
  key: "booking" | "team" | "phone" | "payments" | "notifications";
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
  const partial = readiness.unavailable.length > 0;
  const chosen = admission.map((b) => b.label).join(" ");
  if (setup === 0 && admission.length > 0) {
    return {
      ...base,
      tone: "chosen",
      status: admission.some((b) => b.key === "admission_closed") ? "Not accepting new clients" : "Waitlist only",
      detail: partial
        ? `${chosen} This is a choice in your settings. Some checks could not run, so setup may still need steps.`
        : `${chosen} This is a choice in your settings, not unfinished setup.`,
    };
  }
  // A proven blocker is real, so the tone stays "attention". But when some
  // checks could not run, the COUNT is a lower bound and is never stated as
  // exact (Codex P2 4243961742 on #851).
  const steps = `${setup} step${setup === 1 ? "" : "s"} left`;
  const finish = partial
    ? "Finish setup before clients can book online. Some checks could not run, so there may be more."
    : "Finish setup before clients can book online.";
  return {
    ...base,
    tone: "attention",
    status: partial ? `At least ${steps}` : steps,
    detail: admission.length > 0 ? `${finish} ${chosen}` : finish,
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

const COUNTRY: Record<DestinationReadiness["destination"], string> = { CA: "Canada", US: "US" };

/**
 * Text-message readiness PER RECIPIENT COUNTRY (SMS-SENDER-READY-01): the same
 * rows, and so the same rule the send-time refusal consumes. Ready only when
 * every destination is active. A row that could not be read is UNKNOWN, unless
 * another row already proves something needs attention.
 */
export function phonePanel(rows: DestinationReadiness[]): ConsolePanel {
  const base = { key: "phone" as const, title: "Phone and text messages", href: "/settings/integrations" };
  if (rows.length === 0) {
    return { ...base, tone: "unknown", status: "Unknown", detail: "Text-message readiness could not be checked just now." };
  }
  const status = rows.map((r) => `${COUNTRY[r.destination]}: ${r.label}`).join(" · ");
  const waiting = rows.find((r) => r.state !== "active" && r.state !== "unavailable");
  const unread = rows.find((r) => r.state === "unavailable");
  if (!waiting && !unread) {
    return { ...base, tone: "ready", status, detail: "The studio can text clients in every supported country." };
  }
  const first = waiting ?? unread!;
  const detail = [first.detail, first.nextAction].filter(Boolean).join(" ");
  return { ...base, tone: waiting ? "attention" : "unknown", status, detail };
}

const CONNECT_COPY: Record<ConnectCapability, { tone: PanelTone; status: string; detail: string }> = {
  ready: { tone: "ready", status: "Live payments ready", detail: "Live card payments and payouts are enabled." },
  charges_enabled_payouts_pending: {
    tone: "attention",
    status: "Payouts pending",
    detail: "Cards can be charged; payouts are not enabled yet.",
  },
  onboarding_started: { tone: "attention", status: "Setup in progress", detail: "Stripe onboarding is not finished." },
  charges_disabled: { tone: "attention", status: "Charges disabled", detail: "Stripe is not accepting charges for this account." },
  not_connected: { tone: "attention", status: "Not connected", detail: "No payment account is connected." },
  unknown: { tone: "unknown", status: "Unknown", detail: "Payment status could not be read just now. Nothing is assumed." },
};

/**
 * PAY-CCY (#833/#836/#839): the studio's payment COUNTRY gates the Connect status.
 * A blocked country means no charge can happen whatever Connect says. An unread
 * country is unknown, never ready. A country that is fine adds its heading
 * ("United States · charges in USD"). Agreed with the PAY-CCY lane on #824.
 */
export function paymentsPanel(
  capability: ConnectCapability,
  mode: RuntimeMode,
  country: PaymentCountrySummary | null,
): ConsolePanel {
  const connect = connectPanel(capability, mode);
  if (country == null) return connect;
  if (country.tone === "blocked") {
    return { ...connect, tone: "attention", status: "Charges blocked", detail: `${country.heading}. ${country.detail}` };
  }
  if (country.tone === "unknown") {
    // NO CHARGEABILITY CLAIM WHILE THE COUNTRY IS UNREAD, and the reason is the
    // charge path itself: `session-payment-charge` refuses when
    // `getStudioPaymentJurisdiction` returns `read_failed` or `missing`, so
    // money does NOT move in this state. Appending the read failure to
    // `charges_enabled_payouts_pending`'s "Cards can be charged" left the panel
    // asserting something the gates would refuse.
    //
    // THE PAYOUT WARNING IS RETAINED, because it is independent of the country
    // read: payouts are pending whatever the jurisdiction says. Only the
    // chargeability sentence is dropped, and the tone is left alone so an
    // `attention` state does not quietly downgrade.
    if (connect.tone === "attention") {
      const payoutWarning =
        capability === "charges_enabled_payouts_pending"
          ? " Payouts are not enabled yet."
          : "";
      return { ...connect, detail: `${country.detail}${payoutWarning}` };
    }
    return { ...connect, tone: "unknown", status: "Unknown", detail: country.detail };
  }
  if (country.tone === "attention") {
    return {
      ...connect,
      tone: connect.tone === "unknown" ? "unknown" : "attention",
      detail: `${country.heading}. ${country.detail}`,
    };
  }
  return { ...connect, detail: `${country.heading}. ${connect.detail}` };
}

function connectPanel(capability: ConnectCapability, mode: RuntimeMode): ConsolePanel {
  const base = { key: "payments" as const, title: "Payments", href: "/settings/payments" };
  // Test-mode readiness is never shown as live readiness: no real money can
  // move (Codex P2 4244007430 on #851; the same split as connectBannerCopy).
  if (capability === "ready" && mode === "test") {
    return {
      ...base,
      tone: "chosen",
      status: "Test mode ready",
      detail: "Test payment setup is ready. Test mode charges no real cards, so no real money moves.",
    };
  }
  return { ...base, ...CONNECT_COPY[capability] };
}

/**
 * Panels whose authority does not exist yet. Stated plainly, never implied to be
 * fine. Message delivery problems USED to be one; the page now mounts the
 * delivery lane's OwnerDeliveryCard instead (DELIVERY-VISIBILITY-02, #846).
 */
export function notYetAvailablePanel(key: "notifications"): ConsolePanel {
  return {
    key,
    title: "Alert recipients",
    tone: "unavailable",
    status: "Not available yet",
    detail: "Choosing who is alerted about problems is not available yet.",
    href: null,
  };
}
