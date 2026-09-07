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
  filterSlotsToScope,
  groupSlotsByDay,
  proofStageFromBegin,
  proofStageFromComplete,
  type InvitationViewState,
  type OfferedSlot,
  type OfferPresentation,
  type ProofStage,
} from "@/lib/waitlist/invitation-offer";
import { fetchPublicSlotsAction } from "@/app/book/[slug]/actions";
import { localDateString, localTimeString12h } from "@/lib/booking/tz";
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

async function readCapability(): Promise<string | null> {
  const jar = await cookies();
  const v = jar.get(CAPABILITY_COOKIE)?.value;
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : null;
}

async function writeCapability(capability: string): Promise<void> {
  const jar = await cookies();
  jar.set(CAPABILITY_COOKIE, capability, {
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
): Promise<{ name: string; email: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("new_client_waitlist_entries")
    .select("name, email")
    .eq("id", entryId)
    .eq("studio_id", studioId)
    .maybeSingle();
  const name = typeof data?.name === "string" ? data.name : null;
  const email = typeof data?.email === "string" ? data.email : null;
  return name && email ? { name, email } : null;
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

  // Walk the offer's own window, capped so a long offer cannot fan out into an
  // unbounded number of slot queries.
  const MAX_DAYS = 21;
  const dates: string[] = [];
  const today = localDateString(new Date(), tz);
  let cursor = scope.startDate < today ? today : scope.startDate;
  while (cursor <= scope.endDate && dates.length < MAX_DAYS) {
    dates.push(cursor);
    const next = new Date(`${cursor}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }

  const collected: OfferedSlot[] = [];
  for (const date of dates) {
    const res = await fetchPublicSlotsAction({
      slug: studio.slug,
      serviceId: scope.serviceId,
      date,
    });
    if (!res.ok) continue;
    for (const s of res.slots) {
      collected.push({
        start: s.start,
        end: s.end,
        startLabel: localTimeString12h(new Date(s.start), tz),
      });
    }
  }
  return groupSlotsByDay(tz, filterSlotsToScope(scope, tz, collected));
}

async function offerState(
  resolve: Extract<ResolveOutcome, { kind: "live" }>,
  studio: StudioContext,
  proof: ProofStage,
  bookingRefusal?: BookingRefusal,
): Promise<InvitationViewState> {
  const slots =
    proof.kind === "proven"
      ? (await offeredDays(resolve, studio)).flatMap((d) => d.slots)
      : [];
  return deriveInvitationViewState({
    resolve,
    presentation: studio.presentation,
    proof,
    slots,
    booked: null,
    declined: false,
    bookingRefusal,
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
  const proven = (await readCapability()) !== null;
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
    await writeCapability(completed.rawCapability);
    return offerState(ctx.resolve, ctx.studio, { kind: "proven" });
  }
  return offerState(ctx.resolve, ctx.studio, proofStageFromComplete(completed, previous));
}

/** Decline. Requires the capability; the link alone cannot reach it. */
export async function declineInvitationAction(
  rawToken: string,
): Promise<InvitationViewState> {
  const capability = await readCapability();
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
  const ctx = await loadContext(rawToken);
  if (!ctx.ok) return ctx.state;
  return offerState(ctx.resolve, ctx.studio, { kind: "required" });
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
): Promise<InvitationViewState> {
  const capability = await readCapability();
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
      reason: "already_redeemed",
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
  // Every other refusal leaves the offer usable, so it is shown WITH the reason.
  // Previously this returned the offer unchanged and the recipient's tap simply
  // appeared to do nothing.
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
