// WS-D (settings redesign): notification event types only the studio OWNER may receive or read.
//
// Card-on-file changes name a client and carry a card brand and last four. They are owner-only at DELIVERY (the producer targets the owner's
// practitioner row, never studio-wide) and at RETRIEVAL (every reader excludes them for any other role). RLS on practitioner_notifications
// (0070) still lets every member SELECT every row of the studio, so a direct API read is not closed by this file; that needs a policy
// migration, which is HELD. This module is the application half of the rule and the single list both halves use.
// waitlist_offer_declined (HON-7) names a person who declined offered times; it is written by the decline command, owner-only like the card events.
export const OWNER_ONLY_NOTIFICATION_EVENT_TYPES = ["card_added", "card_replaced", "waitlist_offer_declined"] as const;

const EXCLUDE = `(${OWNER_ONLY_NOTIFICATION_EVENT_TYPES.join(",")})`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rows written by the HON-7 cancellation writer carry this dedupe_key prefix, and ONLY they have recipient semantics (practitioner_id = the
// recipient). A cancellation row written before it has a null or other-format key and practitioner_id = the APPOINTMENT's practitioner with
// studio-wide visibility, so it stays visible to every member exactly as before; no backfill is needed.
export const CANCEL_RECIPIENT_KEY_PREFIX = "appointment_cancelled:";

/**
 * Narrow a practitioner_notifications query to what the viewer may see.
 *
 * Two rules, both application-side (RLS still lets any studio member read every row of the studio at the API level; closing that is a HELD policy migration):
 *   1. owner-only event types are excluded for any other role. The owner's query is not narrowed by this rule.
 *   2. a cancellation row that carries the recipient key prefix is PER RECIPIENT: it shows only when its practitioner_id is the viewer. That is how
 *      "the person who cancelled is never notified of their own cancellation" holds when a studio has several owners. Such a row with NO recipient
 *      (the fallback written only when a studio has no readable owner) names a client, so only an owner sees it. Every other row, legacy cancellation
 *      rows and new_booking above all, is untouched by this rule.
 */
export function scopeNotificationsToViewer<
  Q extends { not: (column: string, operator: string, value: unknown) => Q; or: (filters: string) => Q },
>(query: Q, viewerIsOwner: boolean, viewerPractitionerId: string): Q {
  // The id is server-resolved, but it is interpolated into a filter string, so refuse anything that is not a uuid.
  if (!UUID.test(viewerPractitionerId)) throw new Error("scopeNotificationsToViewer: viewer id is not a uuid");
  const visible = [
    "event_type.neq.appointment_cancelled",
    "dedupe_key.is.null",
    `dedupe_key.not.like.${CANCEL_RECIPIENT_KEY_PREFIX}*`,
    `practitioner_id.eq.${viewerPractitionerId}`,
    ...(viewerIsOwner ? ["practitioner_id.is.null"] : []),
  ];
  const perRecipient = query.or(visible.join(","));
  return viewerIsOwner ? perRecipient : perRecipient.not("event_type", "in", EXCLUDE);
}
