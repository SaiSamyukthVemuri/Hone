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
        if (!rawToken || !invitationId) return { kind: "unavailable" };
        return { kind: "issued", invitationId, rawToken };
      }
      case "no_round_open":
      case "round_full":
      case "unknown_studio":
      case "invalid_service":
      case "invalid_scope_dates":
      case "invalid_weekdays":
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
      const rawWeekdays = row?.scope_allowed_weekdays;
      const weekdaysReadable =
        (rawWeekdays === null ||
          rawWeekdays === undefined ||
          Array.isArray(rawWeekdays)) &&
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
      const rawChallenge = str(row, "raw_challenge");
      // 0192 returns the challenge's own id as `challenge_id`. B2 surfaces it as
      // `proofChallengeId` so the delivery layer has a non-secret event identity
      // and never has to reach for the code. A row missing it is IN DOUBT rather
      // than half-issued: sending a challenge that cannot be keyed would leave
      // the send un-idempotent.
      const proofChallengeId = str(row, "challenge_id");
      if (!deliveryContact || !expiresAt || !rawChallenge || !proofChallengeId) {
        return { kind: "unavailable" };
      }
      return {
        kind: "challenge_issued",
        proofChallengeId,
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
