import { describe, expect, it, vi } from "vitest";
import { buildEventMarker, deriveEventId } from "@/lib/google-calendar/sync/event-id";
import type { GoogleError } from "@/lib/google-calendar/sync/errors";
import type { DeleteSuccess, EventSuccess, GoogleFailure, GoogleRestClient } from "@/lib/google-calendar/sync/google-rest-client";
import type { SyncOperationContext } from "@/lib/google-calendar/sync/handler";
import type { ClaimedJob, JobResult } from "@/lib/google-calendar/sync/job-result";
import { OpsStoreError } from "@/lib/google-calendar/sync/link-transition-store";
import type { AppointmentState, LinkRow, OpsLinkStore, TransitionArgs, TransitionResult } from "@/lib/google-calendar/sync/link-transition-store";
import { createCalendarSyncOperations, type OperationDeps } from "@/lib/google-calendar/sync/operations";

// Phase B2.3-c1 — create / placeholder-update / real-update / delete + provider
// reconciliation, at the MOCKED-OPERATION unit level (GoogleRestClient methods and
// the transactional store are mocked). Actual REST transport composition is covered
// separately in operations-transport.test.ts. No real Google call, no DB.

const STUDIO = "s1";
const CONN = "c1";
const APPT = "a1";
const LINK_ID = "l1";
const CAL = "cal";

function job(over: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: "job-1", studioId: STUDIO, connectionId: CONN, opType: "event.create",
    honeEntityType: "appointment", honeEntityId: APPT, payload: { sync_version: 3 },
    idempotencyKey: "k", attempts: 1, maxAttempts: 8, claimToken: "tok",
    leaseExpiresAt: "2026-07-15T00:00:00Z", priority: 100, ...over,
  };
}
function appt(over: Partial<AppointmentState> = {}): AppointmentState {
  return { id: APPT, studioId: STUDIO, status: "confirmed", syncVersion: 3, startsAt: "2026-07-15T14:00:00Z", endsAt: "2026-07-15T15:00:00Z", studioTimezone: "UTC", ...over };
}
function link(over: Partial<LinkRow> = {}): LinkRow {
  return { id: LINK_ID, studioId: STUDIO, connectionId: CONN, honeEntityType: "appointment", honeEntityId: APPT, googleCalendarId: CAL, googleEventId: null, googleIcalUid: null, googleEtag: null, lastHoneVersion: 0, syncStatus: "pending", deletedAt: null, ...over };
}
function ctx(over: Partial<ClaimedJob> = {}): SyncOperationContext {
  return { job: job(over), accessToken: "at", connection: { writeCalendarId: CAL } as never };
}

const evOk = (event: Record<string, unknown>, etag: string | null = "etag-1", status = 200): EventSuccess => ({ ok: true, status, event, etag });
const err = (kind: GoogleError["kind"], status: number | null, code: string, retryAfterSeconds: number | null = null): GoogleFailure => ({ ok: false, error: { kind, status, code, retryAfterSeconds } });
const notFound = () => err("not_found", 404, "google_http_404");
const conflict = () => err("conflict", 409, "google_http_409");
const pcf = () => err("precondition_failed", 412, "google_http_412");
const scope403 = () => err("insufficient_scope", 403, "google_insufficient_scope");
const rate429 = () => err("rate_limited", 429, "google_http_429", 30);
const auth401 = () => err("token_expired", 401, "google_http_401");
const netTimeout = () => err("transient", null, "network_timeout");
const delOk = (): DeleteSuccess => ({ ok: true, status: 204 });
const evMarker = (linkId: string, extra: Record<string, unknown> = {}) => ({ id: deriveEventId(STUDIO, linkId), status: "confirmed", extendedProperties: { private: buildEventMarker(linkId) }, ...extra });

function rest(over: Partial<GoogleRestClient> = {}): GoogleRestClient {
  return {
    refreshToken: vi.fn(),
    getEvent: vi.fn(async () => notFound()),
    insertEvent: vi.fn(async () => evOk(evMarker(LINK_ID))),
    patchEvent: vi.fn(async () => evOk(evMarker(LINK_ID))),
    deleteEvent: vi.fn(async () => delOk()),
    ...over,
  };
}

