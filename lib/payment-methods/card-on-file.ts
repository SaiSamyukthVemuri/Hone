import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import {
  getCardAuthorizationCapability,
  type CardAuthorizationCapability,
} from "@/lib/consent/queries";

// Chloe production feedback: "tell me on the dashboard next to my upcoming
// clients names if they have a card on file or not, so i can remind them if
// they haven't done it".
//
// WHY THIS EXISTS AND getActiveCardForStudioClient() DOES NOT ANSWER IT.
//
//   1. TRUTH. That helper returns `null` for BOTH "this client has no active
//      card" and "the lookup failed". Those are opposite claims about a person.
//      Rendering a failed read as "No card" tells the practitioner a client did
//      not do something they may well have done, and then offers to chase them
//      for it. A READ FAILURE IS NOT A CLIENT FAILURE, so this loader keeps the
//      third state and never manufactures the absence.
//   2. COST. It answers for ONE client. Calling it per row is an N+1 that grows
//      with the day's schedule. This is ONE bounded read for today's unique
//      client ids, however many appointments they hold.
//
// MODE SCOPING is not optional. `stripe_livemode` is part of the question: a
// TEST card while the deployment runs LIVE cannot be charged, so presenting it
// as "Card on file" would be a lie with money attached. Same rule the active-
// card, eligibility and charge paths already apply (migration 0104 makes the
// one-active-card invariant itself per-mode).
//
// PRIVACY. The SELECT is `client_id` and nothing else. No stripe_customer_id,
// no stripe_payment_method_id, no stripe_setup_intent_id, no stripe_account_id,
// no brand/last4 — the Dashboard question is a yes/no, so nothing more is
// loaded and nothing more can reach rendered HTML.
//
// TENANCY. `studioId` is resolved SERVER-SIDE from
// getCurrentPractitionerWithStudio() and the client id set is the server-loaded
// roster for today; neither ever comes from the browser. The read is scoped by
// both, exactly as getActiveCardForStudioClient() is.
//
// WHY THE ADMIN CLIENT AND NOT THE RLS ONE. Every existing reader of
// client_payment_methods (eligibility, charge, receipt, card-authorization,
// change-notification) uses the service-role client, so that is the proven
// access path for this table; nothing reads it as `authenticated` today. A
// Data-API grant that has never been exercised is exactly the failure this
// repo has been bitten by before (a reset that strips grants reads as an
// application bug), and here it would degrade every client to
// "Card status unavailable" — safe, but useless. Capability stays on the
// server: nothing service-role-shaped moves into the browser, and the only
// thing that crosses the boundary is a per-client yes/no/unknown.

export type CardOnFileStatus = "card_on_file" | "no_card" | "unavailable";

/**
 * Deliberately a discriminated result, not a bare Set. A bare Set makes a
 * failed query indistinguishable from an authoritative "nobody today has a
 * card" — which is exactly the collapse this loader exists to prevent.
 */
export type CardOnFileLoad =
  | { ok: true; clientsWithActiveCard: Set<string> }
  | { ok: false };

