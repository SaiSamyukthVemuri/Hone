import { localLongDate, localTimeString12h } from "@/lib/booking/tz";
import { GSM7_SEGMENT_UNITS, gsm7CharUnits, gsm7Units } from "./gsm7";

// Transactional SMS bodies for the SMS this codebase ships:
//   - confirmation (sent inline from a successful booking)
//   - reminder_24h (sent by cron 24h before starts_at)
//   - reminder_2h  (sent by cron 2h before starts_at)
//   - waitlist invitation (SMS-01, sent beside the invitation email)
//
// All bodies share the same shape:
//   {Studio}: <event>. <intake link if applicable>. <manage link if
//   applicable>. Do not reply here except STOP to opt out.
//
// Constraints honored here:
//   - Short. Each builder targets a single SMS segment whenever
//     possible (160 GSM-7 chars / 70 UCS-2 chars). The shape is
//     intentionally minimal so studio names and URLs do not push us
//     into multi-segment territory; if a long studio name does, that
//     is acceptable Twilio behaviour, not an error.
//   - Transactional only. No marketing, no upsell, no review prompt.
//   - Date / time formatting reuses lib/booking/tz.ts helpers; we do
//     NOT invent a separate SMS formatter. The email day header and
//     the SMS day phrase therefore stay in sync by construction.
//   - One neutral "Manage appointment:" link only. Earlier copy split
//     this into separate "Reschedule:" and "Cancel:" lines, which the
//     pilot review found felt like an active invitation to cancel.
//     The manage URL resolves to /manage/<token>, a public landing
//     page that surfaces both options after reminding the client of
//     the studio's cancellation and no-show policies. SMS still
//     carries an explicit intake link when one is outstanding.
//   - Always ends with "Do not reply here except STOP to opt out."
//     STOP is a real supported reply (handled server-side by the
//     inbound webhook); anything else is not conversational, not
//     parsed, and not persisted.

export type BookingConfirmationSmsInput = {
  studioName: string;
  startsAt: Date;
  timezone: string;
  intakeUrl: string | null;
  manageUrl: string | null;
};

export type ReminderSmsInput = {
  studioName: string;
  startsAt: Date;
  timezone: string;
  manageUrl: string | null;
  // A FRESH secure intake link, or null/absent. Non-null ONLY when the cron
  // decided, against LIVE intake state read after the appointment re-check,
  // that this message should carry the intake CTA. Same convention the
  // booking-confirmation SMS has always used. Optional so existing callers
  // and tests that build a plain reminder need no change.
  intakeUrl?: string | null;
};

// Compact phrase for the appointment moment used by every template:
// "Tuesday, June 3 at 2:30 PM". We do not include the year (it adds
// length and noise; the client booked recently). SMS is CLIENT-FACING, so
// the time is rendered 12-hour (localTimeString12h) (never 24-hour) while
// the studio/appointment timezone is preserved unchanged.
function appointmentMoment(startsAt: Date, timezone: string): string {
  const long = localLongDate(startsAt, timezone);
  // Strip the year suffix ("Tuesday, June 3, 2026" -> "Tuesday, June 3").
  // The Intl format we use always ends with ", YYYY" so a comma split
  // is safe.
  const withoutYear = long.replace(/,\s*\d{4}$/, "");
  const time = localTimeString12h(startsAt, timezone);
  return `${withoutYear} at ${time}`;
}

// Append a phrase only when its value is truthy; keeps the templates
// from emitting "Intake: . Manage appointment:" when a URL is null.
// The SMS body assembler joins parts with ". " and a trailing period.
// The closing disclosure ("Do not reply here except STOP to opt
// out.") is added by the caller so it always sits last.
function joinParts(parts: ReadonlyArray<string | null>): string {
  const filtered = parts.filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return filtered.join(". ");
}

// STOP is the only inbound message the system reacts to; everything
// else is ignored. The disclosure spells that out in one line so a
// client who replies "thanks" understands no one will see it.
const REPLY_DISCLOSURE = "Do not reply here except STOP to opt out.";

export function buildBookingConfirmationSms(
  p: BookingConfirmationSmsInput,
): string {
  const moment = appointmentMoment(p.startsAt, p.timezone);
  const head = `${p.studioName}: confirmed for ${moment}`;
  const intake = p.intakeUrl ? `Intake: ${p.intakeUrl}` : null;
  const manage = p.manageUrl ? `Manage appointment: ${p.manageUrl}` : null;
  const body = joinParts([head, intake, manage]);
  return `${body}. ${REPLY_DISCLOSURE}`;
}

