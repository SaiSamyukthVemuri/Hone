// WAIT-03B B2 — server authority for scoped waitlist invitations.
//
// SERVER ONLY. Every operation runs through createAdminClient(), so service_role
// authority never reaches a browser. The accepted B1/B1.5c commands are granted
// to service_role alone; there is no browser-reachable path to any of them.
//
// THE DATABASE REMAINS THE AUTHORITY. This module does not re-derive admission,
// tenancy, recipient proof or lifecycle -- it calls the accepted commands and
// translates their closed result codes into typed outcomes. It adds exactly one
// thing the database cannot do: the requested-slot half of scope enforcement
// (see waitlist-invitation-scope.ts for why that cannot live in SQL).
//
// NOTHING HERE THROWS ACROSS THE BOUNDARY. Every failure is a typed outcome, so
// a caller cannot accidentally treat an error as a success, and an unexpected
// transport failure is reported as IN DOUBT rather than as a refusal.

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { localDateString, localDayOfWeek } from "@/lib/booking/tz";
import {
  evaluateInvitationScope,
  type InvitationScope,
  type ScopeRefusal,
} from "@/lib/booking/waitlist-invitation-scope";

// ---------------------------------------------------------------------------
// Contact hashing. The raw invited address never leaves the database through the
// resolve path; the server compares SHA-256 of the normalised address, exactly
// as the accepted resolve_ command computes it.
// ---------------------------------------------------------------------------

export function contactHash(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length === 0) return null;
  return createHash("sha256").update(v, "utf8").digest("hex");
}

/**
 * Constant-time-ish comparison of two hex digests. Both sides are server-derived
 * SHA-256 hex of the same length, so a length mismatch is already a refusal.
 */
