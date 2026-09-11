"use server";

// WAIT-03 B3 — the recipient's server actions.
//
// THE CONTRACT THIS FILE KEEPS: every action returns an `InvitationViewState`
// and nothing else. That is not stylistic. `ResolveOutcome` carries
// `recipientContactHash`, `entryId` and `studioId`, and a Server Action's return
// value is serialised to the browser, so returning it -- or any object that
// structurally contains it -- would ship those to the client. The view state has
// no invitation field at all, so there is nothing to leak whatever a caller
// assigns. `deriveInvitationViewState` therefore runs HERE, on the server, not
// in the container.
//
// Three values never cross this boundary in either direction:
//   * the proof code     (secret; the browser types it, we never send it)
//   * the capability     (bearer; kept in an httpOnly cookie, below)
//   * proofChallengeId   (not secret, but a correlatable per-challenge handle
//                         with no business in browser state)

import { cookies, headers } from "next/headers";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  beginRecipientProof,
  completeRecipientProof,
  declineInvitation,
  resolveInvitation,
  type ResolveOutcome,
} from "@/lib/booking/waitlist-invitation";
import {
  deriveInvitationViewState,
  type BookingRefusal,
  type ProofNotice,
  filterSlotsToScope,
  slotWithinScope,
  groupSlotsByDay,
  proofStageFromBegin,
  proofStageFromComplete,
  type InvitationViewState,
  type OfferedSlot,
  type OfferPresentation,
  type ProofStage,
} from "@/lib/waitlist/invitation-offer";
// NOT `fetchPublicSlotsAction`: it rate-limits itself per call, so covering a
// window with it exhausts the caller's own quota and silently drops the tail.
// The range helper is throttled ONCE by this surface instead.
import { isBookableByNewClient } from "@/lib/booking/consultation";
import { fetchPublicSlotsForDates } from "@/lib/booking/public-slot-range";
import { horizonRangeInStudioTz } from "@/lib/booking/horizon";
import { localDateString, localTimeString12h, utcInstantFromLocal } from "@/lib/booking/tz";
import {
  limitPublicSlots,
  limitWaitlistProofRequest,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit/public";
// WAIT INTEGRATION-01 — the proof-delivery binding.
//
// WAIT DELIVERY-01 (#680) is MERGED into this candidate at
// e9e5fa63b7ca6a4e79f244d0548e2573811b51a6, not vendored. An earlier rebuild
// hand-copied seven of its files because #680 and the #686 chain then overlapped
// on nine, which made a branch merge unsafe. That overlap is now ZERO, so the
// merge is both simpler and safer: it carries #680's own tests, and it cannot go
// stale against the head it came from — which hand-vendoring silently did, and
// which is exactly how the proof-request limiter below went missing.
//
// NOTHING HERE REIMPLEMENTS DELIVERY, and this branch is not its authority:
// #680 remains the owner. The BINDING below is the only new code, because it is
// the one thing neither branch could contain alone — B2/B3 mint a challenge they
// cannot transmit, and Delivery can transmit a challenge it cannot mint.
import {
  sendWaitlistRecipientProofEmail,
  type DeliveryStudio,
} from "@/lib/waitlist/delivery/send";
import type { BeginProofOutcome } from "@/lib/booking/waitlist-invitation";

// ---------------------------------------------------------------------------
// The capability cookie
// ---------------------------------------------------------------------------
//
// The capability authorises the two mutations, so it is a bearer credential. It
// is kept in an httpOnly cookie rather than returned to the page: script on the
// invitation page then cannot read it, which matters because the page renders a
// studio-supplied service name.
//
// It is NOT an authority. The database re-checks it inside the locked mutation
// against THAT invitation's row, so a stale or mismatched cookie fails closed as
// `proof_invalid` rather than authorising anything. That is also why one cookie
// is enough: a second invitation verified in the same browser overwrites the
// first, and the first then simply asks for proof again.

const CAPABILITY_COOKIE = "wl_proof_capability";
/** The database owns the capability's 30 minutes; this only bounds the cookie. */
const CAPABILITY_COOKIE_MAX_AGE_SECONDS = 30 * 60;

// P3-A. The cookie is SIGNED and BOUND to one invitation.
//
// It used to hold the bare capability, and the first render treated the mere
// presence of any 64-hex value as proof -- so a hand-set cookie (devtools; page
// script cannot, it is httpOnly) rendered the slot list without proving. Nothing
// leaked, because those times are already public at /book/[slug], and booking
// still failed at the database. But the RENDER gate and the AUTHORITY gate were
// different things, and only one of them was checked.
//
// The value is now `<capability>.<hmac(sha256(token) + capability)>`, signed with
// the same APPOINTMENT_SIGNING_SECRET and verified with the same timing-safe
// compare the cancellation tokens use. A forged value fails the signature, and a
// capability minted for a DIFFERENT invitation fails the binding -- before
// anything renders, rather than at the database afterwards.

function proofSecret(): string | null {
  const secret = process.env.APPOINTMENT_SIGNING_SECRET;
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

// P3-A. The DATABASE's own expiry travels in the signed value.
//
// A valid signature proves only that we minted this cookie for this invitation.
// It says nothing about whether the capability is still live, so a reload inside
// the cookie's 30-minute max-age rendered the slot list as proven after the
// capability had already lapsed at the database. The recipient then picked a
// time and was bounced.
//
// `complete_waitlist_invitation_proof` returns the authoritative `expires_at`,
// so that value is carried and signed alongside the capability rather than a
// lifetime being re-invented here. It is covered by the same HMAC, so it cannot
// be edited to buy more time.
function bindingFor(
  rawToken: string,
  capability: string,
  expiresAtMs: string,
  secret: string,
): string {
  const bound = [
    createHash("sha256").update(rawToken, "utf8").digest("hex"),
    capability,
    expiresAtMs,
  ].join(".");
  return createHmac("sha256", secret).update(bound).digest("hex");
}

async function readCapability(rawToken: string): Promise<string | null> {
  const secret = proofSecret();
  // No secret configured is a FAIL-CLOSED condition, not a bypass: without it
  // nothing can be verified, so nothing is treated as proven.
  if (!secret) return null;
  const jar = await cookies();
  const v = jar.get(CAPABILITY_COOKIE)?.value;
  if (typeof v !== "string") return null;
  // Three dot-separated fields. The expiry is EPOCH MILLISECONDS, not an ISO
  // string: an ISO timestamp carries its own dot before the milliseconds, so it
  // would split into four parts and never parse.
  const [capability, expiresAtMs, signature] = v.split(".");
  if (!capability || !expiresAtMs || !signature) return null;
  if (!/^[a-f0-9]{64}$/.test(capability)) return null;
  if (!/^\d+$/.test(expiresAtMs)) return null;
  const expected = bindingFor(rawToken, capability, expiresAtMs, secret);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) {
    return null;
  }
  // Signed, bound -- and still live. An unreadable timestamp is treated as
  // lapsed rather than as permission.
  const expiry = Number(expiresAtMs);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
  return capability;
}

async function writeCapability(
  rawToken: string,
  capability: string,
  expiresAt: string,
): Promise<boolean> {
  const secret = proofSecret();
  // P3-B. Report the failure instead of swallowing it. Returning silently left
  // the caller free to say "proven" while no cookie existed, which looped the
  // recipient between a slot list and "we need proof" forever.
  if (!secret) return false;
  // The database's own expiry, as epoch millis so it survives the dot-separated
  // encoding. An expiry we cannot read is not written at all.
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) return false;
  const expiresAtMs = String(expiryMs);
  const jar = await cookies();
  jar.set(
    CAPABILITY_COOKIE,
    `${capability}.${expiresAtMs}.${bindingFor(rawToken, capability, expiresAtMs, secret)}`,
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/invitation",
      maxAge: CAPABILITY_COOKIE_MAX_AGE_SECONDS,
    },
  );
  return true;
}

