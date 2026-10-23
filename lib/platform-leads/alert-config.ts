import { parseAdminEmails } from "@/lib/admin";

// ===========================================================================
// LEAD-ALERT-01 (#826): WHO the operator lead alert may go to
// ===========================================================================
//
// ONE recipient, from SERVER configuration only:
//
//   LEAD_ALERT_EMAIL   exactly one plain address
//
// and that address must ALSO be on the admin allowlist, ADMIN_EMAILS, read from
// the env alone. The alert carries a prospect's name and contact details, which
// only the platform operator may see: /admin is gated on that same allowlist.
// An address outside it is refused, never mailed.
//
// What NEVER decides the recipient: a submitted form value (a lead's own
// address is lead DATA), the request, the database, an account name, or the
// non-production admin fallback in lib/admin.ts. With nothing configured the
// alert is BLOCKED: recorded on the alert, shown in the console, never treated
// as sent.
//
// Pure: no I/O and no imports beyond the allowlist parser, so it is testable
// with a plain env object.
// ===========================================================================

export const LEAD_ALERT_RECIPIENT_ENV = "LEAD_ALERT_EMAIL";

export type LeadAlertRecipientBlock =
  | "recipient_not_configured"
  | "recipient_not_allowlisted";

export type LeadAlertRecipient =
  | { ok: true; recipient: string }
  | { ok: false; code: LeadAlertRecipientBlock };

type Env = Readonly<Record<string, string | undefined>>;

// One plain address: no display name, no list separator, no whitespace or
// control character anywhere, no header syntax.
const SINGLE_ADDRESS =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const MAX_ADDRESS_LENGTH = 254;

export function resolveLeadAlertRecipient(
  env: Env = process.env,
): LeadAlertRecipient {
  const configured = (env[LEAD_ALERT_RECIPIENT_ENV] ?? "").trim().toLowerCase();
  if (configured.length === 0) {
    return { ok: false, code: "recipient_not_configured" };
  }
  // Not ONE plain address (a list, a display name, an injected header): it
  // cannot equal an allowlist entry, and it is refused before it is compared.
  if (configured.length > MAX_ADDRESS_LENGTH || !SINGLE_ADDRESS.test(configured)) {
    return { ok: false, code: "recipient_not_allowlisted" };
  }
  if (!parseAdminEmails(env.ADMIN_EMAILS).includes(configured)) {
    return { ok: false, code: "recipient_not_allowlisted" };
  }
  return { ok: true, recipient: configured };
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
