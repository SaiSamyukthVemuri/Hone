// COMMS-01A. The ONE place a studio-branded sender identity is constructed.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Hone's transactional mail goes out as `Hone <hello@hone.care>` with no
// Reply-To. That was fine while the only studio was one Sam already knew. For a
// studio whose clients have never heard of "Hone", it means a confirmation from
// an unrecognised brand, and pressing Reply reaches Hone rather than the studio.
//
// WHAT DOES NOT CHANGE
// ---------------------------------------------------------------------------
// The ENVELOPE ADDRESS stays `hello@hone.care` on the one verified sender
// domain. A studio never supplies a From address: that would need per-studio DNS
// and would put Hone's deliverability reputation in a stranger's hands. The
// studio name is DISPLAY TEXT ONLY, and the reply address is derived from
// server-side studio authority, never from request input.
//
// HEADER SAFETY IS THE POINT OF THE SANITISER
// ---------------------------------------------------------------------------
// A studio name is operator-supplied text that ends up inside a mail header. A
// bare newline in it is header injection: everything after the CRLF becomes a
// new header, which is how a sender adds their own Bcc. The sanitiser therefore
// strips control characters rather than escaping them, and the result is
// constrained to one line of safe display text.
//
// Pure module: no I/O, no secrets, no server-only import.

/** The single verified sender address. Never per-studio. */
export const SENDER_ADDRESS = "hello@hone.care";

/** Fallback display name when no studio identity is available. */
export const FALLBACK_DISPLAY_NAME = "Hone";

/** Bounded so a long name cannot push a header past a sane length. */
export const MAX_DISPLAY_NAME_LENGTH = 60;

/**
 * Reduce an operator-supplied studio name to one line of safe display text.
 *
 * Removes, in order: everything that can terminate or extend a header (CR, LF,
 * NUL and other C0/C1 controls), the RFC 5322 specials that would need quoting
 * (`<> ( ) [ ] : ; @ \ , " `), then collapses whitespace and caps the length.
 *
 * Deliberately a REMOVER, not an escaper. An escaped `"` inside a display name
 * is valid but invites a second implementation to un-escape it; removing the
 * character means there is nothing to get wrong later.
 */