async function clearCapability(): Promise<void> {
  const jar = await cookies();
  try {
    jar.set(CAPABILITY_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/invitation",
      maxAge: 0,
    });
  } catch {
    // COOKIES ARE ONLY MUTABLE IN THE ACTION PHASE. Next permits `cookies().set`
    // when `requestStore.phase === "action"` and throws
    // ReadonlyRequestCookiesError otherwise, and `loadInvitationAction` runs in
    // BOTH phases: `page.tsx` renders through it, and the container calls it as
    // an action on retry. The proof recovery below has to clear a rejected
    // capability from either, so a render-phase clear must degrade to a no-op
    // rather than turning a stale cookie into a 500 on the invitation page.
    //
    // SWALLOWING IS SAFE HERE BECAUSE THE COOKIE IS NOT AN AUTHORITY. The
    // database re-proves the capability inside every locked command, so a cookie
    // that survives one render grants nothing; the state returned is
    // proof-required either way, and the next action -- a retry or a code
    // request, both of which clear it -- drops it for good.
  }
}

// ---------------------------------------------------------------------------
// Server-side presentation lookup
// ---------------------------------------------------------------------------

type StudioContext = {
  slug: string;
  /** The studio's configured public booking horizon, or null for the default.
   *  Carried because the offered-day scan is bounded by it. */
  horizonMonths: number | null;
  /**
   * The sender identity the proof email is sent AS. Kept separate from
   * `presentation` on purpose: `presentation` is serialised to the browser, and
   * these are contact addresses that have no business crossing that boundary.
   */
  delivery: DeliveryStudio;
  presentation: OfferPresentation;
  /**
   * P2-A. Can the PUBLIC BOOKING PATH actually accept this service for a new
   * client? Answered by `isBookableByNewClient`, the same rule
   * `publicBookAppointmentAction` applies — not a second opinion about it.
   *
   * Carried rather than acted on inside the loader because the loader's `null`
   * means "we could not read this, try again", and this is the opposite: a
   * settled, permanent no. Collapsing the two would tell the recipient to
   * retry something that will never work.
   */
  bookableByNewClient: boolean;
};

/** First row of a `returns table` RPC payload, whatever shape the driver used. */
function firstIdentityRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

function identityField(row: Record<string, unknown> | null, k: string): string | null {
  const v = row?.[k];
  return typeof v === "string" ? v : null;
}

/**
 * The invited person's stored booking identity, read through the ACCEPTED 0192
 * command -- never off the table.
 *
 * WHY NOT A TABLE READ, which is what this was. It ran
 * `admin.from("new_client_waitlist_entries").select("name, email, phone")`, and
 * 0185 revoked EVERY table privilege on that table from `service_role` BY NAME,
 * deliberately and in writing, so that the server's most privileged client
 * cannot dump contact details directly:
 *
 *     has_table_privilege('service_role', 'public.new_client_waitlist_entries',
 *                         'SELECT')  =  false        PostgREST -> 42501
 *
 * So the read returned null ALWAYS -- everywhere, not just locally -- and
 * `bookInvitationSlotAction` stopped before it reached the booking engine.
 * Integration found it; no component suite could, because `offerState` tolerates
 * a null identity BY DESIGN (`phoneNeeded` merely goes false), so every
 * read-only surface stayed green while the one mutation that needs the identity
 * could not complete.
 *
 * THE REPAIR IS NOT A GRANT. Granting `service_role` SELECT would reverse 0185's
 * explicit privacy decision. 0192 instead carries a narrow, capability-gated
 * command that returns these three fields and nothing else, granted to
 * `service_role` alone. It re-proves the capability INSIDE its own locked
 * transaction against the same liveness set and the same digest comparison the
 * gated mutations use, so bearer possession alone, a wrong, stale, expired or
 * cross-invitation capability, and a redeemed, declined, released or expired
 * invitation each yield NO identity -- all three columns null, never a partial
 * one.
 *
 * Still read here rather than from `beginRecipientProof`'s `deliveryContact`:
 * that command mints a new challenge as a side effect, so using it as a lookup
 * would invalidate the code the recipient had just been sent and burn one of
 * their attempts.
 *
 * Server-side only. The capability is the httpOnly cookie's, never anything the
 * browser typed, and the identity is posted to the booking action, which
 * compares its hash against the stored recipient hash -- so the recipient never
 * types an address and a substituted one could not match anyway.
 */
type RecipientIdentity = { name: string; email: string; phone: string | null };

/**
 * THE THREE RESULTS THAT MEAN "THIS CAPABILITY IS NO LONGER PROOF".
 *
 * A CLOSED set, matched against 0192's own vocabulary. Everything else the
 * command can answer -- `not_live`, `invalid_token`, `invalid_input`,
 * `identity_unavailable` -- is NOT a statement about proof and must never be
 * reported as one.
 */
