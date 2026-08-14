import { describe, expect, it, vi } from "vitest";
import { buildEventMarker, deriveEventId } from "@/lib/google-calendar/sync/event-id";
import { createGoogleRestClient } from "@/lib/google-calendar/sync/google-rest-client";
import type { SyncOperationContext } from "@/lib/google-calendar/sync/handler";
import type { ClaimedJob } from "@/lib/google-calendar/sync/job-result";
import type { AppointmentState, LinkRow, OpsLinkStore, TransitionArgs, TransitionResult } from "@/lib/google-calendar/sync/link-transition-store";
import { createCalendarSyncOperations } from "@/lib/google-calendar/sync/operations";

// Phase B2.3-c1: ACTUAL REST transport-composition tests. The c1 operations run
// through the REAL createGoogleRestClient over a guarded FAKE fetch (never a real
// Google call). This exercises URL construction, sendUpdates=none, the caller-
// supplied id + marker in the body, If-Match, and status-code lifecycle, the
// wire behaviour the mocked-method unit tests in operations.test.ts do NOT cover.

const STUDIO = "s1";
const CONN = "c1";
const APPT = "a1";
const LINK_ID = "l1";
const CAL = "cal";
const EVENT_ID = deriveEventId(STUDIO, LINK_ID);

type Req = { method: string; url: string; headers: Record<string, string>; body: unknown };
function fakeFetch(handler: (req: Req) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Req[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const req: Req = { method: init.method ?? "GET", url: String(url), headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    const r = handler(req);
    return {
      status: r.status,
      headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
      text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)),
    } as unknown as Response;
  });
  return { impl, calls };
}

function link(over: Partial<LinkRow> = {}): LinkRow {
  return { id: LINK_ID, studioId: STUDIO, connectionId: CONN, honeEntityType: "appointment", honeEntityId: APPT, googleCalendarId: CAL, googleEventId: null, googleIcalUid: null, googleEtag: null, lastHoneVersion: 0, syncStatus: "pending", deletedAt: null, ...over };
}
function appt(): AppointmentState {
  return { id: APPT, studioId: STUDIO, status: "confirmed", syncVersion: 3, startsAt: "2026-07-15T14:00:00Z", endsAt: "2026-07-15T15:00:00Z", studioTimezone: "UTC" };
}
function store(l: LinkRow) {
  let active: LinkRow | null = l;
  const byId = new Map([[l.id, l]]);
  const calls: TransitionArgs[] = [];
  const s: OpsLinkStore = {
    loadActiveLinkByEntity: async () => active,
    loadLinkById: async (id) => byId.get(id) ?? null,
    loadLinkForJob: async (id) => byId.get(id) ?? null,
    loadAppointmentState: async () => appt(),
    transition: async (a: TransitionArgs): Promise<TransitionResult> => {
      calls.push(a);
      if (a.action === "rotate_for_recreate") { const f = { ...l, id: "fresh", googleEventId: null } as LinkRow; byId.set("fresh", f); active = f; return { status: "ok", code: "rotated", linkId: "fresh" }; }
      return { status: "ok", code: a.action };
    },
  };
  return { store: s, calls };
}
function ctx(over: Partial<ClaimedJob> = {}): SyncOperationContext {
  return {
    job: { id: "job-1", studioId: STUDIO, connectionId: CONN, opType: "event.create", honeEntityType: "appointment", honeEntityId: APPT, payload: { sync_version: 3 }, idempotencyKey: "k", attempts: 1, maxAttempts: 8, claimToken: "tok", leaseExpiresAt: "2026-07-15T00:00:00Z", priority: 100, ...over },
    accessToken: "AT-SECRET",
    connection: { writeCalendarId: CAL } as never,
  };
}
const marker = (linkId: string, extra: Record<string, unknown> = {}) => ({ id: deriveEventId(STUDIO, linkId), status: "confirmed", etag: "e-srv", extendedProperties: { private: buildEventMarker(linkId) }, ...extra });