export function build24hReminderSms(p: ReminderSmsInput): string {
  const moment = appointmentMoment(p.startsAt, p.timezone);
  const head = `Reminder from ${p.studioName}: appointment ${moment}`;
  // Neutral on a lock screen: it asks for the form, it never states that the
  // form is incomplete and carries no clinical or health detail.
  const intake = p.intakeUrl
    ? `Please complete your intake form before your visit: ${p.intakeUrl}`
    : null;
  const manage = p.manageUrl ? `Manage appointment: ${p.manageUrl}` : null;
  const body = joinParts([head, intake, manage]);
  return `${body}. ${REPLY_DISCLOSURE}`;
}

export function build2hReminderSms(p: ReminderSmsInput): string {
  // For the same-day reminder, the date is redundant; only the time
  // matters. The 24h variant carries the full moment.
  const head = `Today's appointment with ${p.studioName} is at ${
    localTimeString12h(p.startsAt, p.timezone)
  }`;
  const intake = p.intakeUrl
    ? `If you haven't already, please complete your intake form: ${p.intakeUrl}`
    : null;
  const manage = p.manageUrl ? `Manage appointment: ${p.manageUrl}` : null;
  const body = joinParts([head, intake, manage]);
  return `${body}. ${REPLY_DISCLOSURE}`;
}

export type WaitlistInvitationSmsInput = {
  /** Server-resolved from studios.name. Never request input. */
  studioName: string;
  /** The invitation's own /invitation/<token> link: the secure booking link. */
  invitationUrl: string;
  /**
   * The deadline as the invitation email states it (invitationExpiryLabel),
   * so the two channels name ONE deadline in one rendering. Not re-derived.
   */
  expiresAtLabel: string;
};

/**
 * SMS-01. The text that accompanies a waitlist invitation email: who is
 * inviting, that the prospect is invited to book a consultation, the deadline
 * and the secure link. It promises nothing the invitation does not -- not a held slot, not a
 * queue position -- and names the studio first, so the recipient can tell who
 * it is from before following a link.
 */
export function buildWaitlistInvitationSms(p: WaitlistInvitationSmsInput): string {
  const studio = p.studioName.trim() || "Your clinic";
  const head = `${studio}: you're invited to book a consultation from the waitlist`;
  const action = `Choose a time by ${p.expiresAtLabel}: ${p.invitationUrl}`;
  return `${joinParts([head, action])} ${REPLY_DISCLOSURE}`;
}

export type WaitlistJoinAckSmsInput = {
  /** Server-resolved from studios.name. Never request input. */
  studioName: string;
};

// ---------------------------------------------------------------------------
// The join text's SENDER LABEL (Codex P2 4239889929; the policy is the D3
// design review SMS04_JOIN_ACK_SENDER_LABEL_POLICY_D3_REVIEW_2026-10-11). It
// governs the join text ONLY: the builders above keep this file's documented
// template policy.
//
// The whole text must be GSM-7 in ONE segment (160 units), and the approved
// copy after the label never changes, so the label gets the budget the copy
// leaves (61 units), counted as carriers count it: an extension character
// ([ ] { } | ~ ^ \ €) costs two.
//   1. NFC, so a decomposed accent becomes the composed character.
//   2. Each character, in order:
//      - whitespace or a control character -> one space;
//      - GSM-7 -> kept exactly as written (É, é, è, Ø, Ñ, [, € ...);
//      - typographic punctuation -> its GSM-7 equivalent (’ ', “ ", – -, … ...);
//      - an invisible format character or a stray mark -> removed;
//      - its compatibility decomposition without accents, when that is all
//        GSM-7 (ê -> e, ç -> c, ž -> z, ﬁ -> fi);
//      - a short transliteration for common Latin letters (œ -> oe, ł -> l);
//      - otherwise removed (emoji, other scripts, unsupported symbols).
//   3. Spaces collapse, and the ends are trimmed.
//   4. Over budget: the longest prefix within it, backed off to the last
//      space when the cut falls inside a word, without trailing separators and
//      without an ellipsis (… is not GSM-7).
//   5. No letter or digit left -> "Your clinic".
// ---------------------------------------------------------------------------

const JOIN_ACK_COPY =
  ": you've joined our waitlist. We'll contact you when you're invited to book. Reply STOP to opt out.";