const PROOF_REFUSALS = new Set(["proof_required", "proof_expired", "proof_invalid"]);

/**
 * What the identity command said, kept as a RESULT rather than flattened.
 *
 * WHY THIS IS NOT `RecipientIdentity | null`. Collapsing every non-resolved
 * result to null lost the one distinction the recipient's recovery depends on.
 * A capability the DATABASE has rejected -- because a replacement challenge
 * cleared it, or it lapsed -- still has a valid HMAC and a future signed expiry
 * in the cookie, so this surface kept treating the browser as proven, kept
 * rendering the offer as proven, and every Book hit the same refusal: a loop
 * with no exit that a generic "try again" could not break, because trying again
 * is exactly what fails.
 *
 * The reason is carried for the SERVER's decision only. It never reaches the
 * browser: the recipient sees the existing `proof_lapsed` notice and nothing
 * more specific, so the vocabulary the screen renders is unchanged.
 */
type IdentityOutcome =
  | { kind: "resolved"; identity: RecipientIdentity }
  /** The database rejected the capability. The cookie must go and proof restarts. */
  | { kind: "proof_refused"; reason: string }
  /** Anything else: no proof claim is made, and the caller stays fail-closed. */
  | { kind: "unusable"; reason: string };

async function invitedIdentity(
  rawToken: string,
  capability: string,
): Promise<IdentityOutcome> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(
    "resolve_waitlist_invitation_recipient_identity",
    { p_raw_token: rawToken, p_raw_capability: capability },
  );
  // A TRANSPORT FAILURE IS NOT A PROOF FAILURE. Labelling it one would tell a
  // recipient whose proof is perfectly good to start over, and would drop a
  // live capability on the way.
  if (error) return { kind: "unusable", reason: "transport" };
  const row = firstIdentityRow(data);
  // ONLY `resolved` carries an identity. Every refusal names its reason and
  // returns all three columns null, so there is no partial row to assemble one
  // from -- and the reason is READ here rather than discarded, because whether
  // proof must restart is exactly what it says.
  const result = identityField(row, "result");
  if (result !== "resolved") {
    return result !== null && PROOF_REFUSALS.has(result)
      ? { kind: "proof_refused", reason: result }
      : { kind: "unusable", reason: result ?? "unreadable" };
  }
  const name = identityField(row, "name");
  const email = identityField(row, "email");
  // OPTIONAL BY CONSTRUCTION. The public join form says "Phone (optional)" and
  // `0185` stores the column nullable, so `null` here is an ordinary, expected
  // entry — not a broken row. It is returned as its own value rather than
  // folded into the truthiness check below, because a missing phone must NOT
  // make the identity unusable: it changes what the recipient is asked for, not
  // whether they may book.
  const rawPhone = identityField(row, "phone");
  const phone = rawPhone === null ? "" : rawPhone.trim();
  // A `resolved` row with no name or address is not an identity, and it is not
  // a proof failure either -- the capability was accepted. Fail closed without
  // claiming proof lapsed.
  return name && email
    ? { kind: "resolved", identity: { name, email, phone: phone.length > 0 ? phone : null } }
    : { kind: "unusable", reason: "incomplete" };
}

/**
 * The studio and service facts the screen shows. Read here rather than returned
 * by `resolveInvitation`, so the authority layer keeps returning identifiers and
 * this layer decides what is safe to render.
 */
async function loadStudioContext(
  studioId: string,
  serviceId: string,
): Promise<StudioContext | null> {
  const admin = createAdminClient();
  const [{ data: studio }, { data: service }] = await Promise.all([
    admin
      // The horizon comes along because the offered-day scan is bounded by it.
      // Reading it here costs nothing — this row is already being fetched — and
      // avoids the scan having to assume the default for a studio that
      // configured something else.
      .from("studios")
      // The two contact columns ride along for the SAME reason the horizon
      // does: this row is already being fetched, so reading them costs nothing,
      // and the proof email's reply-to is resolved from them. Omitting them
      // would not fail — `studioEmailIdentity` tolerates nulls — it would
      // silently send a client-facing email with no studio reply path, which is
      // the exact defect the COMMS-01A family guard exists to prevent.
      .select(
        "slug, name, timezone, public_booking_horizon_months, postcare_contact_email, owner_email",
      )
      .eq("id", studioId)
      .maybeSingle(),
    admin
      .from("services")
      // P2-A. `modality` and `active` are read for the ELIGIBILITY question
      // below, not for the screen. Neither reaches the browser: the
      // presentation this builds carries the service NAME and duration and
      // nothing else, and it is the only part of this row that travels.
      //
      // NOTE the absent `.eq("active", true)`. Filtering here would fold "this
      // service was deactivated" into "we could not read the studio", and the
      // loader answers that with a RETRYABLE error — telling the recipient to
      // try again on an offer that is permanently unusable. The row is read
      // whatever its state and judged one line down.
      .select("name, default_duration_minutes, modality, active")
      .eq("id", serviceId)
      .eq("studio_id", studioId)
      .maybeSingle(),
  ]);
  if (!studio?.slug || !studio?.name || !studio?.timezone) return null;
  if (!service?.name) return null;
  return {
    slug: studio.slug as string,
    horizonMonths: (studio.public_booking_horizon_months as number | null) ?? null,
    delivery: {
      id: studioId,
      name: studio.name as string,
      postcare_contact_email:
        (studio.postcare_contact_email as string | null) ?? null,
      owner_email: (studio.owner_email as string | null) ?? null,
    },
    presentation: {
      studioName: studio.name as string,
      serviceName: service.name as string,
      serviceDurationMinutes: (service.default_duration_minutes as number) ?? 0,
      studioTimezone: studio.timezone as string,
    },
    // THE BOOKING PATH'S OWN RULE, ASKED HERE. `scope_service_id` is honoured
    // by B2's scope evaluation, which decides whether a slot is INSIDE the
    // offer -- a question about the window, not about whether the service can
    // be booked by a new client at all. Nothing asked that second question, so
    // an invitation scoped to an ordinary treatment, or to a service since
    // deactivated, rendered selectable times that the booking command would
    // then refuse.
    bookableByNewClient: isBookableByNewClient({
      name: service.name as string,
      modality: (service.modality as string | null) ?? null,
      active: service.active === true,
    }),
  };
}

