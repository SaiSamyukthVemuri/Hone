import "server-only";
import {
  GOOGLE_CALENDAR_LIST_ENDPOINT,
  GOOGLE_CALENDARS_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_TOKENINFO_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
} from "../config";
import { assertE2eFakeGoogleAllowed } from "./fake-google-guard";
import {
  appendFakeGoogleEvent,
  createdCalendars,
  readFakeGoogleScenario,
} from "./fake-google-ledger";

// The fake Google responder. `googleFetch` (lib/google-calendar/google-transport.ts)
// routes here ONLY when the fail-closed guard passes (never in production). It
// returns SYNTHETIC responses for the exact Google endpoints the OAuth/calendar
// path calls — no real Google network request is ever made. Scenario/behaviour is
// read from the per-run guarded ledger; nothing is browser-selectable.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runId(): string {
  assertE2eFakeGoogleAllowed(process.env); // fail-closed
  return process.env.HONE_E2E_RUN_ID as string;
}

export async function fakeGoogleFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const rid = runId();
  const scenario = readFakeGoogleScenario(rid);

  // --- Token endpoint (code exchange + refresh) ---
  if (url.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
    const body = typeof init?.body === "string" ? init.body : "";
    const grantType = /grant_type=([^&]+)/.exec(body)?.[1] ?? "authorization_code";
    appendFakeGoogleEvent(rid, { type: "token_exchange", grantType });
    if (grantType === "refresh_token") {
      return json({ access_token: `fake-access-${rid}`, expires_in: 3600 });
    }
    return json({
      access_token: `fake-access-${rid}`,
      refresh_token: `fake-refresh-${rid}`,
      expires_in: 3600,
      scope: scenario.grantedScopes.join(" "),
    });
  }

  // --- tokeninfo fallback ---
  if (url.startsWith(GOOGLE_TOKENINFO_ENDPOINT)) {
    return json({ scope: scenario.grantedScopes.join(" ") });
  }

  // --- OIDC userinfo (account identity) ---
  if (url.startsWith(GOOGLE_USERINFO_ENDPOINT)) {
    return json({ sub: scenario.userSub, email: scenario.userEmail });
  }

  // --- calendarList.list (owned selection + provisioning reconciliation) ---
  if (url.startsWith(GOOGLE_CALENDAR_LIST_ENDPOINT)) {
    const created = createdCalendars(rid).map((c) => ({
      id: c.id,
      summary: "Hone Appointments",
      accessRole: "owner",
      primary: false,
      description: c.description,
    }));
    const items = [
      ...scenario.calendarList.map((c) => ({
        id: c.id,
        summary: c.summary,
        accessRole: c.accessRole,
        primary: false,
        description: c.description,
      })),
      ...created,
    ];
    return json({ items });
  }

  // --- calendars: insert (create secondary) / delete (rollback) ---
  if (url.startsWith(GOOGLE_CALENDARS_ENDPOINT)) {
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "POST") {
      const parsed = safeJson(init?.body);
      const description = typeof parsed?.description === "string" ? parsed.description : "";
      const base = createdCalendars(rid).length;
      if (scenario.provisioning === "ambiguous_multi") {
        // Model a concurrent double-create: two calendars share the exact token,
        // so post-insert reconciliation finds >1 and fails closed.
        const id1 = `fake-cal-${rid}-${base + 1}`;
        const id2 = `fake-cal-${rid}-${base + 2}`;
        appendFakeGoogleEvent(rid, { type: "calendar_created", id: id1, description });
        appendFakeGoogleEvent(rid, { type: "calendar_created", id: id2, description });
        appendFakeGoogleEvent(rid, { type: "calendar_insert_attempt", result: "ok" });
        return json({ id: id1 });
      }
      const id = `fake-cal-${rid}-${base + 1}`;
      // Google DID create the calendar (record it) — but the client sees an error.
      // The retry reconciles by the persisted attempt token and adopts this orphan.
      appendFakeGoogleEvent(rid, { type: "calendar_created", id, description });
      if (scenario.provisioning === "insert_error_orphan") {
        appendFakeGoogleEvent(rid, { type: "calendar_insert_attempt", result: "error" });
        return json({ error: "synthetic_ambiguous_timeout" }, 500);
      }
      appendFakeGoogleEvent(rid, { type: "calendar_insert_attempt", result: "ok" });
      return json({ id });
    }
  }

  // --- revoke (disconnect) ---
  if (url.startsWith(GOOGLE_REVOKE_ENDPOINT)) {
    return new Response(null, { status: 200 });
  }

  // Any other Google URL is unexpected — fail LOUD so a test surfaces it (this
  // never falls through to a real network request).
  return json({ error: "fake_google_unhandled_url", url }, 501);
}

function safeJson(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Record the requested OAuth scope(s) at the (fake) authorize step. Called by the
// guarded fake-authorize route so a test can assert the ACTIVE request path asked
// for ONLY the exact destination scope.
export function recordFakeAuthorizeRequest(scopeParam: string | null): void {
  const rid = runId();
  const scopes = (scopeParam ?? "").split(/\s+/).filter(Boolean);
  appendFakeGoogleEvent(rid, { type: "authorize", scopes });
}