type StoreOpts = { link?: LinkRow | null; appt?: AppointmentState | null; transitionResult?: (a: TransitionArgs) => TransitionResult };
function store(opts: StoreOpts = {}) {
  let active: LinkRow | null = opts.link ?? null;
  const byId = new Map<string, LinkRow>();
  if (active) byId.set(active.id, active);
  const appointment = opts.appt ?? null;
  const calls: TransitionArgs[] = [];
  const s: OpsLinkStore = {
    loadActiveLinkByEntity: vi.fn(async () => active),
    loadLinkById: vi.fn(async (id: string) => byId.get(id) ?? null),
    loadLinkForJob: vi.fn(async (id: string, studioId: string, connectionId: string) => {
      const l = byId.get(id) ?? null;
      return l && l.studioId === studioId && l.connectionId === connectionId ? l : null;
    }),
    loadAppointmentState: vi.fn(async () => appointment),
    transition: vi.fn(async (a: TransitionArgs): Promise<TransitionResult> => {
      calls.push(a);
      if (opts.transitionResult) return opts.transitionResult(a);
      if (a.action === "rotate_for_recreate") {
        if (active) byId.set(active.id, { ...active, deletedAt: "now", syncStatus: "deleted" });
        const fresh = { ...(opts.link as LinkRow), id: "fresh-link", googleEventId: null, googleEtag: null, googleIcalUid: null, lastHoneVersion: 0, syncStatus: "pending", deletedAt: null };
        byId.set(fresh.id, fresh);
        active = fresh;
        return { status: "ok", code: "rotated", linkId: "fresh-link" };
      }
      if ((a.action === "bind_confirmed" || a.action === "update_confirmed") && active && active.id === a.linkId) {
        active = { ...active, googleEventId: a.googleEventId ?? null, googleEtag: a.googleEtag ?? null, lastHoneVersion: a.expectedSourceVersion ?? 0, syncStatus: "synced" };
        byId.set(active.id, active);
      }
      return { status: "ok", code: a.action };
    }),
  };
  return { store: s, calls };
}

function run(opType: ClaimedJob["opType"], deps: OperationDeps, c: SyncOperationContext): Promise<JobResult> {
  return createCalendarSyncOperations(deps)[opType]!(c);
}

