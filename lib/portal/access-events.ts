// Practitioner-visible portal access/send event log (Portal Access PR 3).
// Rows live in client_portal_access_events (migration 0111): studio-scoped,
// append-only, service-role insert only. This helper is the ONLY writer.
//
// PRIVACY: it can only ever persist ids + an event_type + an optional channel +
// an ALLOWLISTED metadata bag (short numbers/codes). It never accepts (and the
// table has no column for) a raw token, a magic-link URL, an IP/user-agent, an
// email, or any clinical/intake/payment detail. It is fail-soft: a logging
// failure (including the table not existing pre-migration) never throws and
// never blocks the user path.

type PortalAdmin = { from: (table: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export const PORTAL_ACCESS_EVENT_TYPES = [
  "portal_link_sent",
  "portal_link_rate_limited",
  "portal_login_requested",
  "portal_magic_link_consumed",
  "portal_session_seen",
] as const;
export type PortalAccessEventType = (typeof PORTAL_ACCESS_EVENT_TYPES)[number];

export const PORTAL_ACCESS_CHANNELS = [
  "email",
  "copy_url",
  "portal_message",
  "appointment_email",
] as const;
export type PortalAccessChannel = (typeof PORTAL_ACCESS_CHANNELS)[number];

// The ONLY metadata keys ever persisted. Anything else is dropped, so a caller
// can never accidentally leak a token/email/clinical value into metadata.
const METADATA_ALLOWLIST = new Set(["retry_after_seconds", "reason"]);

function sanitizeMetadata(input: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input) return out;
  for (const [k, v] of Object.entries(input)) {
    if (!METADATA_ALLOWLIST.has(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 64); // short codes only
  }
  return out;
}

export async function logPortalAccessEvent(
  admin: PortalAdmin,
  input: {
    studioId: string;
    clientId: string;
    practitionerId?: string | null;
    eventType: PortalAccessEventType;
    channel?: PortalAccessChannel | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await admin.from("client_portal_access_events").insert({
      studio_id: input.studioId,
      client_id: input.clientId,
      practitioner_id: input.practitionerId ?? null,
      event_type: input.eventType,
      channel: input.channel ?? null,
      metadata: sanitizeMetadata(input.metadata),
    });
    if (error) {
      // Fail-soft: safe marker only (event_type is not sensitive). Includes the
      // pre-migration "table does not exist" case.
      console.error(
        JSON.stringify({
          event: "portal_access_event_log_failed",
          eventType: input.eventType,
          code: error.code,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  } catch {
    console.error(
      JSON.stringify({
        event: "portal_access_event_log_threw",
        eventType: input.eventType,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
