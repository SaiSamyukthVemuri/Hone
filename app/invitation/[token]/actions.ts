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
import { fetchPublicSlotsAction } from "@/app/book/[slug]/actions";
import { localDateString, localTimeString12h, utcInstantFromLocal } from "@/lib/booking/tz";
import { limitPublicSlots, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";

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

function bindingFor(rawToken: string, capability: string, secret: string): string {
  const bound = `${createHash("sha256").update(rawToken, "utf8").digest("hex")}.${capability}`;
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
  const [capability, signature] = v.split(".");
  if (!capability || !signature) return null;
  if (!/^[a-f0-9]{64}$/.test(capability)) return null;
  const expected = bindingFor(rawToken, capability, secret);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) {
    return null;
  }
  return capability;
}

async function writeCapability(rawToken: string, capability: string): Promise<void> {
  const secret = proofSecret();
  if (!secret) return;
  const jar = await cookies();
  jar.set(CAPABILITY_COOKIE, `${capability}.${bindingFor(rawToken, capability, secret)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/invitation",
    maxAge: CAPABILITY_COOKIE_MAX_AGE_SECONDS,
  });
}

async function clearCapability(): Promise<void> {
  const jar = await cookies();
  jar.set(CAPABILITY_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/invitation",
    maxAge: 0,
  });
}

// ---------------------------------------------------------------------------
// Server-side presentation lookup
// ---------------------------------------------------------------------------

type StudioContext = {
  slug: string;
  presentation: OfferPresentation;
};

/**
 * The invited person's stored identity.
 *
 * Read from the entry, NOT by calling `beginRecipientProof` for its
 * `deliveryContact`: that command mints a new challenge as a side effect, so
 * using it as a lookup would invalidate the code the recipient had just been
 * sent and burn one of their attempts.
 *
 * Server-side only. It is posted to the booking action, which compares its hash
 * against the stored recipient hash -- so the recipient never types an address
 * and a substituted one could not match anyway.
 */
async function invitedIdentity(
  entryId: string,
  studioId: string,
): Promise<{ name: string; email: string; phone: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("new_client_waitlist_entries")
    .select("name, email, phone")
    .eq("id", entryId)
    .eq("studio_id", studioId)
    .maybeSingle();
  const name = typeof data?.name === "string" ? data.name : null;
  const email = typeof data?.email === "string" ? data.email : null;
  // OPTIONAL BY CONSTRUCTION. The public join form says "Phone (optional)" and
  // `0185` stores the column nullable, so `null` here is an ordinary, expected
  // entry — not a broken row. It is returned as its own value rather than
  // folded into the truthiness check below, because a missing phone must NOT
  // make the identity unusable: it changes what the recipient is asked for, not
  // whether they may book.
  const rawPhone = typeof data?.phone === "string" ? data.phone.trim() : "";
  return name && email
    ? { name, email, phone: rawPhone.length > 0 ? rawPhone : null }
    : null;
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
      .from("studios")
      .select("slug, name, timezone")
      .eq("id", studioId)
      .maybeSingle(),
    admin
      .from("services")
      .select("name, default_duration_minutes")
      .eq("id", serviceId)
      .eq("studio_id", studioId)
      .maybeSingle(),
  ]);
  if (!studio?.slug || !studio?.name || !studio?.timezone) return null;
  if (!service?.name) return null;
  return {
    slug: studio.slug as string,
    presentation: {
      studioName: studio.name as string,
      serviceName: service.name as string,
      serviceDurationMinutes: (service.default_duration_minutes as number) ?? 0,
      studioTimezone: studio.timezone as string,
    },
  };
}

/** Resolve plus presentation, or a view state describing why we cannot. */
async function loadContext(rawToken: string): Promise<
  | { ok: true; resolve: Extract<ResolveOutcome, { kind: "live" }>; studio: StudioContext }
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
  const dates: string[] = [];
  let cursor = scope.startDate < today ? today : scope.startDate;
  while (cursor <= scope.endDate) {
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
    if (slotWithinScope(scope, tz, { start: noon.toISOString(), end: noon.toISOString(), startLabel: "" })) {
      dates.push(cursor);
    }
    const next = new Date(`${cursor}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }

  const collected: OfferedSlot[] = [];
  const BATCH = 7;
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = await Promise.all(
      dates.slice(i, i + BATCH).map((date) =>
        fetchPublicSlotsAction({ slug: studio.slug, serviceId: scope.serviceId, date }),
      ),
    );
    for (const res of batch) {
      if (!res.ok) continue;
      for (const s of res.slots) {
        collected.push({
          start: s.start,
          end: s.end,
          startLabel: localTimeString12h(new Date(s.start), tz),
        });
      }
    }
  }
  // Still narrowed by the same evaluator: the day filter above is an
  // optimisation, never the authority, and nothing past endDate is collected.
  return groupSlotsByDay(tz, filterSlotsToScope(scope, tz, collected));
}