export async function getCardOnFileStatuses(
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<CardOnFileLoad> {
  // De-duplicated up front: one client with two appointments today is ONE id in
  // the batch and ONE answer serving both rows.
  const uniqueClientIds = [...new Set(clientIds)];
  if (uniqueClientIds.length === 0) {
    return { ok: true, clientsWithActiveCard: new Set<string>() };
  }

  // `createAdminClient()` THROWS synchronously when its env is absent, so it
  // is inside the try with the await: the module promises that a failed read
  // degrades to "unavailable", and a construction failure is a failed read.
  // Without this, one missing env turns a per-row pill into a dead dashboard.
  let data: Array<{ client_id: string }> | null = null;
  let error: { code?: string; message?: string } | null = null;
  try {
    const admin = createAdminClient();
    const res = await admin
      .from("client_payment_methods")
      .select("client_id")
      .eq("studio_id", studioId)
      .in("client_id", uniqueClientIds)
      .eq("stripe_livemode", inferStripeLivemode())
      .eq("status", "active");
    data = res.data as Array<{ client_id: string }> | null;
    error = res.error;
  } catch (thrown) {
    error = {
      code: "card_on_file_client_unavailable",
      message: thrown instanceof Error ? thrown.message : "unknown",
    };
  }

  if (error) {
    console.error(
      JSON.stringify({
        event: "card_on_file_batch_lookup_failed",
        code: error.code,
        message: error.message,
        client_count: uniqueClientIds.length,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false };
  }

  const clientsWithActiveCard = new Set<string>();
  for (const row of data ?? []) {
    clientsWithActiveCard.add(row.client_id);
  }
  return { ok: true, clientsWithActiveCard };
}

// ===========================================================================
// CAPABILITY — asked BEFORE the card question, never derived alongside it
// ===========================================================================
//
// "This client has no stored card" is only a meaningful thing to tell a
// practitioner if her studio can actually collect one. Where it cannot, every
// client is card-less by construction, so the Dashboard would render a solid
// column of amber NO CARD against a whole day and offer to chase each of them
// toward a portal that has nowhere to send them. That is not a truthful
// absence; it is an artefact of asking the wrong question first.
//
// THE AUTHORITY IS THE PORTAL'S OWN GATE, NOT A NEW DIALECT. What decides
// whether a client has ANY route toward a card is whether the studio has an
// ACTIVE, LIVE `card_authorization` consent template — the exact condition
// `app/portal/page.tsx` uses. With one, the portal offers a route in every
// state: sign it, re-sign an updated version, or add the card outright. With
// none, the portal shows only its passive "no payment template" note and the
// client cannot add a card at all — so a nudge is a dead end.
//
// It is deliberately NOT `studio_payment_settings.require_card_on_file`. That
// column gates CARD-REQUIRED BOOKING (migration 0032's session RPC refuses
// when it is not true), which is a booking policy, not a statement about
// whether the portal can collect a card. No application surface writes it, and
// the two questions are not the same one.
export async function studioOffersCardOnFile(
  studioId: string,
): Promise<CardAuthorizationCapability> {
  return getCardAuthorizationCapability(studioId);
}

/**
 * The Dashboard's single entry point.
 *
 * Returns `null` for "do not ask, and render nothing" — an empty day, or a
 * studio with no card-on-file route. `null` is NOT a fourth pill: it is the
 * absence of the question, and it costs ZERO card-status queries.
 */
export async function loadCardOnFileForStudio(
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<CardOnFileLoad | null> {
  if (clientIds.length === 0) return null;

  const capability = await studioOffersCardOnFile(studioId);

  // UNKNOWN IS NOT OFF. A capability read we could not complete says nothing
  // about this studio, so it must not be spoken as "no card route" — that
  // would hide the whole card UX from a studio that has one. It resolves to
  // the honest third state, "Card status unavailable", and buys no further
  // query: we do not know whether the question even applies.
  if (!capability.ok) return { ok: false };

  // ABSENT is authoritative: the read succeeded and there is no route, so the
  // question genuinely does not apply and no card query is issued.
  if (!capability.enabled) return null;

  return getCardOnFileStatuses(studioId, clientIds);
}

/**
 * Pure. The ONLY place a load becomes a per-client claim.
 *
 * `null` in means the studio has no card-on-file route, so there is no claim
 * to make and the caller renders nothing.
 */
export function resolveCardOnFileStatus(
  load: CardOnFileLoad | null,
  clientId: string,
): CardOnFileStatus | null {
  if (load === null) return null;
  if (!load.ok) return "unavailable";
  return load.clientsWithActiveCard.has(clientId) ? "card_on_file" : "no_card";
}

/**
 * Pure. Whether to offer the one-click portal-link send beside this row.
 *
 * ONLY `no_card`. Not `card_on_file` (the client already did it — chasing them
 * would be wrong), and NOT `unavailable`: we do not actually know the card is
 * missing, so nudging the client would be acting on an absence we invented.
 */
export function shouldOfferPortalLink(status: CardOnFileStatus | null): boolean {
  return status === "no_card";
}