function hashEquals(a: string | null, b: string | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Typed outcomes. B3/B4 consume these.
// ---------------------------------------------------------------------------

/** Transport or unrecognised-code failure: the caller must treat it as IN DOUBT. */
export type Unavailable = { kind: "unavailable" };

export type IssueOutcome =
  | { kind: "issued"; invitationId: string; rawToken: string }
  | { kind: "no_round_open" }
  | { kind: "round_full" }
  | { kind: "unknown_studio" }
  | { kind: "invalid_service" }
  | { kind: "invalid_scope_dates" }
  | { kind: "invalid_weekdays" }
  /**
   * Documented lifecycle refusals, passed through by `issue_scoped_` from the
   * applied issue command it delegates to (0192, the `elsif v_issue.result in
   * (...)` branch) plus its own `already_declined_offer`.
   *
   * These were falling through the default arm as `unavailable`, which says
   * TRANSPORT FAILED / IN DOUBT. They are the opposite: the database answered,
   * definitively, and the answer is actionable. Collapsing them lost the
   * distinction between "we do not know what happened" and "the entry has
   * already been invited".
   */
  | { kind: "already_declined_offer" }
  | { kind: "already_invited" }
  | { kind: "invalid_ttl" }
  | { kind: "not_claimed" }
  | { kind: "not_found" }
  | { kind: "invalid_input" }
  | { kind: "not_authorized" }
  | Unavailable;

export type ResolvedInvitation = {
  invitationId: string;
  studioId: string;
  entryId: string;
  scope: InvitationScope;
  expiresAt: string;
  recipientContactHash: string;
};

export type ResolveOutcome =
  | { kind: "live"; invitation: ResolvedInvitation }
  | { kind: "invalid_token" }
  | { kind: "already_redeemed" }
  | { kind: "declined" }
  | { kind: "released" }
  | { kind: "expired" }
  | { kind: "unscoped" }
  | Unavailable;

export type BeginProofOutcome =
  | {
      kind: "challenge_issued";
      /**
       * The challenge's own durable, NON-SECRET identity, minted by the database.
       *
       * This is what the delivery layer keys its proof-send idempotency on. It
       * exists precisely so that nothing has to be derived from the code: a
       * digest of the code would be an offline verifier over a small code space,
       * and keying on the invitation id would collapse successive challenges for
       * one invitation into a single key -- which is exactly when a replayed
       * provider response does the most harm.
       *
       * SERVER-SIDE ONLY, though for a different reason than the two fields
       * below. It is not a secret and leaking it would not let anyone prove
       * anything; it simply has no business in browser state, where it would
       * become a correlatable per-challenge handle for no benefit. B3 renders
       * `maskedContact` and nothing else from this variant.
       */
      proofChallengeId: string;
      /**
       * When the database MINTED this challenge — 0192's `issued_at`, which is
       * the post-lock `clock_timestamp()` it also computed `expires_at` from.
       *
       * TAKEN FROM THE RPC, never reconstructed. Deriving it as
       * `expires_at - ttl` would put the caller's arithmetic back into a value
       * the database owns, and reading a local clock would be a second clock:
       * neither can be trusted to agree with the row. Because both come from
       * the same instant, `expiresAt - issuedAt` is exactly the accepted TTL by
       * construction.
       *
       * SERVER-SIDE ONLY, like `deliveryContact` and `proofChallengeId`. The
       * delivery layer needs it to say when a code was issued; a browser has no
       * use for it, and it is not part of any view state.
       */
      issuedAt: string;
      /**
       * THE PROOF CODE. Returned exactly once, by the call that minted it: the
       * database stores only its SHA-256, so it cannot be read back afterwards
       * by anyone, this server included. The delivery layer must hand it
       * straight to the message body and keep it out of everything else -- no
       * log line, no idempotency key, no rate-limit key, no error string, and
       * nothing DERIVED from it either. The code space is small, so a stable
       * hash or a prefix is an offline verifier, not a redaction.
       *
       * Idempotency identity comes from `proofChallengeId` above. It must never
       * come from this value, in whole, hashed, or truncated.
       */
      rawChallenge: string;
      /** DB-owned. Never recomputed here; the stored value is the only truth. */
      expiresAt: string;
      deliveryContact: string;
      maskedContact: string;
    }
  | { kind: "invalid_token" }
  | { kind: "not_live" }
  | { kind: "invalid_input" }
  | Unavailable;

export type CompleteProofOutcome =
  | { kind: "verified"; rawCapability: string; expiresAt: string }
  | { kind: "wrong_challenge" }
  | { kind: "no_challenge" }
  | { kind: "challenge_expired" }
  | { kind: "too_many_attempts" }
  | { kind: "recipient_changed" }
  | { kind: "invalid_token" }
  | { kind: "not_live" }
  | { kind: "invalid_input" }
  | Unavailable;

// P2-1. The authorised outcome is BRANDED with a symbol this module does not
// export. Only `authorizeInvitationForBooking` can produce one, so
// `consumeInvitationForBooking` cannot be called with a hand-built object or
// with loose token/capability strings: the compiler enforces AUTHORISE -> THEN
// CONSUME, rather than a comment asking callers to remember the order.
declare const AUTHORIZED_BRAND: unique symbol;

/** Proof that authorisation ran. Only this module can mint one. */
export type AuthorizedBooking = {
  readonly [AUTHORIZED_BRAND]: true;
  kind: "authorized";
  invitation: ResolvedInvitation;
  /** The token authorisation actually validated -- consume must not be told a different one. */
  rawToken: string;
};

/** Non-consuming pre-authorisation, evaluated before any mutation. */
export type BookingAuthorization =
  | AuthorizedBooking
  | { kind: "scope_refused"; reason: ScopeRefusal }
  | { kind: "wrong_studio" }
  | { kind: "recipient_mismatch" }
  | { kind: "not_live"; detail: ResolveOutcome["kind"] }
  | Unavailable;

export type RedeemOutcome =
  | { kind: "redeemed"; studioId: string; entryId: string }
  | { kind: "proof_required" }
  | { kind: "proof_expired" }
  | { kind: "proof_invalid" }
  | { kind: "invalid_token" }
  | { kind: "not_live" }
  | { kind: "invalid_input" }
  | Unavailable;

export type RevokeOutcome =
  | { kind: "released" }
  | { kind: "already_redeemed" }
  | { kind: "not_releasable" }
  | { kind: "invalid_input" }
  | { kind: "not_authorized" }
  | Unavailable;

export type ExpireOutcome =
  | { kind: "expired" }
  | { kind: "not_expired" }
  | { kind: "already_redeemed" }
  | { kind: "not_invited" }
  | { kind: "invalid_input" }
  | { kind: "not_authorized" }
  | Unavailable;

export type DeclineOutcome =
  | { kind: "declined"; entryId: string }
  | { kind: "proof_required" }
  | { kind: "proof_expired" }
  | { kind: "proof_invalid" }
  | { kind: "invalid_token" }
  | { kind: "not_live" }
  | { kind: "invalid_input" }
  | Unavailable;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RAW_SECRET = /^[a-f0-9]{64}$/;

/** A single row out of a `returns table (...)` RPC. */
function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown>) ?? null;
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return null;
}

