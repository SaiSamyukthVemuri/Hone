// ===========================================================================
// LEAD-ALERT-01 (#826): WHO the operator lead alert goes to
// ===========================================================================
//
// A short LIST of recipients, from SERVER configuration only:
//
//   LEAD_ALERT_RECIPIENTS   comma-separated plain addresses, no default
//
// Each entry must be exactly one plain address (no display name, no whitespace or control character, no header syntax). The list is
// lower-cased, de-duplicated and capped at MAX_LEAD_ALERT_RECIPIENTS. ANY invalid entry, or a list over the cap, refuses the WHOLE list:
// nothing is sent to a partial reading of it.
//
// It is deliberately NOT tied to the admin allowlist (ADMIN_EMAILS). Being a recipient grants no admin or console access, and the alert
// itself carries no prospect details (alert-email.ts): the lead is only readable after signing in to /admin.
//
// LEAD_ALERT_EMAIL, the single-address variable an earlier draft read, is RETIRED. It never shipped, so nothing sets it, and keeping a
// second way to configure the same thing would only invite the two to disagree.
//
// What NEVER decides a recipient: a submitted form value (a lead's own address is lead DATA), the request, the database, or an account.
// With nothing configured the alert is BLOCKED: recorded on the alert, never treated as sent.
//
// Pure: no I/O, so it is testable with a plain env object.
// ===========================================================================

export const LEAD_ALERT_RECIPIENTS_ENV = "LEAD_ALERT_RECIPIENTS";
export const MAX_LEAD_ALERT_RECIPIENTS = 5;

// The stored blocker code for "the list is unusable" keeps its 0213 name (the database enumerates these codes and 0213 is frozen);
// its operator-facing wording says what it means here (alert-status.ts).
export type LeadAlertRecipientBlock =
  | "recipient_not_configured"
  | "recipient_not_allowlisted";

export type LeadAlertRecipients =
  | { ok: true; recipients: readonly string[] }
  | { ok: false; code: LeadAlertRecipientBlock };

type Env = Readonly<Record<string, string | undefined>>;

// One plain address: no display name, no list separator, no whitespace or
// control character anywhere, no header syntax.
const SINGLE_ADDRESS =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const MAX_ADDRESS_LENGTH = 254;

export function resolveLeadAlertRecipients(env: Env = process.env): LeadAlertRecipients {
  const raw = env[LEAD_ALERT_RECIPIENTS_ENV] ?? "";
  if (raw.trim().length === 0) return { ok: false, code: "recipient_not_configured" };
  const seen = new Set<string>();
  for (const piece of raw.split(",")) {
    const address = piece.trim().toLowerCase();
    // An empty piece (a stray or doubled comma) is a malformed list, not a skipped entry.
    if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH || !SINGLE_ADDRESS.test(address)) {
      return { ok: false, code: "recipient_not_allowlisted" };
    }
    seen.add(address);
  }
  if (seen.size > MAX_LEAD_ALERT_RECIPIENTS) return { ok: false, code: "recipient_not_allowlisted" };
  return { ok: true, recipients: [...seen] };
}

/** For the console: enough to recognise the inbox, not to copy it. */
export function maskRecipient(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`;
}
