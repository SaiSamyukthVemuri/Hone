import "server-only";
import { resend, FROM_ADDRESS } from "@/lib/email/client";
import { SAFE_STRIPE_ID_PREFIXES } from "@/lib/ops/redact";

// ===========================================================================
// notifyCriticalOpsAlert (PR #193)
// ===========================================================================
//
// Standalone operator email for CRITICAL ops alerts only. This is the
// "future PR" the PR #153 design reserved OPS_ALERT_EMAILS for.
//
// Dependency-cycle posture: this module imports ONLY the bare Resend
// client (lib/email/client.ts, which imports nothing from Hone) and the
// pure, dependency-free lib/ops/redact.ts, and is imported ONLY by lib/ops/alerts.ts. It never imports
// lib/email/send-appointment.ts (the appointment email subsystem that
// recordOpsAlert observes), and it NEVER calls recordOpsAlert: a
// failure here logs to stderr and stops, so alert email failures can
// not recurse into more alerts.
//
// Contract:
//   * NEVER throws. The durable ops_alerts row is the source of
//     truth; this email is best-effort notification on top.
//   * Sends only when OPS_ALERT_EMAILS is configured (comma-
//     separated). Missing/empty env logs a once-per-instance warning
//     and returns; the caller's DB write is unaffected.
//   * Content carries only the event slug, the ALREADY-REDACTED message
//     (with any record UUID or Stripe object id replaced), the time, the
//     environment and the admin link: no record ids (#828 G-24), no
//     secrets, no card data, no clinical content, no raw payloads.

export type CriticalAlertEmailInput = {
  event: string;
  message: string;
  createdAtIso: string;
  studioId?: string | null;
  appointmentId?: string | null;
  clientId?: string | null;
  stripeEventId?: string | null;
  stripePaymentIntentId?: string | null;
  route?: string | null;
};

const ADMIN_ALERTS_URL = "https://hone.care/admin/ops-alerts";

// #828 G-24: the email leaves Hone through Resend, which cannot sign a BAA,
// so it carries NO record identifiers. The studio, appointment and client
// UUIDs, Stripe object ids and the route stay on the durable ops_alerts row
// and the /admin/ops-alerts page. The (already PII-redacted) message is
// scrubbed of any UUID or Stripe object id it embeds; the event slug stays in
// the subject because it names a failure class, not a record. The UUID
// pattern has no boundary (an id glued to letters is still removed, Codex P1
// 4301586679 on #903) and accepts a %2D-encoded hyphen.
const RECORD_ID_PLACEHOLDER = "[id]";
const RECORD_ID_REDACTED = "[Redacted]";
// THE GUARANTEE for encodings: no string or key, after ASCII percent-decoding
// to a fixed point, contains a UUID.
//
// The regex is the plain dashed 8-4-4-4-12 form with no boundary (an id glued
// to letters, "_" or digits is still a full id). Its dashes are what make it a
// UUID, so dashless hex (Sentry trace and span ids, hashes) is never matched.
// Encodings are NOT enumerated in it (%2D, %36, %252D, ... were found one at a
// time in review). Instead, each whitespace-delimited token that contains "%"
// is DECODED FOR DETECTION ONLY: every character of the decoded form keeps the
// range of the original text it came from (ASCII %XX escapes, decoded
// repeatedly until stable, at most MAX_DECODE_ROUNDS times, so %252D, %2536
// and %25%32%44 all resolve). Each match found in the decoded form replaces
// exactly its ORIGINAL range; everything else in the token is written back
// byte for byte, still encoded (Codex P2 4301838851, P2 4301902163, P1
// 4301902565: emitting the decoded token injected control characters, forged
// JSON fields, and re-exposed an email the upstream redaction had removed). A
// token still changing after the bound is replaced with "[Redacted]": fail
// closed, never sent undecoded.
// Out of scope: non-URL encodings (HTML entities, \u escapes, base64), which
// URL serialization does not produce.
const RECORD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MAX_DECODE_ROUNDS = 4;

type Detector = { re: RegExp; placeholder: string };

/** One decoded character and the [start, end) range of the original token it
 *  decodes from. */
type Unit = { ch: string; start: number; end: number };

const isHex = (u: Unit | undefined): boolean => u !== undefined && /^[0-9a-f]$/i.test(u.ch);

/** One round of ASCII %XX decoding over units, left to right. Returns null
 *  when nothing changed. */
function decodeRound(units: Unit[]): Unit[] | null {
  const out: Unit[] = [];
  let changed = false;
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i]!;
    const h1 = units[i + 1];
    const h2 = units[i + 2];
    if (u.ch === "%" && isHex(h1) && isHex(h2)) {
      const code = parseInt(h1!.ch + h2!.ch, 16);
      if (code < 0x80) {
        out.push({ ch: String.fromCharCode(code), start: u.start, end: h2!.end });
        i += 2;
        changed = true;
        continue;
      }
    }
    out.push(u);
  }
  return changed ? out : null;
}

/** Replace every detector match found in the token's decoded form, at its
 *  original range. `undefined` means the token is still changing after the
 *  bound and must be dropped. */
function replaceDecodedMatches(token: string, detectors: readonly Detector[]): string | undefined {
  // UTF-16 code units, not code points (Codex P2 4301959849 / 4301959252):
  // regex indexes and String.slice count code units, so an astral character
  // (an emoji is two units) must be two units here too.
  let units: Unit[] = Array.from({ length: token.length }, (_v, i) => ({ ch: token[i]!, start: i, end: i + 1 }));
  for (let round = 0; ; round += 1) {
    const next = decodeRound(units);
    if (next === null) break;
    if (round === MAX_DECODE_ROUNDS) return undefined;
    units = next;
  }
  const decoded = units.map((u) => u.ch).join("");
  const hits: Array<{ start: number; end: number; placeholder: string }> = [];
  for (const { re, placeholder } of detectors) {
    for (const m of decoded.matchAll(re)) {
      const first = units[m.index!]!;
      const last = units[m.index! + m[0].length - 1]!;
      hits.push({ start: first.start, end: last.end, placeholder });
    }
  }
  if (hits.length === 0) return token;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue; // overlapped by an earlier (wider) hit
    out += token.slice(at, h.start) + h.placeholder;
    at = h.end;
  }
  return out + token.slice(at);
}