function resultOf(row: Record<string, unknown> | null): string | null {
  const r = row?.result;
  return typeof r === "string" ? r : null;
}

function str(row: Record<string, unknown> | null, k: string): string | null {
  const v = row?.[k];
  return typeof v === "string" ? v : null;
}

/**
 * A column that must be a REAL INSTANT, returned unchanged when it is one.
 *
 * SCOPED TO THE SERIALISATION THIS RPC ACTUALLY RECEIVES, not to dates in
 * general. Observed directly from the local stack -- `to_json(timestamptz)` is
 * what PostgREST emits -- the forms are:
 *
 *     2026-09-08T17:28:32.375192+00:00     (microsecond fraction)
 *     2026-09-10T12:05:00+00:00            (no fraction when it is zero)
 *
 * always `T`-separated, always seconds, always an explicit offset, never `Z`
 * from this server. The fraction is bounded at ONE TO SIX digits, PostgreSQL's
 * own microsecond precision: an unbounded `\d+` admitted
 * "...32.1234567+00:00", which this serializer cannot emit, and `Date.parse`
 * silently TRUNCATED the excess rather than refusing it -- the same
 * normalise-instead-of-reject behaviour the calendar check exists to defeat. `Z` is accepted anyway because it is an explicit timezone
 * and a different serialiser may use it; nothing looser is.
 *
 * WHY A SHAPE IS NOT ENOUGH ON ITS OWN. `Date.parse` NORMALISES rather than
 * refuses: it reads "2026-02-30T12:00:00Z" as March 2 and "0" as the year 2000,
 * so a nonexistent date would have arrived at the delivery layer as a real
 * instant. The calendar fields are therefore round-tripped through `Date.UTC`
 * and compared back; a value that moved is a value that never existed.
 *
 * It VALIDATES WITHOUT TRANSFORMING: the caller gets the database's own text
 * back, byte for byte. Re-serialising would make this module a second authority
 * on how an instant is spelled, when the database is the only one.
 */
const DB_TIMESTAMPTZ =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function instant(row: Record<string, unknown> | null, k: string): string | null {
  const v = str(row, k);
  if (v === null) return null;
  const m = DB_TIMESTAMPTZ.exec(v);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);

  // Clock fields have no calendar to catch them: Date.UTC would happily roll
  // hour 24 into the next day, so they are bounded here.
  if (hour > 23 || minute > 59 || second > 59) return null;

  // The calendar round-trip, which carries the whole date check on its own:
  // Feb 30 becomes March 2, month 13 rolls into the next year, day 00 falls back
  // into the previous month. Any field coming back different is proof the date
  // does not exist. An explicit month/day range test above it was redundant --
  // removing it left every rejected class still red under negative control.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  // Belt and braces: a shape and calendar that pass must still parse.
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * Mask a contact for display. B3 must be able to say WHERE the code went without
 * the browser learning the address it does not already have.
 */