const JOIN_ACK_LABEL_FALLBACK = "Your clinic";
/** The units the label may use: one segment, less the approved copy's 99. */
const JOIN_ACK_LABEL_BUDGET = GSM7_SEGMENT_UNITS - (gsm7Units(JOIN_ACK_COPY) ?? GSM7_SEGMENT_UNITS);

const fromCode = (code: number) => String.fromCharCode(code);
/** Typographic punctuation, and its GSM-7 equivalent. */
const GSM7_PUNCTUATION = new Map<string, string>([
  ...[0x2018, 0x2019, 0x201a, 0x201b, 0x02bc, 0x2032].map((c): [string, string] => [fromCode(c), "'"]),
  ...[0x201c, 0x201d, 0x201e, 0x201f, 0x2033].map((c): [string, string] => [fromCode(c), '"']),
  ...[0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((c): [string, string] => [fromCode(c), "-"]),
  [fromCode(0x2026), "..."],
]);
/** Common Latin letters with no decomposition to fall back on. */
const LATIN_TRANSLITERATION = new Map<string, string>([
  ["œ", "oe"],
  ["Œ", "OE"],
  ["ł", "l"],
  ["Ł", "L"],
  ["đ", "d"],
  ["Đ", "D"],
  ["ı", "i"],
]);
const WHITESPACE_OR_CONTROL = /[\p{White_Space}\p{Cc}]/u;
const INVISIBLE_OR_MARK = /[\p{Cf}\p{M}]/u;
const MARKS = /\p{M}/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const TRAILING_SEPARATORS = /[ ,&+:;\/-]+$/;

/** One character of a sender label, as GSM-7 (possibly empty). */
function gsm7LabelChar(c: string): string {
  if (WHITESPACE_OR_CONTROL.test(c)) return " ";
  if (gsm7CharUnits(c) !== null) return c;
  const punctuation = GSM7_PUNCTUATION.get(c);
  if (punctuation !== undefined) return punctuation;
  if (INVISIBLE_OR_MARK.test(c)) return "";
  const base = c.normalize("NFKD").replace(MARKS, "");
  if (base !== "" && base !== c && gsm7Units(base) !== null) return base;
  return LATIN_TRANSLITERATION.get(c) ?? "";
}

/** The label cut to `budget` GSM-7 units, at a word boundary where one exists. */
function withinUnits(label: string, budget: number): string {
  if ((gsm7Units(label) ?? Infinity) <= budget) return label;
  const chars = [...label];
  let units = 0;
  let cut = 0;
  for (; cut < chars.length; cut++) {
    const u = gsm7CharUnits(chars[cut]) ?? Infinity;
    if (units + u > budget) break;
    units += u;
  }
  let prefix = chars.slice(0, cut).join("");
  if (chars[cut] !== " ") {
    const lastSpace = prefix.lastIndexOf(" ");
    if (lastSpace > 0) prefix = prefix.slice(0, lastSpace);
  }
  return prefix.replace(TRAILING_SEPARATORS, "");
}

/** The join text's sender label: GSM-7 only, within its budget, never blank. */
function joinAckSenderLabel(studioName: string | null | undefined): string {
  const raw = typeof studioName === "string" ? studioName : "";
  let label = "";
  for (const c of raw.normalize("NFC")) label += gsm7LabelChar(c);
  label = withinUnits(label.replace(/ {2,}/g, " ").trim(), JOIN_ACK_LABEL_BUDGET);
  return LETTER_OR_DIGIT.test(label) ? label : JOIN_ACK_LABEL_FALLBACK;
}

/**
 * SMS-04. The one text a genuinely new self-service waitlist join gets, after
 * the entry is durably saved: who it is from, that they joined, and what
 * happens next. It carries NO LINK -- there is nothing to do yet, and a link
 * here could be mistaken for a way to rejoin -- and promises no position, slot
 * or date. The booking link only ever arrives with an invitation.
 *
 * Plain ASCII apostrophes on purpose: a typographic quote is outside the GSM-7
 * alphabet and would force the whole message into UCS-2, halving a segment.
 * For the same reason the studio name goes through the sender-label policy
 * above, so the whole text is always GSM-7 in one segment.
 */
export function buildWaitlistJoinAckSms(p: WaitlistJoinAckSmsInput): string {
  return `${joinAckSenderLabel(p.studioName)}${JOIN_ACK_COPY}`;
}