describe("create / placeholder create-and-bind", () => {
  it("normal create: insert -> validate -> bind -> ok", async () => {
    const r = rest();
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok" });
    expect((r.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0].event.id).toBe(deriveEventId(STUDIO, LINK_ID));
    const bind = calls.find((c) => c.action === "bind_confirmed");
    expect(bind?.expectedSourceVersion).toBe(3);
  });

  it("placeholder event.update -> create-and-bind (no direct real PATCH of a bound event)", async () => {
    const r = rest();
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }));
    expect(res).toEqual({ code: "ok" });
    expect(r.insertEvent).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.action === "bind_confirmed")).toBe(true);
  });

  it("duplicate replay of an applied link -> ok_noop_superseded, no Google call", async () => {
    const r = rest();
    const { store: st } = store({ link: link({ googleEventId: deriveEventId(STUDIO, LINK_ID), lastHoneVersion: 3 }), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok_noop_superseded" });
    expect(r.insertEvent).not.toHaveBeenCalled();
    expect(r.getEvent).not.toHaveBeenCalled();
  });

  it("409 duplicate -> GET live+marker -> ADOPT via PATCH of the current payload, then bind (never bind as-found)", async () => {
    const r = rest({ insertEvent: vi.fn(async () => conflict()), getEvent: vi.fn(async () => evOk(evMarker(LINK_ID), "etag-get")) });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok" });
    // addendum §2: adoption PATCHes the current payload (If-Match from the GET) BEFORE binding.
    expect(r.patchEvent).toHaveBeenCalledTimes(1);
    expect((r.patchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0].etag).toBe("etag-get");
    expect(calls.some((c) => c.action === "bind_confirmed")).toBe(true);
  });

  it("409 duplicate -> GET foreign marker -> terminal_conflict, no bind", async () => {
    const r = rest({ insertEvent: vi.fn(async () => conflict()), getEvent: vi.fn(async () => evOk(evMarker("other"))) });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res.code).toBe("terminal_conflict");
    expect(r.patchEvent).not.toHaveBeenCalled();
    expect(calls.some((c) => c.action === "bind_confirmed")).toBe(false);
  });

  it("409 -> GET cancelled+marker -> rotate -> create under a fresh id", async () => {
    const r = rest({
      insertEvent: vi.fn().mockResolvedValueOnce(conflict()).mockResolvedValueOnce(evOk(evMarker("fresh-link"))),
      getEvent: vi.fn(async () => evOk(evMarker(LINK_ID, { status: "cancelled" }))),
    });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok" });
    expect(calls.some((c) => c.action === "rotate_for_recreate")).toBe(true);
    expect(calls.find((c) => c.action === "bind_confirmed")?.linkId).toBe("fresh-link");
  });

  it("insert timeout (ambiguous) -> GET-first reconciliation, no duplicate", async () => {
    const r = rest({ insertEvent: vi.fn(async () => netTimeout()), getEvent: vi.fn(async () => evOk(evMarker(LINK_ID), "etag-get")) });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok" });
    expect(r.getEvent).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.action === "bind_confirmed")).toBe(true);
  });

  it("insert 2xx then bind rejected (stale claim) -> ok_noop_superseded", async () => {
    const r = rest();
    const { store: st } = store({ link: link(), appt: appt(), transitionResult: () => ({ status: "rejected", code: "stale_token" }) });
    expect((await run("event.create", { rest: r, store: st }, ctx())).code).toBe("ok_noop_superseded");
  });

  it("moved_link_conflict on bind -> terminal_conflict; foreign_event_conflict -> terminal_conflict", async () => {
    const r1 = rest();
    const s1 = store({ link: link(), appt: appt(), transitionResult: () => ({ status: "rejected", code: "moved_link_conflict" }) });
    expect((await run("event.create", { rest: r1, store: s1.store }, ctx())).code).toBe("terminal_conflict");
    const r2 = rest();
    const s2 = store({ link: link(), appt: appt(), transitionResult: () => ({ status: "rejected", code: "foreign_event_conflict" }) });
    expect((await run("event.create", { rest: r2, store: s2.store }, ctx())).code).toBe("terminal_conflict");
  });

  it("bound_older_version -> routes to the real update path", async () => {
    let n = 0;
    const r = rest({ patchEvent: vi.fn(async () => evOk(evMarker(LINK_ID))) });
    const { store: st, calls } = store({ link: link(), appt: appt(), transitionResult: (a) => {
      if (a.action === "bind_confirmed") { n++; return n === 1 ? { status: "rejected", code: "bound_older_version" } : { status: "ok", code: "bound" }; }
      return { status: "ok", code: a.action };
    } });
    // After bound_older_version the op re-fences; the (still-placeholder) mock link stays create-mode,
    // so it retries bind and succeeds — proving the reject is not a silent success.
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res.code).toBe("ok");
    expect(calls.filter((c) => c.action === "bind_confirmed").length).toBeGreaterThanOrEqual(1);
  });
});