export function maskContact(contact: string): string {
  const at = contact.indexOf("@");
  if (at <= 0) return "•••";
  const local = contact.slice(0, at);
  const domain = contact.slice(at + 1);
  const head = local.slice(0, 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";
  return `${head}${"•".repeat(Math.max(local.length - 1, 1))}@${"•".repeat(
    Math.max((dot >= 0 ? dot : domain.length), 1),
  )}${tld}`;
}

// ---------------------------------------------------------------------------
// 1. ISSUE — practitioner-authorised
// ---------------------------------------------------------------------------

/**
 * Issue a scoped invitation. Studio and actor are derived from the SESSION, never
 * from the caller: a practitioner cannot issue into a studio they are not an
 * active member of, because the studio id passed to the command is the one the
 * session resolved.
 */
export async function issueScopedInvitation(input: {
  entryId: string;
  serviceId: string;
  startDate: string;
  endDate: string;
  allowedWeekdays?: number[] | null;
  ttlHours?: number;
}): Promise<IssueOutcome> {
  const actor = await sessionActor();
  if (!actor) return { kind: "not_authorized" };

  const admin = createAdminClient();
  try {
    const { data, error } = await admin.rpc(
      "issue_scoped_new_client_waitlist_invitation",
      {
        p_studio_id: actor.studioId,
        p_entry_id: input.entryId,
        p_actor_user_id: actor.actorUserId,
        p_service_id: input.serviceId,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_allowed_weekdays: input.allowedWeekdays ?? null,
        p_ttl_hours: input.ttlHours ?? 72,
      },
    );
    if (error) return { kind: "unavailable" };
    const row = firstRow(data);
    const result = resultOf(row);
    switch (result) {
      case "issued": {
        const rawToken = str(row, "raw_token");
        const invitationId = str(row, "invitation_id");
        // A SUCCESS that cannot carry the secret is not a success. `issued` was
        // returned for any non-empty string, so a truncated, upper-cased or
        // otherwise malformed token would have been handed on as a working
        // invitation URL -- one the database could never match back, since it
        // stores only the SHA-256 of the real one. Held to the same RAW_SECRET
        // contract every other caller here already uses.
        //
        // Nothing is mutated. The row exists either way; this is the RESPONSE
        // boundary refusing to describe it as usable.
        if (!invitationId || !rawToken || !RAW_SECRET.test(rawToken)) {
          return { kind: "unavailable" };
        }
        return { kind: "issued", invitationId, rawToken };
      }
      case "no_round_open":
      case "round_full":
      case "unknown_studio":
      case "invalid_service":
      case "invalid_scope_dates":
      case "invalid_weekdays":
      // Documented refusals the command passes through. A recognised closed
      // result keeps its own kind; only an UNRECOGNISED one becomes unavailable.
      case "already_declined_offer":
      case "already_invited":
      case "invalid_ttl":
      case "not_claimed":
      case "not_found":
      // The sixth member of 0192's passthrough list, reported last round rather
      // than swept in with the other five. Same defect class: a definitive
      // refusal must not read as in-doubt.
      case "invalid_input":
        return { kind: result };
      default:
        // An unrecognised code is IN DOUBT, never a silent success.
        return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// 2. RESOLVE — safe public view
// ---------------------------------------------------------------------------

/**
 * Read-only. Returns only what a recipient may safely see plus the server-side
 * recipient hash; the raw invited address is never returned by this path.
 */
export async function resolveInvitation(rawToken: string): Promise<ResolveOutcome> {
  if (!RAW_SECRET.test(rawToken ?? "")) return { kind: "invalid_token" };
  const admin = createAdminClient();
  try {
    const { data, error } = await admin.rpc("resolve_new_client_waitlist_invitation", {
      p_raw_token: rawToken,
    });
    if (error) return { kind: "unavailable" };
    const row = firstRow(data);
    const result = resultOf(row);
    if (result === "live") {
      const invitationId = str(row, "invitation_id");
      const studioId = str(row, "studio_id");
      const entryId = str(row, "entry_id");
      const serviceId = str(row, "scope_service_id");
      const startDate = str(row, "scope_start_date");
      const endDate = str(row, "scope_end_date");
      const expiresAt = str(row, "expires_at");
      const recipientContactHash = str(row, "recipient_contact_hash");
      // P2-A. The canonical allowed-weekday authority is the database's
      // smallint[] (extract(dow), 0 = Sunday), with SQL NULL meaning "every day
      // inside the range". Those are the ONLY two readings this layer accepts.
      //
      // Anything else is NOT re-interpreted here -- parsing a Postgres array
      // literal, a comma string or a bare number would be a SECOND weekday
      // authority competing with the database's, which is exactly what must not
      // exist. It fails CLOSED instead, alongside every other scope column.
      //
      // The previous code coerced any non-array to `null`, so an unreadable
      // authority silently widened a restricted offer to every day.
      //
      // P3-D. Container shape is not enough. `Number()` turns null and "" into 0
      // (Sunday) and true into 1 (Monday), so a stray ELEMENT would silently mint
      // a weekday nobody offered -- and the range check downstream cannot catch
      // it, because coercion has already produced a legal day. Postgres allows
      // NULL elements in a smallint[], and both the 0192 CHECK and the issue
      // command test membership with `<@`, which yields NULL rather than false
      // when an element is NULL, so such an array can be stored.
      //
      // Only two element REPRESENTATIONS are accepted: a number, or a string of
      // digits (some drivers return smallint[] that way). Everything else fails
      // closed. This is representation only -- the 0..6 RANGE remains the scope
      // evaluator's rule, so there is still exactly one weekday authority.
      // PRESENCE IS NOT THE SAME AS NULL, and conflating them is a scope widening.
      // An explicit SQL NULL means "every day inside the range" and arrives as a key
      // holding null. A field that is ABSENT means the row never stated a weekday
      // authority at all -- a contract drift, a renamed column, a projection that
      // forgot it. Treating that absence as NULL turned a Mondays-only offer into an
      // any-day one, silently, exactly when the response was least trustworthy.
      //
      // So the key must BE there. Then it is either NULL, or an array whose elements
      // are representations a smallint[] can actually arrive in.
      // PRESENCE IS NOT THE SAME AS NULL, and conflating them is a scope widening.
      // An explicit SQL NULL means "every day inside the range"; a field that is
      // ABSENT means the row never stated a weekday authority at all -- a contract
      // drift, a renamed column, a projection that forgot it. `undefined` used to sit
      // in this accepted set beside `null`, so that absence turned a Mondays-only
      // offer into an any-day one, silently, exactly when the response was least
      // trustworthy.
      //
      // Only two readings are accepted now: SQL NULL, or an array whose elements are
      // representations a smallint[] can actually arrive in. A missing key reads as
      // `undefined` and is neither, so it fails closed with no separate presence
      // test -- one was written here and negative control proved it changed nothing.
      const rawWeekdays = row?.scope_allowed_weekdays;
      const weekdaysReadable =
        (rawWeekdays === null || Array.isArray(rawWeekdays)) &&
        (!Array.isArray(rawWeekdays) ||
          rawWeekdays.every(
            (n) =>
              typeof n === "number" ||
              (typeof n === "string" && /^\s*\d+\s*$/.test(n)),
          ));
      const allowedWeekdays = Array.isArray(rawWeekdays)
        ? rawWeekdays.map((n) => Number(n))
        : null;
      if (
        !invitationId || !studioId || !entryId || !serviceId ||
        !startDate || !endDate || !expiresAt || !recipientContactHash ||
        !weekdaysReadable
      ) {
        return { kind: "unavailable" };
      }
      return {
        kind: "live",
        invitation: {
          invitationId, studioId, entryId, expiresAt, recipientContactHash,
          scope: { serviceId, startDate, endDate, allowedWeekdays },
        },
      };
    }
    switch (result) {
      case "invalid_token":
      case "already_redeemed":
      case "declined":
      case "released":
      case "expired":
      case "unscoped":
        return { kind: result };
      default:
        return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// 3. CAPABILITY ACQUISITION — the accepted B1.5c proof lifecycle
// ---------------------------------------------------------------------------

/**
 * Start recipient proof. The challenge is delivered to the STORED contact; the
 * caller supplies no address and cannot redirect delivery.
 *
 * `deliveryContact` is returned for the SERVER to hand to a delivery transport.
 * It must never be returned to a browser -- B3 shows `maskedContact`.
 */
export async function beginRecipientProof(
  rawToken: string,
  ttlMinutes = 15,
): Promise<BeginProofOutcome> {
  if (!RAW_SECRET.test(rawToken ?? "")) return { kind: "invalid_token" };
  const admin = createAdminClient();
  try {
    const { data, error } = await admin.rpc("begin_waitlist_invitation_proof", {
      p_raw_token: rawToken,
      p_ttl_minutes: ttlMinutes,
    });
    if (error) return { kind: "unavailable" };
    const row = firstRow(data);
    const result = resultOf(row);
    if (result === "challenge_issued") {
      const deliveryContact = str(row, "delivery_contact");
      const expiresAt = str(row, "expires_at");
      // The accepted SQL has always returned this; the wrapper simply stopped
      // discarding it, which is what left the delivery layer with a challenge
      // it could not send. No SQL, contract or lifecycle rule changes here.
      // The proof code holds the SAME secret contract completeRecipientProof
      // enforces on the way back in, so a malformed one could never verify.
      // Accepting it would hand the delivery layer a code guaranteed to fail,
      // and tell the recipient to type it.
      const rawChallenge = str(row, "raw_challenge");
      // 0192 returns the challenge's own id as `challenge_id`. B2 surfaces it as
      // `proofChallengeId` so the delivery layer has a non-secret event identity
      // and never has to reach for the code. A row missing it is IN DOUBT rather
      // than half-issued: sending a challenge that cannot be keyed would leave
      // the send un-idempotent.
      const proofChallengeId = str(row, "challenge_id");
      // 0192's authoritative mint instant. A row that cannot state WHEN it minted
      // the challenge is IN DOUBT, not half-issued: the delivery layer would
      // otherwise have to invent the time it reports to the recipient.
      // Validated as a REAL INSTANT, not merely as a string: a malformed value
      // would otherwise reach the delivery layer as an unusable mint time.
      const issuedAt = instant(row, "issued_at");
      if (
          !deliveryContact ||
          !expiresAt ||
          !rawChallenge ||
        !RAW_SECRET.test(rawChallenge) ||
          !proofChallengeId ||
          !issuedAt
        ) {
        return { kind: "unavailable" };
      }
      return {
        kind: "challenge_issued",
        proofChallengeId,
        issuedAt,
        rawChallenge,
        expiresAt,
        deliveryContact,
        maskedContact: maskContact(deliveryContact),
      };
    }
    switch (result) {
      case "invalid_token":
      case "not_live":
      case "invalid_input":
        return { kind: result };
      default:
        return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Exchange a correct challenge for a short-lived capability.
 *
 * THE TTL IS NOT A PARAMETER HERE, AND MUST NOT BECOME ONE. B1.5c removed caller
 * authority over it: the command is `(text, text)` and the database owns 30
 * minutes. Adding a TTL argument to this wrapper would be re-introducing exactly
 * the authority the accepted contract took away.
 */
export async function completeRecipientProof(
  rawToken: string,
  rawChallenge: string,
): Promise<CompleteProofOutcome> {
  if (!RAW_SECRET.test(rawToken ?? "")) return { kind: "invalid_token" };
  if (!RAW_SECRET.test(rawChallenge ?? "")) return { kind: "invalid_input" };
  const admin = createAdminClient();
  try {
    const { data, error } = await admin.rpc("complete_waitlist_invitation_proof", {
      p_raw_token: rawToken,
      p_raw_challenge: rawChallenge,
    });
    if (error) return { kind: "unavailable" };
    const row = firstRow(data);
    const result = resultOf(row);
    if (result === "verified") {
      const rawCapability = str(row, "raw_capability");
      const expiresAt = str(row, "expires_at");
      if (!rawCapability || !expiresAt) return { kind: "unavailable" };
      return { kind: "verified", rawCapability, expiresAt };
    }
    switch (result) {
      case "wrong_challenge":
      case "no_challenge":
      case "challenge_expired":
      case "too_many_attempts":
      case "recipient_changed":
      case "invalid_token":
      case "not_live":
      case "invalid_input":
        return { kind: result };
      default:
        return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// 4. BOOKING AUTHORISATION — non-consuming, runs BEFORE any mutation
// ---------------------------------------------------------------------------

/**
 * Decide whether this invitation authorises this exact request, WITHOUT
 * consuming it. Every binding the accepted contract expects of B2 is checked
 * here: tenancy, recipient, and scope.
 *
 * The capability is deliberately NOT checked here. Checking it here and acting
 * on it later would be precisely the check-then-act split B1.5c retired the
 * `validate_` oracle to eliminate. The capability is proved inside the locked
 * mutation, by `consumeInvitationForBooking`.
 */
export async function authorizeInvitationForBooking(input: {
  rawToken: string;
  studioId: string;
  studioTimezone: string;
  requestedServiceId: string;
  requestedStartsAt: Date;
  /** The address typed into the booking form. NOT identity -- it must MATCH. */
  submittedEmail: string;
}): Promise<BookingAuthorization> {
  const resolved = await resolveInvitation(input.rawToken);
  if (resolved.kind === "unavailable") return { kind: "unavailable" };
  if (resolved.kind !== "live") return { kind: "not_live", detail: resolved.kind };

  const inv = resolved.invitation;

  // TENANCY. The invitation must belong to the studio being booked. This is the
  // cross-studio boundary at the application layer; the database enforces its own
  // independently inside the mutation.
  if (inv.studioId !== input.studioId) return { kind: "wrong_studio" };

  // RECIPIENT. A browser-supplied email is NOT identity authority. It is accepted
  // only when it hashes to the stored invited contact, so a substituted address
  // cannot ride an otherwise-valid invitation.
  if (!hashEquals(contactHash(input.submittedEmail), inv.recipientContactHash)) {
    return { kind: "recipient_mismatch" };
  }

  const decision = evaluateInvitationScope({
    scope: inv.scope,
    requestedServiceId: input.requestedServiceId,
    requestedStartsAt: input.requestedStartsAt,
    studioTimezone: input.studioTimezone,
    localDateString,
    localDayOfWeek,
  });
  if (!decision.ok) return { kind: "scope_refused", reason: decision.reason };

  // The brand is a type-level marker only; nothing reads it at runtime.
  return {
    kind: "authorized",
    invitation: inv,
    rawToken: input.rawToken,
  } as AuthorizedBooking;
}

// ---------------------------------------------------------------------------
// 5. REDEEM — the consuming mutation
// ---------------------------------------------------------------------------

/**
 * Consume the invitation. Proof is validated INSIDE this command's own locked
 * transaction, so a bearer token alone cannot reach the mutation.
 *
 * ORDERING, STATED HONESTLY: this is called immediately before the appointment
 * command, not after it. Redeeming first means a failed appointment leaves a
 * CONSUMED invitation and no booking. That invitation CANNOT be reissued:
 * release_new_client_waitlist_entry answers `already_redeemed` once any
 * invitation for the entry has been redeemed, so release -> requeue -> claim ->
 * issue_scoped_ is closed. Recovery is the studio booking the client DIRECTLY
 * through the operator surface, which the new-client gate never intercepts.
 * Booking
 * first would risk two appointments from one invitation, breaking the admission
 * guarantee that is the entire point of the waitlist. The window between the two
 * is one RPC round trip and cannot be closed without putting the booking engine
 * inside the database, which would mean a second booking engine.
 */
export async function consumeInvitationForBooking(
  authorization: AuthorizedBooking,
  rawCapability: string,
): Promise<RedeemOutcome> {
  // The token comes from the authorisation, never from a second caller-supplied
  // value, so consume cannot be pointed at an invitation that was never
  // authorised for this request.
  const rawToken = authorization.rawToken;
  if (!RAW_SECRET.test(rawToken ?? "")) return { kind: "invalid_token" };
  if (!RAW_SECRET.test(rawCapability ?? "")) return { kind: "proof_invalid" };
  const admin = createAdminClient();
  try {
    const { data, error } = await admin.rpc(
      "redeem_new_client_waitlist_invitation_verified",
      { p_raw_token: rawToken, p_raw_capability: rawCapability },
    );
    if (error) return { kind: "unavailable" };
    const row = firstRow(data);
    const result = resultOf(row);
    if (result === "redeemed") {
      const studioId = str(row, "studio_id");
      const entryId = str(row, "entry_id");
      if (!studioId || !entryId) return { kind: "unavailable" };
      return { kind: "redeemed", studioId, entryId };
    }
    switch (result) {
      case "proof_required":
      case "proof_expired":
      case "proof_invalid":
      case "invalid_token":
      case "not_live":
      case "invalid_input":
        return { kind: result };
      default:
        return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// 6. DECLINE
// ---------------------------------------------------------------------------

export async function declineInvitation(input: {
  rawToken: string;
  rawCapability: string;
}): Promise<DeclineOutcome> {
  if (!RAW_SECRET.test(input.rawToken ?? "")) return { kind: "invalid_token" };
  if (!RAW_SECRET.test(input.rawCapability ?? "")) return { kind: "proof_invalid" };
  const admin = createAdminClient();
  try {
    const { data, error } = await admin.rpc("decline_new_client_waitlist_invitation", {
      p_raw_token: input.rawToken,
      p_raw_capability: input.rawCapability,
    });
    if (error) return { kind: "unavailable" };
    const row = firstRow(data);
    const result = resultOf(row);
    if (result === "declined") {
      const entryId = str(row, "entry_id");
      if (!entryId) return { kind: "unavailable" };
      return { kind: "declined", entryId };
    }
    switch (result) {
      case "proof_required":
      case "proof_expired":
      case "proof_invalid":
      case "invalid_token":
      case "not_live":
      case "invalid_input":
        return { kind: result };
      default:
        return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// 7. REVOKE and EXPIRE — practitioner-authorised lifecycle
//
// Neither is a new command. The applied chain has no `revoke_..._invitation`:
// releasing the ENTRY is what invalidates a live capability, because every proof
// command requires a live invitation and a released row is not live. The B1.5
// suite proves that directly (P12).
//
// Both commands return a scalar text code rather than a row, so they are read
// differently from the table-returning commands above.
// ---------------------------------------------------------------------------

/** Studio and actor for a practitioner-authorised lifecycle command. */
async function sessionActor(): Promise<{ studioId: string; actorUserId: string } | null> {
  try {
    const ctx = await getCurrentPractitionerWithStudio();
    const studioId = ctx.studio.id;
    const actorUserId = ctx.practitioner.user_id;
    if (!studioId || !actorUserId) return null;
    return { studioId, actorUserId };
  } catch {
    return null;
  }
}

function scalarCode(data: unknown): string | null {
  if (typeof data === "string") return data;
  const row = firstRow(data);
  if (!row) return null;
  // A scalar-returning RPC may still arrive wrapped; take the sole value.
  const values = Object.values(row);
  const only = values.length === 1 ? values[0] : row.result;
  return typeof only === "string" ? only : null;
}

/**
 * Revoke an outstanding offer. This is the ONLY early-cancel path: `expire_`
 * refuses unless expiry is genuinely due, so it cannot be used to pull an offer
 * back before its window closes.
 */
export async function revokeInvitation(input: { entryId: string }): Promise<RevokeOutcome> {
  const actor = await sessionActor();
  if (!actor) return { kind: "not_authorized" };
  const admin = createAdminClient();
  try {
    const { data, error } = await admin.rpc("release_new_client_waitlist_entry", {
      p_studio_id: actor.studioId,
      p_entry_id: input.entryId,
      p_actor_user_id: actor.actorUserId,
    });
    if (error) return { kind: "unavailable" };
    switch (scalarCode(data)) {
      case "released":
        return { kind: "released" };
      case "already_redeemed":
      case "not_releasable":
      case "invalid_input":
        return { kind: scalarCode(data) as "already_redeemed" | "not_releasable" | "invalid_input" };
      default:
        return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Record wall-clock expiry for an invitation whose window has actually passed.
 * `not_expired` is a correct, expected answer, not an error: the command refuses
 * to expire anything early, which is what stops this becoming a second revoke.
 */
export async function expireInvitation(input: { entryId: string }): Promise<ExpireOutcome> {
  const actor = await sessionActor();
  if (!actor) return { kind: "not_authorized" };
  const admin = createAdminClient();
  try {
    const { data, error } = await admin.rpc("expire_new_client_waitlist_invitation", {
      p_studio_id: actor.studioId,
      p_entry_id: input.entryId,
      p_actor_user_id: actor.actorUserId,
    });
    if (error) return { kind: "unavailable" };
    const code = scalarCode(data);
    switch (code) {
      case "expired":
      case "not_expired":
      case "already_redeemed":
      case "not_invited":
      case "invalid_input":
        return { kind: code };
      default:
        return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
}
