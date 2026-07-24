import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensurePractitionerNotification } from "@/lib/notifications/practitioner-notifications";

// Card-on-file change notification (Chloe's ask): when a client adds or
// replaces a card through the portal, the studio should see a practitioner-
// facing notification in the existing in-app notification center.
//
// This is invoked from the setup_intent.succeeded webhook arm AFTER the
// card row is persisted — from every success branch (fresh insert, the
// idempotency early-return where the card was already saved, and the 23505
// backstop). It is awaited; a failure throws so the webhook releases its
// Stripe event claim and Stripe retries. The dedupe key (the Stripe event id)
// makes a retry a no-op once the notification exists.
//
// Added vs replaced is decided from PERSISTED same-mode payment-method
// history, never from the browser's "add" or "replace" portal mode:
//   * card_added   -> exactly one payment-method row exists for the
//                     (studio, client, Stripe mode) — the one just saved.
//   * card_replaced -> a prior row exists for that pair+mode (the previous
//                     active card was retired to status='removed' by the
//                     webhook pre-flip, so the row count is >= 2).
//
// Only card_added / card_replaced ship. card_removed and default_card_changed
// are NOT emitted here because the portal has no card-removal or default-card
// workflow — those product actions do not exist yet (documented as future
// events on the PractitionerNotificationEventType union).
//
// Privacy: the body carries only the client name (already visible to every
// studio member) + card brand + last4. No expiry, full card number, Stripe
// PaymentMethod / customer / SetupIntent / event id, authorization signature
// id, email, or phone.

// Pure content builder. Kept separate + exported so the exact studio-facing
// wording, event type, and href — and the privacy guarantee (only client name
// + brand + last4, nothing else) — are unit-testable without a database.
export function buildCardChangeNotification(input: {
  clientName: string;
  brand: string;
  last4: string;
  isReplacement: boolean;
  clientId: string;
}): {
  eventType: "card_added" | "card_replaced";
  title: string;
  body: string;
  href: string;
} {
  const { clientName, brand, last4, isReplacement, clientId } = input;
  const eventType = isReplacement ? "card_replaced" : "card_added";
  const title = isReplacement ? "Card replaced on file" : "Card added on file";
  const body = isReplacement
    ? `${clientName} replaced the card on file with ${brand} ending in ${last4}.`
    : `${clientName} added ${brand} ending in ${last4}.`;
  // Studio-facing deep link to the client's overview tab.
  const href = `/clients/${clientId}?tab=overview`;
  return { eventType, title, body, href };
}

export type EnsureCardChangeNotificationParams = {
  studioId: string;
  clientId: string;
  // The Stripe mode of the saved card (event.livemode). Determination and the
  // card lookup are both scoped to this mode so a live save never reads the
  // client's test card, and vice versa.
  livemode: boolean;
  // The SetupIntent whose success this notification represents. Used to read
  // the exact card row this event saved (authoritative brand/last4).
  setupIntentId: string;
  // Authoritative Stripe event id, used to build the dedupe key. Never rendered.
  stripeEventId: string;
};

export async function ensureCardChangeNotification(
  admin: SupabaseClient,
  params: EnsureCardChangeNotificationParams,
): Promise<{ eventType: "card_added" | "card_replaced"; deduped: boolean }> {
  const { studioId, clientId, livemode, setupIntentId, stripeEventId } = params;

  // 1. The card row THIS SetupIntent saved — authoritative brand/last4.
  //    Keyed by setup_intent_id so the content describes the exact card this
  //    event represents (stable across the fresh + retry paths).
  const { data: card, error: cardErr } = await admin
    .from("client_payment_methods")
    .select("brand, last4")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("stripe_livemode", livemode)
    .eq("stripe_setup_intent_id", setupIntentId)
    .maybeSingle();
  if (cardErr) {
    throw new Error(
      `card_change_card_lookup_failed:${cardErr.code}:${cardErr.message}`,
    );
  }
  if (!card) {
    // The webhook only calls this after the card is persisted for this
    // SetupIntent; a miss means a lost race. Throw so the event is retried.
    throw new Error("card_change_card_row_missing");
  }

  // 2. Added vs replaced, from persisted same-mode history (row count).
  const { count, error: countErr } = await admin
    .from("client_payment_methods")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("stripe_livemode", livemode);
  if (countErr) {
    throw new Error(
      `card_change_history_count_failed:${countErr.code}:${countErr.message}`,
    );
  }
  const isReplacement = (count ?? 0) > 1;

  // 3. Client display name (already shown to every studio member). Fall back
  //    to a generic label if the row is somehow gone.
  const { data: client, error: clientErr } = await admin
    .from("clients")
    .select("name")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (clientErr) {
    throw new Error(
      `card_change_client_lookup_failed:${clientErr.code}:${clientErr.message}`,
    );
  }
  const clientName =
    typeof client?.name === "string" && client.name.trim().length > 0
      ? client.name.trim()
      : "A client";

  const { eventType, title, body, href } = buildCardChangeNotification({
    clientName,
    brand: card.brand as string,
    last4: card.last4 as string,
    isReplacement,
    clientId,
  });

  // 4. Secure the notification durably (awaited). A redelivery of this Stripe
  //    event conflicts on the dedupe key and returns deduped:true.
  const { deduped } = await ensurePractitionerNotification({
    studioId,
    practitionerId: null, // studio-wide visibility
    eventType,
    title,
    body,
    appointmentId: null,
    clientId,
    href,
    dedupeKey: `stripe:${stripeEventId}`,
  });

  return { eventType, deduped };
}