async function offerState(
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
  const [slots, identity] = await Promise.all([
    proven
      ? offeredDays(resolve, studio).then((days) => days.flatMap((d) => d.slots))
      : Promise.resolve([]),
    proven
      ? invitedIdentity(resolve.invitation.entryId, resolve.invitation.studioId)
      : Promise.resolve(null),
  ]);
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
    phoneNeeded: identity !== null && identity.phone === null,
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
  return offerState(ctx.resolve, ctx.studio, proven ? { kind: "proven" } : { kind: "required" });
}

/**
 * Send a proof code to the STORED contact. The recipient supplies no address and
 * cannot redirect delivery.
 */
export async function requestInvitationProofAction(
  rawToken: string,
): Promise<InvitationViewState> {
  const gate = await limitPublicSlots({ headers: await headers(), slug: "invitation-proof" });
  if (!gate.allowed) {
    return { kind: "proof", presentation: PLACEHOLDER, windowDescription: RATE_LIMIT_MESSAGE, stage: { kind: "unavailable", retryable: true } };
  }
  const ctx = await loadContext(rawToken);
  if (!ctx.ok) return ctx.state;

  const begun = await beginRecipientProof(rawToken);

  // DELIVERY IS NOT WIRED ON THIS BRANCH. The code is minted and stored, and
  // `begun.rawChallenge` / `begun.proofChallengeId` are the two values the
  // delivery layer needs -- but nothing here transmits them, and this action
  // deliberately does not pretend otherwise. Until the delivery lane lands, the
  // recipient sees the honest "we couldn't send it" state rather than being told
  // to check an inbox nothing was sent to.
  const stage: ProofStage =
    begun.kind === "challenge_issued"
      ? { kind: "unavailable", retryable: true }
      : proofStageFromBegin(begun);

  return offerState(ctx.resolve, ctx.studio, stage);
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
  const ctx = await loadContext(rawToken);
  if (!ctx.ok) return ctx.state;

  const completed = await completeRecipientProof(rawToken, code.trim().toLowerCase());
  if (completed.kind === "verified") {
    await writeCapability(rawToken, completed.rawCapability);
    return offerState(ctx.resolve, ctx.studio, { kind: "proven" });
  }
  return offerState(ctx.resolve, ctx.studio, proofStageFromComplete(completed, previous));
}

/** Decline. Requires the capability; the link alone cannot reach it. */
export async function declineInvitationAction(
  rawToken: string,
): Promise<InvitationViewState> {
  const capability = await readCapability(rawToken);
  if (!capability) {
    const ctx = await loadContext(rawToken);
    if (!ctx.ok) return ctx.state;
    return offerState(ctx.resolve, ctx.studio, { kind: "required" });
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
  // Re-resolve first: if the invitation died underneath them (revoked, expired,
  // already redeemed) that terminal state is the truth and outranks any notice.
  const ctx = await loadContext(rawToken);
  if (!ctx.ok) return ctx.state;

  // The capability did not satisfy the gate, so it is worthless -- drop it
  // rather than leaving a dead credential to fail again on the next tap.
  const notice: ProofNotice =
    out.kind === "unavailable" ? "decline_unavailable" : "proof_lapsed";
  if (notice === "proof_lapsed") await clearCapability();

  return deriveInvitationViewState({
    resolve: ctx.resolve,
    presentation: ctx.studio.presentation,
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
    return offerState(ctx.resolve, ctx.studio, { kind: "required" });
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
  const invited = await invitedIdentity(
    ctx.resolve.invitation.entryId,
    ctx.resolve.invitation.studioId,
  );
  if (!invited) return { kind: "error", retryable: true };
  fd.set("email", invited.email);
  fd.set("name", invited.name);

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
  const phone = invited.phone ?? (typeof typedPhone === "string" ? typedPhone.trim() : "");
  if (!phone) {
    // Fail BEFORE the booking action, so the recipient is asked for the number
    // on the offer they are already looking at rather than being handed the
    // public form's error for a field this surface never showed them.
    return offerState(ctx.resolve, ctx.studio, { kind: "proven" });
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
    if (inScope) {
      await clearCapability();
      return deriveInvitationViewState({
        resolve: ctx.resolve,
        presentation: ctx.studio.presentation,
        proof: { kind: "required" },
        slots: [],
        booked: null,
        declined: false,
        proofNotice: "proof_lapsed",
      });
    }
  }

  // Every other refusal leaves the offer usable, so it is shown WITH the reason.
  return offerState(ctx.resolve, ctx.studio, { kind: "proven" }, bookingRefusalFor(booked));
}

/**
 * Map the booking command's refusal onto the closed set the screen renders.
 *
 * `invitation_consumed` is deliberately absent: it is handled above as a
 * terminal state, and returning it here would put "your invitation has been
 * used" above live, selectable times.
 */
function bookingRefusalFor(result: { ok: false; code?: string }): BookingRefusal {
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
