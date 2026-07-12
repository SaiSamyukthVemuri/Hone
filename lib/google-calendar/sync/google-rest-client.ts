import "server-only";
import { GOOGLE_TOKEN_ENDPOINT, getGoogleOAuthClient } from "../config";
import {
  classifyGoogleResponse,
  classifyRefreshResponse,
  classifyThrown,
  type GoogleError,
} from "./errors";

// Google Calendar — Phase B2.1: server-side, fetch-only REST client for the
// worker. Direct REST (no `googleapis`), consistent with Phase A. Every method
// returns a typed result: success payload, or a normalized GoogleError. NO
// token, event body, or PII is ever logged. Bounded per-request timeout via
// AbortController; bounded response-body parsing.
//
// The event helpers (get/insert/patch/delete) are IMPLEMENTED and unit-tested
// against mocked HTTP only. In B2.1 they are wired to NOTHING — no appointment
// path, no production outbox, no live Google call.

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024; // defensive cap on parsed body size
const EVENTS_BASE = "https://www.googleapis.com/calendar/v3/calendars";

type FetchImpl = typeof fetch;

export type GoogleRestClientOptions = {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  now?: () => number;
};

// A Google Calendar event payload is produced by the (B2.4) privacy serializer;
// here it is an opaque JSON object the client transmits verbatim.
export type GoogleEventPayload = Record<string, unknown>;
export type GoogleEventResource = Record<string, unknown> & {
  id?: string;
  status?: string;
  etag?: string;
};

export type RefreshTokenSuccess = {
  ok: true;
  accessToken: string;
  expiresInSeconds: number;
  rotatedRefreshToken: string | null;
};
export type EventSuccess = { ok: true; status: number; event: GoogleEventResource; etag: string | null };
export type DeleteSuccess = { ok: true; status: number };
export type GoogleFailure = { ok: false; error: GoogleError };

export type GoogleRestClient = {
  refreshToken(refreshToken: string): Promise<RefreshTokenSuccess | GoogleFailure>;
  getEvent(args: { accessToken: string; calendarId: string; eventId: string }): Promise<EventSuccess | GoogleFailure>;
  insertEvent(args: {
    accessToken: string;
    calendarId: string;
    event: GoogleEventPayload;
  }): Promise<EventSuccess | GoogleFailure>;
  patchEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
    event: GoogleEventPayload;
    etag?: string | null;
  }): Promise<EventSuccess | GoogleFailure>;
  deleteEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
    etag?: string | null;
  }): Promise<DeleteSuccess | GoogleFailure>;
};

type RawResponse = {
  status: number;
  retryAfterHeader: string | null;
  parsedBody: unknown;
  bodyParseFailed: boolean;
};

export function createGoogleRestClient(opts: GoogleRestClientOptions = {}): GoogleRestClient {
  const doFetch: FetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  // Perform one request with a bounded timeout + bounded body parse. Returns a
  // RawResponse on any HTTP reply (2xx or not); THROWS only for transport
  // failures (network/abort), which the caller classifies via classifyThrown.
  async function request(url: string, init: RequestInit): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      const retryAfterHeader = res.headers.get("retry-after");
      let text = "";
      let bodyParseFailed = false;
      let parsedBody: unknown = null;
      try {
        text = await res.text();
        if (text.length > MAX_BODY_BYTES) {
          bodyParseFailed = true;
        } else if (text.length > 0) {
          parsedBody = JSON.parse(text);
        }
      } catch {
        bodyParseFailed = true;
      }
      return { status: res.status, retryAfterHeader, parsedBody, bodyParseFailed };
    } finally {
      clearTimeout(timer);
    }
  }

  function eventsUrl(calendarId: string, eventId?: string): string {
    const base = `${EVENTS_BASE}/${encodeURIComponent(calendarId)}/events`;
    return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
  }

  function extractEvent(raw: RawResponse): GoogleEventResource {
    return raw.parsedBody && typeof raw.parsedBody === "object"
      ? (raw.parsedBody as GoogleEventResource)
      : {};
  }

  return {
    async refreshToken(refreshToken: string): Promise<RefreshTokenSuccess | GoogleFailure> {
      const client = getGoogleOAuthClient();
      if (!client) {
        return { ok: false, error: { kind: "config_error", status: null, code: "oauth_client_unavailable", retryAfterSeconds: null } };
      }
      let raw: RawResponse;
      try {
        raw = await request(GOOGLE_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: client.clientId,
            client_secret: client.clientSecret,
          }),
        });
      } catch (err) {
        return { ok: false, error: classifyThrown(err) };
      }
      const error = classifyRefreshResponse({ ...raw, now: now() });
      if (error.kind !== "success") return { ok: false, error };
      const body = (raw.parsedBody ?? {}) as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
      };
      if (!body.access_token) {
        return { ok: false, error: { kind: "transient", status: raw.status, code: "no_access_token", retryAfterSeconds: null } };
      }
      return {
        ok: true,
        accessToken: body.access_token,
        expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 3600,
        rotatedRefreshToken: body.refresh_token ?? null,
      };
    },

    async getEvent({ accessToken, calendarId, eventId }): Promise<EventSuccess | GoogleFailure> {
      return sendEvent("GET", eventsUrl(calendarId, eventId), accessToken, undefined, undefined);
    },
    async insertEvent({ accessToken, calendarId, event }): Promise<EventSuccess | GoogleFailure> {
      return sendEvent("POST", eventsUrl(calendarId), accessToken, event, undefined);
    },
    async patchEvent({ accessToken, calendarId, eventId, event, etag }): Promise<EventSuccess | GoogleFailure> {
      return sendEvent("PATCH", eventsUrl(calendarId, eventId), accessToken, event, etag ?? undefined);
    },
    async deleteEvent({ accessToken, calendarId, eventId, etag }): Promise<DeleteSuccess | GoogleFailure> {
      let raw: RawResponse;
      try {
        raw = await request(eventsUrl(calendarId, eventId), {
          method: "DELETE",
          headers: authHeaders(accessToken, etag ?? undefined),
        });
      } catch (err) {
        return { ok: false, error: classifyThrown(err) };
      }
      // Google returns 204 on delete, 404/410 when already gone (B2.4 treats 404
      // as success; here we surface the classification and let the handler decide).
      const error = classifyGoogleResponse({ ...raw, now: now() });
      if (error.kind === "success") return { ok: true, status: raw.status };
      return { ok: false, error };
    },
  };

  async function sendEvent(
    method: string,
    url: string,
    accessToken: string,
    event: GoogleEventPayload | undefined,
    etag: string | undefined,
  ): Promise<EventSuccess | GoogleFailure> {
    let raw: RawResponse;
    try {
      raw = await request(url, {
        method,
        headers: {
          ...authHeaders(accessToken, etag),
          ...(event ? { "Content-Type": "application/json" } : {}),
        },
        body: event ? JSON.stringify(event) : undefined,
      });
    } catch (err) {
      return { ok: false, error: classifyThrown(err) };
    }
    const error = classifyGoogleResponse({ ...raw, now: now() });
    if (error.kind !== "success") return { ok: false, error };
    const resource = extractEvent(raw);
    return { ok: true, status: raw.status, event: resource, etag: typeof resource.etag === "string" ? resource.etag : null };
  }
}

function authHeaders(accessToken: string, etag?: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (etag) h["If-Match"] = etag;
  return h;
}