export function sanitizeStudioDisplayName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    // C0 + DEL + C1 controls, which is where CR and LF live.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    // RFC 5322 specials that would otherwise require quoting.
    .replace(/[<>()[\]:;@\\,"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The From header.
 *
 *   "Willow Electrolysis via Hone <hello@hone.care>"   with a studio
 *   "Hone <hello@hone.care>"                           without one
 *
 * The fallback is deliberately today's exact value, so a studio whose name
 * sanitises to nothing is indistinguishable from current behaviour rather than
 * producing something malformed like " via Hone".
 */
export function buildFromHeader(studioName: string | null | undefined): string {
  const safe = sanitizeStudioDisplayName(studioName);
  const display = safe ? `${safe} via Hone` : FALLBACK_DISPLAY_NAME;
  return `${display} <${SENDER_ADDRESS}>`;
}

/**
 * RFC 5322 `atext` — every character permitted in an UNQUOTED local atom.
 * `:` is deliberately absent, which is what rejects `front:desk@example.com`.
 */
const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";

/** dot-atom: non-empty atoms joined by SINGLE dots. No leading, trailing or doubled dot. */
const LOCAL_DOT_ATOM = new RegExp(`^[${ATEXT}]+(?:\\.[${ATEXT}]+)*$`);

/**
 * ASCII domain labels, no leading or trailing hyphen, each bounded to the DNS
 * limit of 1..63 octets, with a 2..63 alpha TLD.
 *
 * The bound is not pedantry. An over-long label cannot resolve, so a Reply-To
 * carrying one is undeliverable and the provider may reject the whole message —
 * the exact failure this validator exists to prevent. `{0,61}` between the two
 * mandatory edge characters is what makes each label 1..63.
 */
const DOMAIN_DOT_ATOM =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/**
 * Conservative address validation for Reply-To.
 *
 * Not an RFC 5322 parser, and deliberately not: this decides whether a value is
 * SAFE TO PUT IN A HEADER and plausible as an address, and it rejects rather
 * than repairs. A rejected address yields NO Reply-To, which is the honest
 * outcome — a fabricated or half-cleaned reply address is worse than none,
 * because a client's reply then goes somewhere nobody reads.
 */
export function isSafeReplyToAddress(raw: string | null | undefined): raw is string {
  if (typeof raw !== "string") return false;
  const v = raw.trim();
  if (v.length === 0 || v.length > 254) return false;
  // Any control character, whitespace or comma disqualifies it outright: those
  // are the header-injection and multi-recipient vectors.
  if (/[\u0000-\u001f\u007f-\u009f\s,;<>()[\]\\"]/.test(v)) return false;
  // Dot-atom on BOTH sides. The previous pattern accepted mailbox strings that
  // are not valid unquoted addresses — `front:desk@x.test`, `.a@x.test`,
  // `a..b@x.test` — and handing one of those to the transport risks the whole
  // transactional email being rejected rather than merely losing its Reply-To.
  const at = v.lastIndexOf("@");
  if (at <= 0 || at === v.length - 1) return false;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (local.length > 64 || domain.length > 253) return false;
  return LOCAL_DOT_ATOM.test(local) && DOMAIN_DOT_ATOM.test(domain);
}

/**
 * Resolve the Reply-To, or null.
 *
 * NEVER falls back to the client's address, and never invents one. Absent or
 * malformed authority means the header is omitted entirely and replies keep
 * today's behaviour.
 */
export function resolveReplyTo(studioContactEmail: string | null | undefined): string | null {
  const v = typeof studioContactEmail === "string" ? studioContactEmail.trim() : "";
  return isSafeReplyToAddress(v) ? v : null;
}

/**
 * The studio's client-facing contact address.
 *
 * THIS IS NOT A NEW AUTHORITY. It is the precedence the product already uses
 * for the postcare Contact line — `postcare_contact_email` overriding
 * `owner_email` — which the practitioner already sets and already sees surfaced
 * in Settings. `postcareContactEmail` in send-appointment.ts delegates here so
 * the two can never diverge.
 *
 * RECORDED LIMITATION: `postcare_contact_email` is NAMED for postcare. A studio
 * that set it to an aftercare-specific inbox will now receive general replies
 * there. That is judged better than replies reaching Hone, and it is the reason
 * no schema was added this week — inventing a `studios.reply_to_email` column
 * for one week's polish would be a migration bought with a guess about what
 * studios want. If that turns out wrong, the fix is a real contact field with a
 * real UI, not a wider fallback here.
 */
export function studioClientContactEmail(studio: {
  postcare_contact_email?: string | null;
  owner_email?: string | null;
}): string | null {
  // Precedence is over VALID authorities, not over non-blank strings. A studio
  // whose postcare address is malformed (legacy rows, or a value the looser
  // Settings validator let through) must still reach its owner address — the
  // earlier "first non-blank" reading silently sent those studios' replies to
  // Hone, which is the opposite of this module's purpose.
  const override = studio.postcare_contact_email?.trim();
  if (isSafeReplyToAddress(override)) return override;
  const fallback = studio.owner_email?.trim();
  if (isSafeReplyToAddress(fallback)) return fallback;
  return null;
}

/** What a caller hands the transport. Both fields are server-resolved. */
export type StudioEmailIdentity = {
  /** Raw studio name; the transport sanitises it. */
  displayName: string | null;
  /** Already-resolved contact address, or null. */
  replyTo: string | null;
};

/** Build the identity from a studio row, in one step, server-side. */
export function studioEmailIdentity(studio: {
  name?: string | null;
  postcare_contact_email?: string | null;
  owner_email?: string | null;
}): StudioEmailIdentity {
  return {
    displayName: studio.name ?? null,
    replyTo: resolveReplyTo(studioClientContactEmail(studio)),
  };
}