/** Resolve plus presentation, or a view state describing why we cannot. */
async function loadContext(
  rawToken: string,
): Promise<
  | {
      ok: true;
      resolve: Extract<ResolveOutcome, { kind: "live" }>;
      studio: StudioContext;
    }
  | { ok: false; state: InvitationViewState }
> {
  const resolved = await resolveInvitation(rawToken);
  if (resolved.kind !== "live") {
    return {
      ok: false,
      state: deriveInvitationViewState({
        resolve: resolved,
        presentation: null,
        proof: { kind: "required" },
        slots: [],
        booked: null,
        declined: false,
      }),
    };
  }
  const studio = await loadStudioContext(
    resolved.invitation.studioId,
    resolved.invitation.scope.serviceId,
  );
  if (!studio) {
    return { ok: false, state: { kind: "error", retryable: true } };
  }
  // =====================================================================
  // P2-A — AN OFFER THE BOOKING PATH CANNOT ACCEPT IS CLOSED HERE
  // =====================================================================
  // A waitlist invite-to-book is the NEW-CLIENT CONSULTATION path. An
  // invitation scoped to any other service is an offer this product cannot
  // honour, and the refusal belongs at the START of the journey rather than at
  // its end: the recipient must not be shown selectable times, must not be sent
  // a proof code for them, and must not tap Book to find out.
  //
  // NO BYPASS WAS ADDED, and that was the alternative. Teaching the booking
  // path to accept an arbitrary service "because an invitation says so" would
  // let an unconsulted new client book any treatment, which is the rule the
  // consultation-first requirement exists to hold. NO SUBSTITUTION EITHER: a
  // studio's actual consultation service is not silently swapped in, because
  // the recipient was told what they were offered and would be booked into
  // something else.
  //
  // ONE FUNNEL, DELIBERATELY. Every recipient action -- load, request proof,
  // submit proof, decline, book -- reaches its invitation through this
  // function, so the check cannot be missed by a surface added later. Decline
  // is closed WITH the rest and not exempted: declining requires the proof
  // exchange, and sending a real person a verification code for an offer that
  // can never be booked is the surface this is removing, not one to keep. The
  // operator releases the invitation from their side; the copy says so.
  if (!studio.bookableByNewClient) {
    return {
      ok: false,
      state: {
        kind: "closed",
        reason: "unsupported_offer",
        presentation: studio.presentation,
      },
    };
  }
  return { ok: true, resolve: resolved, studio };
}

// ---------------------------------------------------------------------------
// Slots — narrowed by the SAME evaluator the server enforces with
// ---------------------------------------------------------------------------

/**
 * Every offered slot inside the invitation's window, grouped by studio-local day.
 *
 * The narrowing runs on the SERVER. An out-of-scope slot is never serialised to
 * the browser, so it cannot be rendered as selectable even by a modified client
 * -- and the booking command re-checks scope independently anyway, so a forged
 * post fails there too.
 */