describe("response validation (§7)", () => {
  const cases: Array<[string, Record<string, unknown>, string | null, string]> = [
    ["mismatched id -> conflict", evMarker(LINK_ID, { id: "wrong-id" }), "e", "terminal_conflict"],
    ["mismatched marker -> conflict", evMarker("other", { id: deriveEventId(STUDIO, LINK_ID) }), "e", "terminal_conflict"],
  ];
  for (const [name, event, etag, expected] of cases) {
    it(name, async () => {
      const r = rest({ insertEvent: vi.fn(async () => evOk(event, etag)), getEvent: vi.fn(async () => evOk(evMarker(LINK_ID))) });
      const { store: st } = store({ link: link(), appt: appt() });
      expect((await run("event.create", { rest: r, store: st }, ctx())).code).toBe(expected);
    });
  }

  it("cancelled 2xx (ours) -> rotate -> create fresh -> ok (never bind cancelled)", async () => {
    const r = rest({
      insertEvent: vi.fn().mockResolvedValueOnce(evOk(evMarker(LINK_ID, { status: "cancelled" }))).mockResolvedValueOnce(evOk(evMarker("fresh-link"))),
    });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    expect((await run("event.create", { rest: r, store: st }, ctx())).code).toBe("ok");
    expect(calls.some((c) => c.action === "rotate_for_recreate")).toBe(true);
  });

  it("missing id / missing marker / missing etag -> GET reconcile then bind", async () => {
    const pairs: Array<[Record<string, unknown>, string | null]> = [
      [{ status: "confirmed", extendedProperties: { private: buildEventMarker(LINK_ID) } }, "e"], // missing id
      [evMarker(LINK_ID, { extendedProperties: {} }), "e"], // missing marker
      [evMarker(LINK_ID), null], // missing etag
    ];
    for (const [bad, etag] of pairs) {
      const r = rest({ insertEvent: vi.fn(async () => evOk(bad, etag)), getEvent: vi.fn(async () => evOk(evMarker(LINK_ID), "etag-get")) });
      const { store: st } = store({ link: link(), appt: appt() });
      expect((await run("event.create", { rest: r, store: st }, ctx()))).toEqual({ code: "ok" });
      expect(r.getEvent).toHaveBeenCalled(); // reconciled via GET, never bound from the unvalidated 2xx
    }
  });

  it("GET recovery still unverified -> retry_transient (never bind)", async () => {
    const r = rest({ insertEvent: vi.fn(async () => evOk(evMarker(LINK_ID), null)), getEvent: vi.fn(async () => evOk({ id: deriveEventId(STUDIO, LINK_ID), status: "confirmed", extendedProperties: {} }, "e")) });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res.code).toBe("retry_transient");
    expect(calls.some((c) => c.action === "bind_confirmed")).toBe(false);
  });
});

describe("real update", () => {
  const realLink = () => link({ googleEventId: deriveEventId(STUDIO, LINK_ID), googleEtag: "etag-old", lastHoneVersion: 2 });

  it("patch 2xx -> update_confirmed -> ok (If-Match + marker in body)", async () => {
    const r = rest();
    const { store: st, calls } = store({ link: realLink(), appt: appt() });
    const res = await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }));
    expect(res).toEqual({ code: "ok" });
    const p = (r.patchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(p.etag).toBe("etag-old");
    expect(p.event.extendedProperties.private).toEqual(buildEventMarker(LINK_ID));
    expect(calls.some((c) => c.action === "update_confirmed")).toBe(true);
  });

  it("412 -> GET verifies OUR marker -> re-fence -> reapply -> ok", async () => {
    const r = rest({ patchEvent: vi.fn().mockResolvedValueOnce(pcf()).mockResolvedValueOnce(evOk(evMarker(LINK_ID), "etag-new")), getEvent: vi.fn(async () => evOk(evMarker(LINK_ID), "etag-new")) });
    const { store: st } = store({ link: realLink(), appt: appt() });
    expect((await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }))).code).toBe("ok");
    expect(r.getEvent).toHaveBeenCalledTimes(1);
  });

  it("412 -> GET foreign/mismatched marker -> terminal_conflict, no reapply", async () => {
    const r = rest({ patchEvent: vi.fn(async () => pcf()), getEvent: vi.fn(async () => evOk(evMarker("other"))) });
    const { store: st } = store({ link: realLink(), appt: appt() });
    expect((await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }))).code).toBe("terminal_conflict");
    expect((r.patchEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // never reapplied
  });

  it("404 / cancelled -> rotate to a fresh id (never bind cancelled)", async () => {
    const r1 = rest({ patchEvent: vi.fn(async () => notFound()), insertEvent: vi.fn(async () => evOk(evMarker("fresh-link"))) });
    const s1 = store({ link: realLink(), appt: appt() });
    const res1 = await run("event.update", { rest: r1, store: s1.store }, ctx({ opType: "event.update" }));
    expect(res1).toEqual({ code: "ok" });
    expect(s1.calls.some((c) => c.action === "rotate_for_recreate")).toBe(true);

    const r2 = rest({ patchEvent: vi.fn(async () => evOk(evMarker(LINK_ID, { status: "cancelled" }))), insertEvent: vi.fn(async () => evOk(evMarker("fresh-link"))) });
    const s2 = store({ link: realLink(), appt: appt() });
    await run("event.update", { rest: r2, store: s2.store }, ctx({ opType: "event.update" }));
    expect(s2.calls.some((c) => c.action === "rotate_for_recreate")).toBe(true);
    expect(s2.calls.some((c) => c.action === "update_confirmed")).toBe(false);
  });

  it("scope loss -> terminal_insufficient_scope; rate limit -> retry_rate_limited", async () => {
    const s1 = store({ link: realLink(), appt: appt() });
    expect((await run("event.update", { rest: rest({ patchEvent: vi.fn(async () => scope403()) }), store: s1.store }, ctx({ opType: "event.update" }))).code).toBe("terminal_insufficient_scope");
    const s2 = store({ link: realLink(), appt: appt() });
    expect((await run("event.update", { rest: rest({ patchEvent: vi.fn(async () => rate429()) }), store: s2.store }, ctx({ opType: "event.update" }))).code).toBe("retry_rate_limited");
  });
});