describe("REST transport composition", () => {
  it("create: POST …/events?sendUpdates=none with the deterministic id + marker in the body", async () => {
    const f = fakeFetch((req) => (req.method === "POST" ? { status: 200, body: marker(LINK_ID) } : { status: 404 }));
    const rest = createGoogleRestClient({ fetchImpl: f.impl as never });
    const st = store(link());
    const res = await createCalendarSyncOperations({ invalidateAccessToken: () => {}, rest, store: st.store })["event.create"]!(ctx());
    expect(res).toEqual({ code: "ok" });
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain(`/calendars/${CAL}/events`);
    expect(post.url).toContain("sendUpdates=none");
    expect((post.body as { id: string }).id).toBe(EVENT_ID);
    expect((post.body as { extendedProperties: { private: unknown } }).extendedProperties.private).toEqual(buildEventMarker(LINK_ID));
    expect(post.headers.authorization).toBe("Bearer AT-SECRET");
  });

  it("real update: PATCH carries If-Match; delete: DELETE carries If-Match + sendUpdates=none", async () => {
    const l = link({ googleEventId: EVENT_ID, googleEtag: "e-old", lastHoneVersion: 2 });
    const f = fakeFetch((req) => (req.method === "PATCH" ? { status: 200, body: marker(LINK_ID) } : { status: 404 }));
    const rest = createGoogleRestClient({ fetchImpl: f.impl as never });
    await createCalendarSyncOperations({ invalidateAccessToken: () => {}, rest, store: store(l).store })["event.update"]!(ctx({ opType: "event.update" }));
    const patch = f.calls.find((c) => c.method === "PATCH")!;
    expect(patch.headers["if-match"]).toBe("e-old");
    expect(patch.url).toContain("sendUpdates=none");

    const f2 = fakeFetch((req) => (req.method === "DELETE" ? { status: 204 } : { status: 404 }));
    const rest2 = createGoogleRestClient({ fetchImpl: f2.impl as never });
    await createCalendarSyncOperations({ invalidateAccessToken: () => {}, rest: rest2, store: store(l).store })["event.delete"]!(ctx({ opType: "event.delete", payload: { sync_version: 3 } }));
    const del = f2.calls.find((c) => c.method === "DELETE")!;
    expect(del.headers["if-match"]).toBe("e-old");
    expect(del.url).toContain("sendUpdates=none");
  });

  it("409 duplicate -> GET the id (ownership reconciliation) before any further write", async () => {
    let posts = 0;
    const f = fakeFetch((req) => {
      if (req.method === "POST") { posts++; return { status: 409, body: { error: { errors: [{ reason: "duplicate" }] } } }; }
      if (req.method === "GET") return { status: 200, body: marker(LINK_ID) };
      if (req.method === "PATCH") return { status: 200, body: marker(LINK_ID) };
      return { status: 404 };
    });
    const rest = createGoogleRestClient({ fetchImpl: f.impl as never });
    const res = await createCalendarSyncOperations({ invalidateAccessToken: () => {}, rest, store: store(link()).store })["event.create"]!(ctx());
    expect(res).toEqual({ code: "ok" });
    expect(f.calls.some((c) => c.method === "GET")).toBe(true); // reconciled via GET
    expect(posts).toBe(1); // never blind-re-inserted
  });

  it("412 PATCH -> GET verifies marker; a FOREIGN marker aborts with terminal_conflict (no reapply)", async () => {
    const l = link({ googleEventId: EVENT_ID, googleEtag: "e-old", lastHoneVersion: 2 });
    let patches = 0;
    const f = fakeFetch((req) => {
      if (req.method === "PATCH") { patches++; return { status: 412, body: { error: { errors: [{ reason: "conditionNotMet" }] } } }; }
      if (req.method === "GET") return { status: 200, body: marker("foreign-link") }; // marker for a different link
      return { status: 404 };
    });
    const rest = createGoogleRestClient({ fetchImpl: f.impl as never });
    const res = await createCalendarSyncOperations({ invalidateAccessToken: () => {}, rest, store: store(l).store })["event.update"]!(ctx({ opType: "event.update" }));
    expect(res.code).toBe("terminal_conflict");
    expect(patches).toBe(1); // never reapplied over a foreign event
  });

  it("412 DELETE -> GET verifies marker before deleting; foreign marker -> terminal_conflict (no delete)", async () => {
    const l = link({ googleEventId: EVENT_ID, googleEtag: "e-old" });
    let deletes = 0;
    const f = fakeFetch((req) => {
      if (req.method === "DELETE") { deletes++; return { status: 412, body: { error: { errors: [{ reason: "conditionNotMet" }] } } }; }
      if (req.method === "GET") return { status: 200, body: marker("foreign-link") };
      return { status: 404 };
    });
    const rest = createGoogleRestClient({ fetchImpl: f.impl as never });
    const res = await createCalendarSyncOperations({ invalidateAccessToken: () => {}, rest, store: store(l).store })["event.delete"]!(ctx({ opType: "event.delete", payload: { sync_version: 3 } }));
    expect(res.code).toBe("terminal_conflict");
    expect(deletes).toBe(1); // GET-verified before a second delete; foreign -> no delete
  });

  it("404/410 on delete is converged; no token or payload is ever logged", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.map(String).join(" ")); });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => { logs.push(a.map(String).join(" ")); });
    const l = link({ googleEventId: EVENT_ID, googleEtag: "e" });
    const f = fakeFetch(() => ({ status: 410, body: { error: { errors: [{ reason: "deleted" }] } } }));
    const rest = createGoogleRestClient({ fetchImpl: f.impl as never });
    const res = await createCalendarSyncOperations({ invalidateAccessToken: () => {}, rest, store: store(l).store })["event.delete"]!(ctx({ opType: "event.delete", payload: { sync_version: 3 } }));
    expect(res.code).toBe("ok_noop_tombstone_deleted");
    const joined = logs.join("\n");
    expect(joined).not.toContain("AT-SECRET");
    expect(joined.toLowerCase()).not.toContain("bearer ");
    spy.mockRestore();
    errSpy.mockRestore();
  });
  it("update PATCH 2xx missing marker -> GET reconciliation over the real client -> update_confirmed with the GET ETag", async () => {
    const l = link({ googleEventId: EVENT_ID, googleEtag: "e-old", lastHoneVersion: 2 });
    const f = fakeFetch((req) => {
      if (req.method === "PATCH") return { status: 200, body: { id: EVENT_ID, status: "confirmed", etag: "e-srv" } }; // no marker -> needs_get
      if (req.method === "GET") return { status: 200, body: marker(LINK_ID, { etag: "e-get" }) };
      return { status: 404 };
    });
    const rest = createGoogleRestClient({ fetchImpl: f.impl as never });
    const st = store(l);
    const res = await createCalendarSyncOperations({ invalidateAccessToken: () => {}, rest, store: st.store })["event.update"]!(ctx({ opType: "event.update" }));
    expect(res).toEqual({ code: "ok" });
    expect(f.calls.some((c) => c.method === "GET")).toBe(true);
    expect(st.calls.find((c) => c.action === "update_confirmed")?.googleEtag).toBe("e-get");
  });

  it("update PATCH 2xx mismatched id -> terminal_conflict (never persisted)", async () => {
    const l = link({ googleEventId: EVENT_ID, googleEtag: "e-old", lastHoneVersion: 2 });
    const f = fakeFetch((req) => (req.method === "PATCH" ? { status: 200, body: { id: "WRONG", status: "confirmed", etag: "e" } } : { status: 404 }));
    const rest = createGoogleRestClient({ fetchImpl: f.impl as never });
    const st = store(l);
    const res = await createCalendarSyncOperations({ invalidateAccessToken: () => {}, rest, store: st.store })["event.update"]!(ctx({ opType: "event.update" }));
    expect(res.code).toBe("terminal_conflict");
    expect(st.calls.some((c) => c.action === "update_confirmed")).toBe(false);
  });
});
