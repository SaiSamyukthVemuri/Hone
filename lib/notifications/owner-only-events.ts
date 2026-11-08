// WS-D (settings redesign): notification event types only the studio OWNER may receive or read.
//
// Card-on-file changes name a client and carry a card brand and last four. They are owner-only at DELIVERY (the producer targets the owner's
// practitioner row, never studio-wide) and at RETRIEVAL (every reader excludes them for any other role). RLS on practitioner_notifications
// (0070) still lets every member SELECT every row of the studio, so a direct API read is not closed by this file; that needs a policy
// migration, which is HELD. This module is the application half of the rule and the single list both halves use.
export const OWNER_ONLY_NOTIFICATION_EVENT_TYPES = ["card_added", "card_replaced"] as const;

const EXCLUDE = `(${OWNER_ONLY_NOTIFICATION_EVENT_TYPES.join(",")})`;

/** Narrow a practitioner_notifications query to what the viewer may see. The owner's query is returned unchanged. */
export function scopeNotificationsToViewer<Q extends { not: (column: string, operator: string, value: unknown) => Q }>(
  query: Q,
  viewerIsOwner: boolean,
): Q {
  return viewerIsOwner ? query : query.not("event_type", "in", EXCLUDE);
}