async function offeredDays(
  resolve: Extract<ResolveOutcome, { kind: "live" }>,
  studio: StudioContext,
) {
  const { scope } = resolve.invitation;
  const tz = studio.presentation.studioTimezone;

  // P2-B. THE WHOLE AUTHORISED WINDOW, not the first three weeks of it.
  //
  // This used to stop after 21 days with no pagination and no signal, so an
  // offer longer than that silently lost its tail: the final authorised days
  // were unreachable and the recipient was never told. 0192 constrains the scope
  // window only to `start <= end`, so a 30- or 60-day offer is perfectly legal,
  // and the cap counted from TODAY, so an offer already part-way through
  // truncated too.
  //
  // The cap is gone. Cost is controlled by asking a better question instead:
  //   * days the offer does not permit are never queried at all -- a
  //     "Mondays only" offer over eight weeks is eight reads, not fifty-six;
  //   * days already past in the studio's timezone are skipped;
  //   * the remainder run in parallel batches rather than one after another.
  //
  // The weekday test is B2's own `slotWithinScope` applied at noon, so this
  // introduces no second reading of the offer -- if the evaluator says a day is
  // out, it is out, by exactly the rule the booking command enforces.
  const today = localDateString(new Date(), tz);

  // THE SCAN IS BOUNDED BY THE STUDIO'S OWN BOOKING HORIZON, not by the scope
  // alone.
  //
  // `0192` constrains the scope only to `start <= end`, and the issuer takes
  // whatever dates the practitioner types. A slip — `2099-12-31`, or a mistyped
  // `9999-12-31` — used to be walked in full BEFORE the first fetch: tens of
  // thousands of date strings allocated, and in the pathological case the
  // invocation exhausted outright. The per-day horizon check could not protect
  // this loop, because it runs later, inside each fetch.
  //
  // The horizon is the authority on how far forward anyone may book at all, so
  // intersecting with it costs no real coverage — a date past it is not
  // bookable by any route — while making the walk finite by construction rather
  // than by a constant someone has to maintain.
  // The studio's OWN configured horizon, not the default: a studio on a
  // six-month horizon must not have its offer scanned as though it were on
  // three. `horizonRangeInStudioTz` normalises a null to the default itself.
  const horizon = horizonRangeInStudioTz(tz, studio.horizonMonths);
  const scanEnd = scope.endDate < horizon.maxDateStr ? scope.endDate : horizon.maxDateStr;

  const dates: string[] = [];
  let cursor = scope.startDate < today ? today : scope.startDate;
  while (cursor <= scanEnd) {
    // P2-D. LOCAL noon, resolved through the studio's zone -- not noon UTC.
    //
    // This used to build `new Date(cursor + "T12:00:00Z")` and claim it was
    // "noon in the studio's zone". It is not: for a studio at UTC+13 or +14 --
    // Auckland in southern daylight time, Chatham, Kiritimati -- noon UTC on one
    // date is the small hours of the NEXT local date. The filter then tested the
    // wrong weekday, so a "Mondays only" offer queried Sundays and skipped
    // Mondays, and the offer rendered empty.
    //
    // The direction of that error is what made it dangerous: a wrongly INCLUDED
    // day is harmless, because the collected slots are narrowed again below. A
    // wrongly EXCLUDED day is never queried at all, so its availability vanishes
    // silently -- the exact truncation this loop was rewritten to end.
    //
    // `utcInstantFromLocal` is the shared helper the rest of booking uses, and it
    // already handles a naive instant and its correction straddling a DST change.
    const noon = utcInstantFromLocal(cursor, "12:00", tz);
    if (
      slotWithinScope(scope, tz, {
        start: noon.toISOString(),
        end: noon.toISOString(),
        startLabel: "",
      })
    ) {
      dates.push(cursor);
    }
    const next = new Date(`${cursor}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }

  // ONE THROTTLE FOR THE WHOLE OPERATION, not one per day.
  //
  // This used to call `fetchPublicSlotsAction` per date, and that action
  // rate-limits itself: `limitPublicSlots` allows a bounded number of requests
  // per (IP, slug) per minute. A window wider than that allowance therefore
  // EXHAUSTED ITS OWN QUOTA — the remaining days came back `ok: false` and were
  // skipped by the `continue` below, so a long offer silently lost its tail
  // again, in production only, invisible to any test that does not configure a
  // limiter. A reload could spend an already-drained quota and show even less.
  //
  // Removing the day cap moved the truncation from an explicit constant to an
  // implicit, environment-dependent one. That is worse, not better: a constant
  // can be reasoned about and tested.
  //
  // So the surface gates ONCE, here, and then asks a non-action helper that
  // resolves the studio, its readiness and the service duration a single time.
  // A refusal is now the operation's refusal, and it is reported rather than
  // silently swallowed per day.
  const gate = await limitPublicSlots({ headers: await headers(), slug: studio.slug });
  if (!gate.allowed) return { days: [], unreadable: true };

  const range = await fetchPublicSlotsForDates({
    slug: studio.slug,
    serviceId: scope.serviceId,
    dates,
  });
  // ANY failure to read is UNREADABLE, not empty. Throttled, studio not found,
  // service withdrawn — none of them means "no times are open", and rendering
  // an empty offer would state that as a fact about the studio's diary.
  if (!range.ok) return { days: [], unreadable: true };

  const collected: OfferedSlot[] = range.slots.map((s) => ({
    start: s.start,
    end: s.end,
    startLabel: localTimeString12h(new Date(s.start), tz),
  }));
  // Still narrowed by the same evaluator: the day filter above is an
  // optimisation, never the authority, and nothing past endDate is collected.
  return {
    days: groupSlotsByDay(tz, filterSlotsToScope(scope, tz, collected)),
    unreadable: false,
  };
}

/**
 * BACK TO PROOF, WITH THE DEAD CAPABILITY DROPPED — the one recovery.
 *
 * This is the semantics the in-scope `invitation_refused` branch already used
 * when the booking authority rejected the capability, lifted out so the identity
 * command's rejection lands in exactly the same place. There is no second proof
 * model: one refusal shape, one notice, one state.
 */
async function proofLapsedState(
  resolve: Extract<ResolveOutcome, { kind: "live" }>,
  studio: StudioContext,
): Promise<InvitationViewState> {
  await clearCapability();
  return deriveInvitationViewState({
    resolve,
    presentation: studio.presentation,
    proof: { kind: "required" },
    // NO SLOTS. Times are shown only to a proven recipient, and this recipient
    // is no longer one.
    slots: [],
    booked: null,
    declined: false,
    proofNotice: "proof_lapsed",
  });
}

async function offerState(
  rawToken: string,
  resolve: Extract<ResolveOutcome, { kind: "live" }>,
  studio: StudioContext,
  proof: ProofStage,
  bookingRefusal?: BookingRefusal,
): Promise<InvitationViewState> {
  // BOTH READS ARE GATED ON PROOF, and for the same reason. Until a capability
  // exists there are no times to show and nothing to book, so an unproven
  // render must not pay for either — and must not disclose, to mere possession
  // of the link, whether the studio holds a phone number for this person.
  const proven = proof.kind === "proven";
  // THE CAPABILITY IS READ FROM THE COOKIE HERE rather than carried on
  // `ProofStage`. That type is the view model a Server Action returns to the
  // browser, and a bearer credential has no business in it — the same rule the
  // file header states for the code and the challenge id. `proven` without a
  // readable capability is a stale render, and it resolves no identity.
  const capability = proven ? await readCapability(rawToken) : null;
  const [offered, identity] = await Promise.all([
    proven
      ? offeredDays(resolve, studio)
      : Promise.resolve({ days: [], unreadable: false }),
    capability
      ? invitedIdentity(rawToken, capability)
      : Promise.resolve<IdentityOutcome>({ kind: "unusable", reason: "no_capability" }),
  ]);
  // THE DATABASE OUTRANKS THE COOKIE, AND IT DOES SO ON THE RENDER PATH TOO.
  //
  // A capability the database has rejected still has a valid HMAC and a future
  // signed expiry, so `readCapability` happily returns it and this render would
  // otherwise paint a proven offer with selectable times — which Book then
  // refuses, forever. Checked BEFORE `offered.unreadable`, because a rejected
  // capability is the stronger and more actionable truth: "try again" is the one
  // instruction that cannot work here.
  if (identity.kind === "proof_refused") return proofLapsedState(resolve, studio);
  // A THROTTLED READ IS NOT AN EMPTY DIARY. Rendering the offer with no days
  // would say "nothing is open in the times held for you" about dates nobody
  // looked at — the same false statement the day cap used to make, arriving by
  // a different route. It is a retryable failure, and the screen already has
  // the words and the button for that.
  if (offered.unreadable) return { kind: "error", retryable: true };
  const slots = offered.days.flatMap((d) => d.slots);
  return deriveInvitationViewState({
    resolve,
    presentation: studio.presentation,
    proof,
    slots,
    booked: null,
    declined: false,
    bookingRefusal,
    // An unreadable identity is NOT treated as "no phone": that would ask a
    // recipient to supply one the studio may already hold. It stays false, the
    // Book attempt then fails closed, and the booking path reports it.
    phoneNeeded: identity.kind === "resolved" && identity.identity.phone === null,
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** First paint. Possession of the link shows the offer and asks for proof. */
export async function loadInvitationAction(
  rawToken: string,
): Promise<InvitationViewState> {
  const ctx = await loadContext(rawToken);
  if (!ctx.ok) return ctx.state;
  // A capability already in the jar means this browser proved recently. The
  // database still re-checks it at the mutation, so trusting it for RENDERING
  // only cannot authorise anything.
  const proven = (await readCapability(rawToken)) !== null;
  return offerState(
    rawToken,
    ctx.resolve,
    ctx.studio,
    proven ? { kind: "proven" } : { kind: "required" },
  );
}

/**
 * Send a proof code to the STORED contact. The recipient supplies no address and
 * cannot redirect delivery.
 */
export async function requestInvitationProofAction(
  rawToken: string,
): Promise<InvitationViewState> {
  const gate = await limitPublicSlots({
    headers: await headers(),
    slug: "invitation-proof",
  });
  if (!gate.allowed) {
    return {
      kind: "proof",
      presentation: PLACEHOLDER,
      windowDescription: RATE_LIMIT_MESSAGE,
      stage: { kind: "unavailable", retryable: true },
    };
  }
  const ctx = await loadContext(rawToken);
  if (!ctx.ok) return ctx.state;

  // WAIT INTEGRATION-01 — THE DELIVERY POLICY'S OWN LIMITS, ENFORCED.
  //
  // The gate above is the cheap pre-resolve IP throttle every public surface
  // runs; it bounds unresolvable tokens and knows nothing about this flow. It is
  // NOT the proof-request policy. #680 states that policy in
  // `PROOF_REQUEST_LIMITS` (3 per invitation / 15m, 10 per IP-and-studio / 1h)
  // and ships `limitWaitlistProofRequest` to enforce it — with ZERO callers,
  // because the limiter lives on #680 and the only call site lives on #686, and
  // the two are siblings off production. Neither branch can wire it; only an
  // assembly can. Unwired, the exported "policy" was decorative and one link
  // could be made to mail a real person without bound.
  //
  // IT RUNS HERE, AFTER RESOLVE AND BEFORE THE MINT. `invitationId` and
  // `studioId` are server-resolved row ids that exist only once `loadContext`
  // has run, and keying on the invitation id keeps the bearer token out of the
  // key derivation entirely. Placing it before `beginRecipientProof` is the
  // whole point: a refusal must cost no challenge, because minting one retires
  // the previous code in the recipient's inbox.
  //
  // FAIL OPEN, by #680's own classified ruling: a limiter outage must not strand
  // a prospect who has no other route to the code.
  const proofGate = await limitWaitlistProofRequest({
    headers: await headers(),
    studioId: ctx.resolve.invitation.studioId,
    invitationId: ctx.resolve.invitation.invitationId,
  });
  if (!proofGate.allowed) {
    // The offer itself is intact and still resolves, so this returns the proof
    // screen with the throttle message rather than a terminal state.
    return offerState(rawToken, ctx.resolve, ctx.studio, {
      kind: "unavailable",
      retryable: true,
    });
  }

  const begun = await beginRecipientProof(rawToken);

  // ISSUING A NEW CHALLENGE INVALIDATES THE OLD CAPABILITY, so the cookie that
  // carried it must go with it.
  //
  // `begin_waitlist_invitation_proof` clears the database capability when it
  // mints a replacement. The cookie DOES carry the database's own expiry, signed
  // alongside the capability — but that timestamp only says when the capability
  // would have lapsed ON ITS OWN. It cannot describe one invalidated EARLY by a
  // replacement, and nothing in the cookie is revisited when that happens. So
  // leaving it in place meant a later reload verified the signature, saw an
  // expiry that had not yet passed, and rendered `proven` against a capability
  // the database would already reject.
  //
  // It is reachable without anything exotic: a second tab still showing the
  // proof form, or the `decline_unavailable` path that returns the proof screen
  // without clearing its cookie. Requesting a fresh code is the ordinary thing
  // to do from either.
  // Everything that is NOT an issued challenge has no code to deliver and no
  // capability to invalidate, so it is mapped by B3's own exhaustive mapper and
  // never reaches the transport.
  if (begun.kind !== "challenge_issued") {
    return offerState(rawToken, ctx.resolve, ctx.studio, proofStageFromBegin(begun));
  }

  await clearCapability();

  const stage = await deliverProofChallenge(
    begun,
    ctx.studio.delivery,
    ctx.resolve.invitation.invitationId,
  );
  return offerState(rawToken, ctx.resolve, ctx.studio, stage);
}

// ---------------------------------------------------------------------------
// The proof-delivery binding
// ---------------------------------------------------------------------------
//
// Module-level and given its inputs EXPLICITLY rather than closing over the
// action's `ctx`. Both values it needs are server-resolved authority — the
// studio it sends as, and the invitation the challenge belongs to — and passing
// them by parameter is what makes it impossible for a future edit to reach for a
// request-supplied one instead.
async function deliverProofChallenge(
  issued: Extract<BeginProofOutcome, { kind: "challenge_issued" }>,
  studio: DeliveryStudio,
  invitationId: string,
): Promise<ProofStage> {
  // BOTH INSTANTS ARE THE DATABASE'S OWN, and neither is computed here.
  //
  // ADJUDICATED: `issued_at` is authority returned by 0192, never derived. The
  // accepted 0192 returns the POST-LOCK `clock_timestamp()` it also wrote into
  // `proof_challenge_expires_at`, and B2's `instant()` validates the
  // serialization and hands back the ORIGINAL string unchanged. An earlier
  // revision of this binding reconstructed it as `expires_at - requested TTL`;
  // that inversion is FORBIDDEN, as is the application clock. Both are gone.
  //
  // Parsing the returned strings is not deriving them: `Date` is the shape the
  // delivery module takes, and a value that does not parse is refused below
  // rather than replaced.
  const issuedAt = new Date(issued.issuedAt);
  const expiresAt = new Date(issued.expiresAt);
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    // Unparseable authority is NOT a licence to invent one. Without both
    // instants the advertised window cannot be stated truthfully, so nothing is
    // sent. The challenge is spent at the database either way; requesting again
    // mints a fresh one.
    return { kind: "unavailable", retryable: true };
  }

  const result = await sendWaitlistRecipientProofEmail({
    studio,
    invitationId,
    challengeId: issued.proofChallengeId,
    // The STORED contact, returned by the database from the entry. The
    // recipient supplies no address at any point in this action.
    recipientEmail: issued.deliveryContact,
    code: issued.rawChallenge,
    issuedAt,
    expiresAt,
    // Proof gates BOTH mutations, but the code is minted per challenge and not
    // per outcome; the copy names booking because that is what the recipient
    // came to do.
    action: "book",
  });

  // DISPOSITION -> STAGE, decided on `delivered`, never on a boolean.
  //
  // `unknown` is grouped with `yes` deliberately. Custody is ambiguous, so the
  // code MAY be in the recipient's inbox — and under the one-shot law it is
  // spent regardless. Showing "we couldn't send it" there would be a lie in the
  // one direction that costs something: they would never try the code that did
  // arrive. Showing the entry form lets a delivered code work, and requesting
  // again is the sanctioned recovery (`mint_new_challenge`) if it did not.
  if (result.disposition.delivered !== "no") {
    return {
      kind: "sent",
      maskedContact: issued.maskedContact,
      expiresAt: issued.expiresAt,
    };
  }
  // Nothing reached the provider. `sameEventRetryAllowed` is true only for a
  // pre-send clock disagreement, where nothing is spent; every other refusal
  // still recovers by minting a NEW challenge, which this same button does. So
  // the control stays live either way — what differs is whether the next press
  // replays the event or mints a replacement, and that is Delivery's decision,
  // not the screen's.
  return { kind: "unavailable", retryable: true };
}

/** Exchange a typed code for a capability. */
export async function submitInvitationProofAction(
  rawToken: string,
  code: string,
  // Carried back from the stage the recipient is looking at, so a failure can
  // keep showing WHICH address the code went to and when it lapses. Blanking
  // that mid-exchange loses their place.
  previous: { maskedContact: string; expiresAt: string },
): Promise<InvitationViewState> {
  // THROTTLED BEFORE THE FIRST DATABASE READ, and independently of the
  // database's own attempt counter.
  //
  // 0192 bounds a challenge to five wrong GUESSES. It does not bound REQUEST
  // VOLUME, and the two are different protections. Without a limiter here an
  // invalid token drove unlimited indexed lookups on a public endpoint, and —
  // worse — a caller holding a VALID token could keep submitting past the fifth
  // attempt, taking the invitation row's lock each time merely to be told
  // `too_many_attempts`, contending with the legitimate verification or
  // redemption the real recipient is trying to complete. The attempt counter
  // cannot stop that, because it is consulted only after the row is reached.
  //
  // The gate runs FIRST, so a refusal costs no read at all.
  const gate = await limitPublicSlots({
    headers: await headers(),
    slug: "invitation-proof-submit",
  });
  if (!gate.allowed) {
    return {
      kind: "proof",
      presentation: PLACEHOLDER,
      windowDescription: RATE_LIMIT_MESSAGE,
      stage: { kind: "unavailable", retryable: true },
    };
  }

  const ctx = await loadContext(rawToken);
  if (!ctx.ok) return ctx.state;

  const completed = await completeRecipientProof(
    rawToken,
    code.trim().toLowerCase(),
  );
  if (completed.kind === "verified") {
    // P3-B. Only claim `proven` if the capability was actually retained. It used
    // to be claimed unconditionally, so a server with no signing secret painted
    // the slot list, then refused every Book for want of a cookie it had never
    // written -- an unexplained loop with no way out.
    const kept = await writeCapability(
      rawToken,
      completed.rawCapability,
      completed.expiresAt,
    );
    if (!kept) {
      // P3-C. Drop any cookie already in the jar before telling the recipient to
      // start again. `complete_` has just overwritten the invitation's capability
      // hash, so an older cookie is dead at the database -- but its signature is
      // still valid and its expiry may not have passed, so a reload would render
      // it as proven and contradict the message they were just given.
      await clearCapability();
      return deriveInvitationViewState({
        resolve: ctx.resolve,
        presentation: ctx.studio.presentation,
        proof: { kind: "required" },
        slots: [],
        booked: null,
        declined: false,
        proofNotice: "proof_not_retained",
      });
    }
    return offerState(rawToken, ctx.resolve, ctx.studio, { kind: "proven" });
  }
  return offerState(
    rawToken,
    ctx.resolve,
    ctx.studio,
    proofStageFromComplete(completed, previous),
  );
}

/** Decline. Requires the capability; the link alone cannot reach it. */
export async function declineInvitationAction(
  rawToken: string,
): Promise<InvitationViewState> {
  const capability = await readCapability(rawToken);
  // P2-A. THE CONTEXT IS RESOLVED BEFORE THE COMMAND, NOT ONLY AFTER IT FAILS.
  //
  // This read used to happen on two paths -- no capability, and failed decline
  // -- so a decline holding a live capability reached the authority WITHOUT
  // passing the funnel every other recipient action passes. The eligibility
  // check added to `loadContext` would have had a hole in exactly the shape of
  // this action, and "every surface is covered" would have been false the day
  // it was written.
  //
  // Resolving first also refuses one command that used to be issued: a decline
  // against an invitation that is already dead now returns that terminal state
  // instead of asking the database to decline it and interpreting the answer.
  // Same screen, one fewer mutation attempted.
  const ctx = await loadContext(rawToken);
  if (!ctx.ok) return ctx.state;
  if (!capability) {
    return offerState(rawToken, ctx.resolve, ctx.studio, { kind: "required" });
  }
  const out = await declineInvitation({ rawToken, rawCapability: capability });
  if (out.kind === "declined") {
    await clearCapability();
    return { kind: "declined" };
  }

  // P3-B. A failed decline used to return the proof screen with no explanation,
  // so the recipient's tap appeared to do nothing and they had no idea whether
  // the studio had been told.
  //
  // RE-RESOLVE, and it must be a second read rather than the one above: the
  // invitation can die (revoked, expired, already redeemed) between that read
  // and this failure, and that terminal state is the truth and outranks any
  // notice.
  const after = await loadContext(rawToken);
  if (!after.ok) return after.state;

  // The capability did not satisfy the gate, so it is worthless -- drop it
  // rather than leaving a dead credential to fail again on the next tap.
  const notice: ProofNotice =
    out.kind === "unavailable" ? "decline_unavailable" : "proof_lapsed";
  if (notice === "proof_lapsed") await clearCapability();

  return deriveInvitationViewState({
    resolve: after.resolve,
    presentation: after.studio.presentation,
    proof: { kind: "required" },
    slots: [],
    booked: null,
    declined: false,
    proofNotice: notice,
  });
}

/**
 * Book one offered slot.
 *
 * REUSES THE PUBLIC BOOKING ENGINE. This posts to `publicBookAppointmentAction`
 * with the invitation credentials attached; it does not create appointments
 * itself. That action owns the slot re-check, the client identity rules, the
 * studio lock and the consume ordering, and it is the only booking engine.
 */
export async function bookInvitationSlotAction(
  rawToken: string,
  startsAt: string,
  typedPhone?: string,
): Promise<InvitationViewState> {
  const capability = await readCapability(rawToken);
  const ctx = await loadContext(rawToken);
  if (!ctx.ok) return ctx.state;
  if (!capability) {
    return offerState(rawToken, ctx.resolve, ctx.studio, { kind: "required" });
  }

  const { publicBookAppointmentAction } = await import("@/app/book/[slug]/actions");
  const fd = new FormData();
  fd.set("slug", ctx.studio.slug);
  fd.set("service_id", ctx.resolve.invitation.scope.serviceId);
  fd.set("starts_at", startsAt);
  fd.set("client_type", "new");
  // The invited contact is the stored one. The recipient never types an address:
  // the booking action compares the submitted email's hash against the stored
  // recipient hash, so a typed address could only ever match the real one.
  const invited = await invitedIdentity(rawToken, capability);
  // THE REJECTED CAPABILITY IS RECOVERABLE, and only this branch knows it. A
  // generic retryable error left the dead cookie in place and sent the
  // recipient around the same loop; the proof restart is the exit.
  if (invited.kind === "proof_refused") return proofLapsedState(ctx.resolve, ctx.studio);
  // Everything else keeps the existing fail-closed semantics EXACTLY, and
  // deliberately is not dressed up as a lapsed proof: a transport failure, an
  // invitation that closed under us, or an incomplete row says nothing about
  // whether this recipient proved themselves.
  if (invited.kind !== "resolved") return { kind: "error", retryable: true };
  const identity = invited.identity;
  fd.set("email", identity.email);
  fd.set("name", identity.name);

  // THE PHONE, WHICH THIS OMITTED ENTIRELY AND SO COULD NEVER BOOK.
  //
  // `publicBookAppointmentAction` rejects a new-client submission with no phone
  // at an unconditional gate, BEFORE it reaches invitation authorization or
  // redemption. Sending name and email alone meant every recipient booking
  // stopped at "Please enter a phone number" — the offer, the proof and the
  // scope were all correct and the journey still could not complete.
  //
  // THE STORED NUMBER WINS. It is the invited person's own datum, already held
  // by the studio; preferring a typed one would let whoever holds the link
  // overwrite it on the client record this booking creates. A typed number is
  // read ONLY where the entry has none, which is an ordinary case because the
  // join form makes phone optional.
  const phone = identity.phone ?? (typeof typedPhone === "string" ? typedPhone.trim() : "");
  if (!phone) {
    // Fail BEFORE the booking action, so the recipient is asked for the number
    // on the offer they are already looking at rather than being handed the
    // public form's error for a field this surface never showed them.
    return offerState(rawToken, ctx.resolve, ctx.studio, { kind: "proven" });
  }
  fd.set("phone", phone);

  fd.set("invitation_token", rawToken);
  fd.set("invitation_capability", capability);

  const booked = await publicBookAppointmentAction(fd);
  if (!booked.ok && booked.code === "invitation_consumed") {
    // P2-A. THE OFFER IS SPENT. The redeem committed and the appointment did
    // not, so re-rendering the offer would show live, selectable times for an
    // invitation that can never book again -- and every retry would fail the
    // same silent way.
    //
    // `ctx.resolve` was read BEFORE the attempt and still says `live`, so the
    // terminal state is stated here rather than derived from a stale read. The
    // capability is dropped with it: it authorises nothing now.
    //
    // B2 records the consumed-without-booking event with the invitation id, and
    // its own copy tells the recipient to contact the studio; `already_redeemed`
    // is the view state that matches, and it is the only honest one available.
    await clearCapability();
    return {
      kind: "closed",
      reason: "consumed_without_booking",
      presentation: ctx.studio.presentation,
    };
  }
  if (booked.ok) {
    await clearCapability();
    const tz = ctx.studio.presentation.studioTimezone;
    const at = new Date(startsAt);
    return deriveInvitationViewState({
      resolve: ctx.resolve,
      presentation: ctx.studio.presentation,
      proof: { kind: "proven" },
      slots: [],
      booked: {
        startLabel: localTimeString12h(at, tz),
        dateLabel: localDateString(at, tz),
      },
      declined: false,
    });
  }
  // P2-A. `invitation_refused` is AMBIGUOUS by the time it reaches here: the
  // booking action emits it both when the requested slot is outside the offer
  // AND when the capability failed the gate. Treating it as one thing told a
  // recipient whose proof had simply lapsed to "choose one of the times shown",
  // which is wrong -- the time was fine -- and left the dead cookie in place to
  // fail identically on the next tap.
  //
  // The two are separable here, and WITHOUT a second scope rule: ask B2's own
  // evaluator whether the slot was in the offer. In scope means the refusal was
  // about authority, so the capability is dropped and the recipient is returned
  // to proof. Out of scope means the offer stands and the slot did not.
  if (!booked.ok && booked.code === "invitation_refused") {
    const tz = ctx.studio.presentation.studioTimezone;
    const inScope = slotWithinScope(ctx.resolve.invitation.scope, tz, {
      start: startsAt,
      end: startsAt,
      startLabel: "",
    });
    if (inScope) return proofLapsedState(ctx.resolve, ctx.studio);
  }

  // Every other refusal leaves the offer usable, so it is shown WITH the reason.
  return offerState(
    rawToken,
    ctx.resolve,
    ctx.studio,
    { kind: "proven" },
    bookingRefusalFor(booked),
  );
}

/**
 * Map the booking command's refusal onto the closed set the screen renders.
 *
 * `invitation_consumed` is deliberately absent: it is handled above as a
 * terminal state, and returning it here would put "your invitation has been
 * used" above live, selectable times.
 */
function bookingRefusalFor(result: {
  ok: false;
  code?: string;
}): BookingRefusal {
  switch (result.code) {
    case "slot_taken":
      return "slot_taken";
    case "invitation_refused":
      return "not_permitted";
    default:
      // No code, or one this layer does not recognise: IN DOUBT, never a
      // confident "that time is taken".
      return "unavailable";
  }
}

/** Placeholder presentation for the pre-resolve rate-limit path. */
const PLACEHOLDER: OfferPresentation = {
  studioName: "",
  serviceName: "",
  serviceDurationMinutes: 0,
  studioTimezone: "UTC",
};
