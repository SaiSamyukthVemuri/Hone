// ===========================================================================
// HON-47 — STUDIO CONTROLS FOR CLIENT SELF-SERVICE
// ===========================================================================
//
// THREE INDEPENDENT STUDIO FLAGS, every one defaulting TRUE (today's behaviour):
//
//   client_cancellation_enabled  (0234)   /cancel/[token] and its CTA
//   client_reschedule_enabled    (0234)   /reschedule/[token] and its CTA
//   client_portal_enabled        (HON-47 draft migration, number pending)
//                                          /portal, its login, magic-link
//                                          verify and every portal action;
//                                          portal rebook; returning-client
//                                          online booking on /book; the portal
//                                          and "book another" CTAs
//
// NOT DERIVED FROM new_client_admission_mode. That field is NEW-client
// admission (0204) and stays exactly as it is; these flags never read it, and
// it never reads them. Turning a flag off is an owner decision recorded on the
// studio row, not something inferred.
//
// ABSENT MEANS TRUE, AND ONLY ABSENT. A studio row loaded with `select *`
// before the migrations apply carries no such key, and every studio then
// behaves exactly as it does today. An explicit `false` is the only value that
// withdraws anything. Any other non-boolean (a string, a number) is treated as
// FALSE: a value this code does not understand must not grant access.
//
// PURE AND ISOMORPHIC: email templates, server actions, pages and tests import
// it. The server-only loader lives in client-self-service-policy-store.ts.

export type ClientSelfServicePolicy = {
  /** Client may cancel online with their appointment token. */
  cancellation: boolean;
  /** Client may reschedule online with their appointment token. */
  reschedule: boolean;
  /** Client may use the portal and book online as a returning client. */
  portal: boolean;
};

export const DEFAULT_CLIENT_SELF_SERVICE_POLICY: ClientSelfServicePolicy =
  Object.freeze({ cancellation: true, reschedule: true, portal: true });

export type ClientSelfServicePolicyColumns = {
  client_cancellation_enabled?: unknown;
  client_reschedule_enabled?: unknown;
  client_portal_enabled?: unknown;
};

function flag(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return value === true;
}

export function clientSelfServicePolicyFromStudio(
  studio: ClientSelfServicePolicyColumns | null | undefined,
): ClientSelfServicePolicy {
  if (!studio) return DEFAULT_CLIENT_SELF_SERVICE_POLICY;
  return {
    cancellation: flag(studio.client_cancellation_enabled),
    reschedule: flag(studio.client_reschedule_enabled),
    portal: flag(studio.client_portal_enabled),
  };
}

/**
 * /manage exists to reach cancel, reschedule or the portal. With all three
 * off it has nothing to offer, so it refuses instead of showing a dead page.
 */
export function clientManagePageAllowed(policy: ClientSelfServicePolicy): boolean {
  return policy.cancellation || policy.reschedule || policy.portal;
}

/** Stable machine codes for the refusals a page renders specially. */
export const CLIENT_RESCHEDULE_DISABLED_CODE = "reschedule_disabled" as const;
export type ClientRescheduleDisabledCode = typeof CLIENT_RESCHEDULE_DISABLED_CODE;
export const CLIENT_CANCELLATION_DISABLED_CODE = "cancellation_disabled" as const;
export type ClientCancellationDisabledCode = typeof CLIENT_CANCELLATION_DISABLED_CODE;

// ---------------------------------------------------------------------------
// Client-facing copy. One source, so every surface says the same thing and a
// refusal always tells the client what still holds and what to do next.
// ---------------------------------------------------------------------------

function contact(studioName: string | null | undefined): string {
  const name = studioName?.trim();
  return name ? name : "the studio";
}

export function clientCancellationDisabledMessage(
  studioName?: string | null,
): string {
  return `Online cancellation isn't available. Your appointment is still booked. Please contact ${contact(studioName)} directly to cancel.`;
}

export function clientRescheduleDisabledMessage(
  studioName?: string | null,
): string {
  return `Online rescheduling isn't available. Your appointment is still booked at its current time. Please contact ${contact(studioName)} directly to change it.`;
}

export function clientManageDisabledMessage(studioName?: string | null): string {
  return `Appointments are managed directly by ${contact(studioName)}. Your appointment is unchanged. Please contact the studio for any changes.`;
}

export function clientPortalDisabledMessage(studioName?: string | null): string {
  return `Online client access isn't available for ${contact(studioName)}. Please contact the studio directly about your appointments, forms or care instructions.`;
}

/**
 * Returning-client online booking refusal. Deliberately does NOT say
 * "returning client": the same copy is used when a visitor who chose "new"
 * matches an existing client, and naming the reason there would confirm that
 * the email belongs to a client of this studio.
 */
export function clientOnlineBookingDisabledMessage(
  studioName?: string | null,
): string {
  return `This booking can't be completed online. Please contact ${contact(studioName)} directly to book.`;
}

/** Staff-facing: why a portal link or portal message cannot be sent. */
export const STAFF_PORTAL_DISABLED_MESSAGE =
  "Client portal access is turned off for this studio, so no portal link can be sent.";

/** Staff-facing: why a portal message cannot be sent. */
export const STAFF_PORTAL_MESSAGE_DISABLED_MESSAGE =
  "Client portal access is turned off for this studio, so clients cannot read portal messages. Please contact the client directly.";