/** Apply detectors to text, decoding any token that contains "%". */
function replaceEncodedAware(text: string, detectors: readonly Detector[]): string {
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (!token.includes("%")) {
        return detectors.reduce((t, { re, placeholder }) => t.replace(re, placeholder), token);
      }
      return replaceDecodedMatches(token, detectors) ?? RECORD_ID_REDACTED;
    })
    .join("");
}
// Every Stripe prefix lib/ops/redact.ts preserves as a "safe" id, plus the
// other documented Stripe object prefixes (Codex P1 4302008658: with a KNOWN
// prefix, any suffix is an id, whatever its character mix, so "dp_abcdefghij"
// is removed too). NO leading boundary (Codex
// P1 4301636814): an id glued to preceding text ("refpi_3...", "refund_re_...")
// is still removed. That can over-redact an ordinary word ending in a prefix
// ("api_..." loses its "pi_..." tail); in an email that only points at the
// alert, over-redaction is the safe side.
// The PaymentMethod-era card prefix is not listed: this module's source guard
// bans that word in code. Real ids of that type carry digits, so the generic
// matcher below removes them.
const OTHER_STRIPE_ID_PREFIXES: readonly string[] = [
  "pm", "dp", "du", "src", "ba", "btok", "tok", "cn", "fee", "fr", "file", "link",
  "ich", "iauth", "ipi", "ic", "ii", "la", "or", "pr", "promo", "pi", "ps", "trr", "tu",
  "txi", "we", "whsec", "wb", "sub_sched", "plink", "pyr", "pmc", "cbtxn",
];
const STRIPE_ID_RE = new RegExp(
  `(?:${[...new Set([...SAFE_STRIPE_ID_PREFIXES, ...OTHER_STRIPE_ID_PREFIXES])]
    .sort((a, b) => b.length - a.length)
    .join("|")})_[A-Za-z0-9]{6,}`,
  "g",
);
// ANY Stripe-shaped object id, whatever its prefix (Codex P1 4301706583:
// dp_, src_, card_, ... are outside the list above). Stripe ids are a short
// lowercase prefix, "_", then 10+ base62 characters. The suffix must contain
// a digit OR an upper-case letter (Codex P1 4301841195: a digit alone missed
// "dp_AbCdEf..."); that is what separates an id from a snake_case event slug,
// which is all lower case. A KNOWN prefix (STRIPE_ID_RE above) needs no such
// mix. KNOWN LIMIT: an UNKNOWN prefix with a suffix of 10+ lower-case letters
// only cannot be told apart from an English word, and stays.
const GENERIC_STRIPE_ID_RE = /[a-z]{2,12}_(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{10,}/g;

function withoutRecordIds(text: string): string {
  // UUIDs and Stripe ids are detected on the DECODED form of an encoded token
  // (Codex P1 4301902572: "pi%5F3..." hid its "_"), and only their original
  // ranges are replaced.
  // If the scrubber itself fails, the message is withheld rather than sent
  // raw, and the alert email still goes out (the slug, time and admin link
  // are what the operator acts on).
  try {
    return replaceEncodedAware(text, [
      { re: RECORD_ID_RE, placeholder: "[id]" },
      { re: STRIPE_ID_RE, placeholder: "[stripe-id]" },
      { re: GENERIC_STRIPE_ID_RE, placeholder: "[stripe-id]" },
    ]);
  } catch {
    return "[message withheld: see the alert]";
  }
}

let missingEnvWarned = false;

function parseOpsAlertEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function environmentLabel(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";
}

export async function notifyCriticalOpsAlert(
  input: CriticalAlertEmailInput,
): Promise<void> {
  try {
    const recipients = parseOpsAlertEmails(process.env.OPS_ALERT_EMAILS);
    if (recipients.length === 0) {
      if (!missingEnvWarned) {
        missingEnvWarned = true;
        console.warn(
          JSON.stringify({
            event: "ops_alert_email_disabled_env_missing",
            environment: environmentLabel(),
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return;
    }
    if (!resend) {
      console.warn(
        JSON.stringify({
          event: "ops_alert_email_disabled_no_resend_key",
          environment: environmentLabel(),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // No id lines (#828 G-24): studioId, appointmentId, clientId, the Stripe
    // ids and the route are deliberately NOT rendered. They remain on the
    // ops_alerts row, which the link below opens.
    const text = [
      `CRITICAL ops alert: ${input.event}`,
      "",
      withoutRecordIds(input.message),
      "",
      `Created: ${input.createdAtIso}`,
      `Environment: ${environmentLabel()}`,
      "",
      "Record and payment details are on the alert itself, not in this email.",
      `Review and resolve: ${ADMIN_ALERTS_URL}`,
    ].join("\n");

    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: recipients,
      subject: `[Hone CRITICAL] ${input.event}`,
      text,
    });
    if (error) {
      console.error(
        JSON.stringify({
          event: "ops_alert_email_send_failed",
          origin_event: input.event,
          err_message: String(error.message ?? error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  } catch (err) {
    // Last resort: log and stop. Never throw, never recurse into
    // recordOpsAlert.
    console.error(
      JSON.stringify({
        event: "ops_alert_email_threw",
        origin_event: input.event,
        err_message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