describe("delete + GET-verified placeholder orphan recovery", () => {
  const realLink = () => link({ googleEventId: deriveEventId(STUDIO, LINK_ID), googleEtag: "etag-1" });
  const delCtx = () => ctx({ opType: "event.delete", payload: { sync_version: 3 } });

  it("real delete 2xx / 404 -> converged", async () => {
    const s1 = store({ link: realLink(), appt: appt({ status: "cancelled" }) });
    expect((await run("event.delete", { rest: rest(), store: s1.store }, delCtx())).code).toBe("ok_noop_tombstone_deleted");
    const s2 = store({ link: realLink(), appt: appt({ status: "cancelled" }) });
    expect((await run("event.delete", { rest: rest({ deleteEvent: vi.fn(async () => notFound()) }), store: s2.store }, delCtx())).code).toBe("ok_noop_tombstone_deleted");
  });

  it("real delete 412 -> GET verifies OUR marker -> delete with fresh etag", async () => {
    const r = rest({ deleteEvent: vi.fn().mockResolvedValueOnce(pcf()).mockResolvedValueOnce(delOk()), getEvent: vi.fn(async () => evOk(evMarker(LINK_ID), "etag-new")) });
    const { store: st } = store({ link: realLink(), appt: appt({ status: "cancelled" }) });
    expect((await run("event.delete", { rest: r, store: st }, delCtx())).code).toBe("ok_noop_tombstone_deleted");
    expect(r.getEvent).toHaveBeenCalledTimes(1);
  });

  it("real delete 412 -> GET foreign marker -> terminal_conflict, no delete", async () => {
    const r = rest({ deleteEvent: vi.fn(async () => pcf()), getEvent: vi.fn(async () => evOk(evMarker("other"))) });
    const { store: st } = store({ link: realLink(), appt: appt({ status: "cancelled" }) });
    expect((await run("event.delete", { rest: r, store: st }, delCtx())).code).toBe("terminal_conflict");
    expect((r.deleteEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("placeholder: live+marker -> delete; cancelled -> no delete; 404 -> no delete; foreign -> conflict", async () => {
    const p1 = store({ link: link(), appt: appt({ status: "cancelled" }) });
    const r1 = rest({ getEvent: vi.fn(async () => evOk(evMarker(LINK_ID))) });
    expect((await run("event.delete", { rest: r1, store: p1.store }, delCtx())).code).toBe("ok_noop_tombstone_deleted");
    expect(r1.deleteEvent).toHaveBeenCalledTimes(1);

    const p2 = store({ link: link(), appt: appt({ status: "cancelled" }) });
    const r2 = rest({ getEvent: vi.fn(async () => evOk(evMarker(LINK_ID, { status: "cancelled" }))) });
    expect((await run("event.delete", { rest: r2, store: p2.store }, delCtx())).code).toBe("ok_noop_tombstone_deleted");
    expect(r2.deleteEvent).not.toHaveBeenCalled();

    const p3 = store({ link: link(), appt: appt({ status: "cancelled" }) });
    const r3 = rest({ getEvent: vi.fn(async () => notFound()) });
    expect((await run("event.delete", { rest: r3, store: p3.store }, delCtx())).code).toBe("ok_noop_tombstone_deleted");
    expect(r3.deleteEvent).not.toHaveBeenCalled();

    const p4 = store({ link: link(), appt: appt({ status: "cancelled" }) });
    const r4 = rest({ getEvent: vi.fn(async () => evOk(evMarker("other"))) });
    expect((await run("event.delete", { rest: r4, store: p4.store }, delCtx())).code).toBe("terminal_conflict");
    expect(r4.deleteEvent).not.toHaveBeenCalled();
  });

  it("entity-less orphan delete: link from another studio/connection -> terminal_conflict, no Google call", async () => {
    const foreign = link({ id: "orphan-1", studioId: "OTHER", connectionId: "OTHERC", googleEventId: "ev" });
    const st = store({ link: foreign });
    const r = rest();
    const c: SyncOperationContext = { job: job({ opType: "event.delete", honeEntityType: null, honeEntityId: null, payload: { hone_link_id: "orphan-1" } }), accessToken: "at", connection: { writeCalendarId: CAL } as never };
    const res = await run("event.delete", { rest: r, store: st.store }, c);
    expect(res.code).toBe("terminal_conflict");
    expect(r.getEvent).not.toHaveBeenCalled();
    expect(r.deleteEvent).not.toHaveBeenCalled();
  });

  it("timed_block delete is fail-closed", async () => {
    expect(await run("event.delete", { rest: rest(), store: store({}).store }, ctx({ opType: "event.delete", honeEntityType: "timed_block" }))).toEqual({ code: "retry_ineligible", errorCode: "operation_not_implemented" });
  });
});

describe("DB read failure (§8) and 401 invalidation (§9)", () => {
  for (const method of ["loadActiveLinkByEntity", "loadAppointmentState"] as const) {
    it(`${method} throw -> retry_transient, no Google call`, async () => {
      const { store: st } = store({ link: link(), appt: appt() });
      (st[method] as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new OpsStoreError(method); });
      const r = rest();
      const res = await run("event.create", { rest: r, store: st }, ctx());
      expect(res.code).toBe("retry_transient");
      expect(r.insertEvent).not.toHaveBeenCalled();
    });
  }

  it("replacement-link reload (loadLinkById) throw after rotation -> retry_transient", async () => {
    // Force a rotation (404 on patch of a real link) then fail the replacement reload.
    const r = rest({ patchEvent: vi.fn(async () => notFound()) });
    const { store: st } = store({ link: link({ googleEventId: deriveEventId(STUDIO, LINK_ID), googleEtag: "e", lastHoneVersion: 2 }), appt: appt() });
    (st.loadLinkById as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new OpsStoreError("loadLinkById"); });
    expect((await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }))).code).toBe("retry_transient");
  });

  it("Google 401 -> invalidateAccessToken(connectionId) is called, result retry_transient", async () => {
    const invalidate = vi.fn();
    const r = rest({ insertEvent: vi.fn(async () => auth401()) });
    const { store: st } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st, invalidateAccessToken: invalidate }, ctx());
    expect(res.code).toBe("retry_transient");
    expect(invalidate).toHaveBeenCalledWith(CONN);
  });
});
