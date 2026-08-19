import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";

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

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_payment_methods")
    .select("client_id")
    .eq("studio_id", studioId)
    .in("client_id", uniqueClientIds)
    .eq("stripe_livemode", inferStripeLivemode())
    .eq("status", "active");

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
  for (const row of (data ?? []) as Array<{ client_id: string }>) {
    clientsWithActiveCard.add(row.client_id);
  }
  return { ok: true, clientsWithActiveCard };
}

/** Pure. The ONLY place a load becomes a per-client claim. */
export function resolveCardOnFileStatus(
  load: CardOnFileLoad,
  clientId: string,
): CardOnFileStatus {
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
export function shouldOfferPortalLink(status: CardOnFileStatus): boolean {
  return status === "no_card";
}
