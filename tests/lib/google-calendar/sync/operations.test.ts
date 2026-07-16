import { describe, expect, it, vi } from "vitest";
import { buildEventMarker, deriveEventId } from "@/lib/google-calendar/sync/event-id";
import type { GoogleError } from "@/lib/google-calendar/sync/errors";
import type { DeleteSuccess, EventSuccess, GoogleFailure, GoogleRestClient } from "@/lib/google-calendar/sync/google-rest-client";
import type { SyncOperationContext } from "@/lib/google-calendar/sync/handler";
import type { ClaimedJob, JobResult } from "@/lib/google-calendar/sync/job-result";
import type { AppointmentState, LinkRow, OpsLinkStore, TransitionArgs, TransitionResult } from "@/lib/google-calendar/sync/link-transition-store";
import { createCalendarSyncOperations } from "@/lib/google-calendar/sync/operations";

// Phase B2.3-c1 — create / placeholder-update / real-update / delete + provider
// reconciliation, driven at the fake-Google HTTP + mock-store level. No real
// Google call and no DB — the REST client and the transactional store are mocked.

const STUDIO = "s1";
const CONN = "c1";
const APPT = "a1";
const LINK_ID = "l1";

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
  return { id: LINK_ID, studioId: STUDIO, connectionId: CONN, honeEntityType: "appointment", honeEntityId: APPT, googleCalendarId: "cal", googleEventId: null, googleIcalUid: null, googleEtag: null, lastHoneVersion: 0, syncStatus: "pending", deletedAt: null, ...over };
}
function ctx(over: Partial<ClaimedJob> = {}): SyncOperationContext {
  return { job: job(over), accessToken: "at", connection: {} as never };
}

// --- fake Google responses ---
const evOk = (event: Record<string, unknown>, etag = "etag-1", status = 200): EventSuccess => ({ ok: true, status, event, etag });
const err = (kind: GoogleError["kind"], status: number | null, code: string, retryAfterSeconds: number | null = null): GoogleFailure => ({ ok: false, error: { kind, status, code, retryAfterSeconds } });
const notFound = () => err("not_found", 404, "google_http_404");
const conflict = () => err("conflict", 409, "google_http_409");
const pcf = () => err("precondition_failed", 412, "google_http_412");
const scope403 = () => err("insufficient_scope", 403, "google_insufficient_scope");
const rate429 = () => err("rate_limited", 429, "google_http_429", 30);
const netTimeout = () => err("transient", null, "network_timeout");
const delOk = (): DeleteSuccess => ({ ok: true, status: 204 });
const eventWithMarker = (linkId: string, extra: Record<string, unknown> = {}) => ({ id: deriveEventId(STUDIO, linkId), status: "confirmed", extendedProperties: { private: buildEventMarker(linkId) }, ...extra });

function rest(over: Partial<GoogleRestClient> = {}): GoogleRestClient {
  return {
    refreshToken: vi.fn(),
    getEvent: vi.fn(async () => notFound()),
    insertEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID))),
    patchEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID))),
    deleteEvent: vi.fn(async () => delOk()),
    ...over,
  };
}

type StoreOpts = {
  link?: LinkRow | null;
  appt?: AppointmentState | null;
  transitionResult?: (a: TransitionArgs) => TransitionResult;
};
function store(opts: StoreOpts = {}) {
  const links = new Map<string, LinkRow>();
  if (opts.link) links.set(opts.link.id, opts.link);
  const calls: TransitionArgs[] = [];
  const s: OpsLinkStore = {
    loadActiveLinkByEntity: vi.fn(async () => opts.link ?? null),
    loadLinkById: vi.fn(async (id: string) => links.get(id) ?? null),
    loadAppointmentState: vi.fn(async () => opts.appt ?? null),
    transition: vi.fn(async (a: TransitionArgs): Promise<TransitionResult> => {
      calls.push(a);
      if (opts.transitionResult) return opts.transitionResult(a);
      if (a.action === "rotate_for_recreate") {
        const fresh = { ...(opts.link as LinkRow), id: "fresh-link", googleEventId: null, googleEtag: null, googleIcalUid: null, lastHoneVersion: 0, syncStatus: "pending", deletedAt: null };
        links.set(fresh.id, fresh);
        return { status: "ok", code: "rotated", linkId: "fresh-link" };
      }
      return { status: "ok", code: a.action };
    }),
  };
  return { store: s, calls };
}

function run(opType: ClaimedJob["opType"], deps: { rest: GoogleRestClient; store: OpsLinkStore }, c: SyncOperationContext): Promise<JobResult> {
  const ops = createCalendarSyncOperations(deps);
  return ops[opType]!(c);
}

describe("create / placeholder create-and-bind", () => {
  it("normal create: insert -> bind_confirmed -> ok", async () => {
    const r = rest();
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok" });
    expect(r.insertEvent).toHaveBeenCalledTimes(1);
    // The caller-supplied deterministic id is in the insert body.
    expect((r.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0][0].event.id).toBe(deriveEventId(STUDIO, LINK_ID));
    expect(calls[0].action).toBe("bind_confirmed");
    expect(calls[0].googleEventId).toBe(deriveEventId(STUDIO, LINK_ID));
  });

  it("placeholder event.update performs create-and-bind (no PATCH, no second op)", async () => {
    const r = rest();
    const { store: st } = store({ link: link(), appt: appt() });
    const res = await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }));
    expect(res).toEqual({ code: "ok" });
    expect(r.insertEvent).toHaveBeenCalledTimes(1);
    expect(r.patchEvent).not.toHaveBeenCalled();
  });

  it("duplicate replay of an applied link -> ok_noop_superseded, no Google call", async () => {
    const r = rest();
    const applied = link({ googleEventId: deriveEventId(STUDIO, LINK_ID), lastHoneVersion: 3 });
    const { store: st } = store({ link: applied, appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok_noop_superseded" });
    expect(r.insertEvent).not.toHaveBeenCalled();
    expect(r.getEvent).not.toHaveBeenCalled();
  });

  it("409 duplicate -> GET live + matching marker -> bind (idempotent, no 2nd event)", async () => {
    const r = rest({ insertEvent: vi.fn(async () => conflict()), getEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID))) });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok" });
    expect(calls.filter((c) => c.action === "bind_confirmed")).toHaveLength(1);
  });

  it("409 duplicate -> GET foreign marker -> terminal_conflict (never overwrite)", async () => {
    const r = rest({ insertEvent: vi.fn(async () => conflict()), getEvent: vi.fn(async () => evOk(eventWithMarker("some-other-link"))) });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res.code).toBe("terminal_conflict");
    expect(calls.some((c) => c.action === "bind_confirmed")).toBe(false);
  });

  it("409 -> GET cancelled + matching marker -> rotate -> create under a fresh id", async () => {
    const r = rest({
      insertEvent: vi.fn()
        .mockResolvedValueOnce(conflict())
        .mockResolvedValueOnce(evOk(eventWithMarker("fresh-link"))),
      getEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID, { status: "cancelled" }))),
    });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok" });
    expect(calls.some((c) => c.action === "rotate_for_recreate")).toBe(true);
    // The bind targets the FRESH link (new lifecycle), not the original.
    const bind = calls.find((c) => c.action === "bind_confirmed");
    expect(bind?.linkId).toBe("fresh-link");
    expect(bind?.googleEventId).toBe(deriveEventId(STUDIO, "fresh-link"));
  });

  it("insert timeout (ambiguous) -> GET-first reconciliation, no duplicate", async () => {
    const r = rest({ insertEvent: vi.fn(async () => netTimeout()), getEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID))) });
    const { store: st, calls } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res).toEqual({ code: "ok" });
    expect(r.getEvent).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.action === "bind_confirmed")).toBe(true);
  });

  it("retry (attempts>1) GETs FIRST before any insert", async () => {
    const r = rest({ getEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID))) });
    const { store: st } = store({ link: link(), appt: appt() });
    const res = await run("event.create", { rest: r, store: st }, ctx({ attempts: 2 }));
    expect(res).toEqual({ code: "ok" });
    expect(r.getEvent).toHaveBeenCalledTimes(1);
    expect(r.insertEvent).not.toHaveBeenCalled();
  });

  it("insert 2xx then bind rejected (stale claim) -> ok_noop_superseded (no 2nd Google call)", async () => {
    const r = rest();
    const { store: st } = store({ link: link(), appt: appt(), transitionResult: () => ({ status: "rejected", code: "stale_token" }) });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res.code).toBe("ok_noop_superseded");
    expect(r.insertEvent).toHaveBeenCalledTimes(1);
  });

  it("foreign_event_conflict on bind -> terminal_conflict", async () => {
    const r = rest();
    const { store: st } = store({ link: link(), appt: appt(), transitionResult: () => ({ status: "rejected", code: "foreign_event_conflict" }) });
    const res = await run("event.create", { rest: r, store: st }, ctx());
    expect(res.code).toBe("terminal_conflict");
  });
});

describe("real update", () => {
  const realLink = () => link({ googleEventId: deriveEventId(STUDIO, LINK_ID), googleEtag: "etag-old", lastHoneVersion: 2 });

  it("patch 2xx -> update_confirmed -> ok", async () => {
    const r = rest();
    const { store: st, calls } = store({ link: realLink(), appt: appt() });
    const res = await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }));
    expect(res).toEqual({ code: "ok" });
    expect(r.patchEvent).toHaveBeenCalledTimes(1);
    // If-Match uses the stored etag; the private marker is in the patch body.
    const patchArg = (r.patchEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(patchArg.etag).toBe("etag-old");
    expect(patchArg.event.extendedProperties.private).toEqual(buildEventMarker(LINK_ID));
    expect(calls.some((c) => c.action === "update_confirmed")).toBe(true);
  });

  it("412 stale etag -> re-GET + reapply -> ok", async () => {
    const r = rest({
      patchEvent: vi.fn().mockResolvedValueOnce(pcf()).mockResolvedValueOnce(evOk(eventWithMarker(LINK_ID), "etag-new")),
      getEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID), "etag-new")),
    });
    const { store: st } = store({ link: realLink(), appt: appt() });
    const res = await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }));
    expect(res).toEqual({ code: "ok" });
    expect(r.getEvent).toHaveBeenCalledTimes(1);
    expect(r.patchEvent).toHaveBeenCalledTimes(2);
  });

  it("patch 404 (missing remote) while confirmed -> rotate -> create fresh id", async () => {
    const r = rest({ patchEvent: vi.fn(async () => notFound()), insertEvent: vi.fn(async () => evOk(eventWithMarker("fresh-link"))) });
    const { store: st, calls } = store({ link: realLink(), appt: appt() });
    const res = await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }));
    expect(res).toEqual({ code: "ok" });
    expect(calls.some((c) => c.action === "rotate_for_recreate")).toBe(true);
  });

  it("patch returns a cancelled event -> rotate (never bind cancelled as synced)", async () => {
    const r = rest({ patchEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID, { status: "cancelled" }))), insertEvent: vi.fn(async () => evOk(eventWithMarker("fresh-link"))) });
    const { store: st, calls } = store({ link: realLink(), appt: appt() });
    const res = await run("event.update", { rest: r, store: st }, ctx({ opType: "event.update" }));
    expect(res).toEqual({ code: "ok" });
    expect(calls.some((c) => c.action === "rotate_for_recreate")).toBe(true);
    expect(calls.some((c) => c.action === "update_confirmed")).toBe(false);
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

  it("real link delete 2xx -> mark_deleted -> ok_noop_tombstone_deleted", async () => {
    const r = rest();
    const { store: st, calls } = store({ link: realLink(), appt: appt({ status: "cancelled" }) });
    const res = await run("event.delete", { rest: r, store: st }, ctx({ opType: "event.delete", payload: { sync_version: 3 } }));
    expect(res).toEqual({ code: "ok_noop_tombstone_deleted" });
    expect(calls.some((c) => c.action === "mark_deleted")).toBe(true);
  });

  it("real link delete 404/410 -> converged", async () => {
    const r = rest({ deleteEvent: vi.fn(async () => notFound()) });
    const { store: st } = store({ link: realLink(), appt: appt({ status: "cancelled" }) });
    const res = await run("event.delete", { rest: r, store: st }, ctx({ opType: "event.delete", payload: { sync_version: 3 } }));
    expect(res).toEqual({ code: "ok_noop_tombstone_deleted" });
  });

  it("placeholder: GET live + matching marker -> DELETE -> converged", async () => {
    const r = rest({ getEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID))), deleteEvent: vi.fn(async () => delOk()) });
    const { store: st } = store({ link: link(), appt: appt({ status: "cancelled" }) });
    const res = await run("event.delete", { rest: r, store: st }, ctx({ opType: "event.delete", payload: { sync_version: 3 } }));
    expect(res).toEqual({ code: "ok_noop_tombstone_deleted" });
    expect(r.deleteEvent).toHaveBeenCalledTimes(1);
  });

  it("placeholder: GET cancelled + matching marker -> NO delete -> converged", async () => {
    const r = rest({ getEvent: vi.fn(async () => evOk(eventWithMarker(LINK_ID, { status: "cancelled" }))) });
    const { store: st } = store({ link: link(), appt: appt({ status: "cancelled" }) });
    const res = await run("event.delete", { rest: r, store: st }, ctx({ opType: "event.delete", payload: { sync_version: 3 } }));
    expect(res).toEqual({ code: "ok_noop_tombstone_deleted" });
    expect(r.deleteEvent).not.toHaveBeenCalled();
  });

  it("placeholder: GET 404 -> NO delete -> converged", async () => {
    const r = rest({ getEvent: vi.fn(async () => notFound()) });
    const { store: st } = store({ link: link(), appt: appt({ status: "cancelled" }) });
    const res = await run("event.delete", { rest: r, store: st }, ctx({ opType: "event.delete", payload: { sync_version: 3 } }));
    expect(res).toEqual({ code: "ok_noop_tombstone_deleted" });
    expect(r.deleteEvent).not.toHaveBeenCalled();
  });

  it("placeholder: GET live + foreign marker -> terminal_conflict, NO delete", async () => {
    const r = rest({ getEvent: vi.fn(async () => evOk(eventWithMarker("other-link"))) });
    const { store: st } = store({ link: link(), appt: appt({ status: "cancelled" }) });
    const res = await run("event.delete", { rest: r, store: st }, ctx({ opType: "event.delete", payload: { sync_version: 3 } }));
    expect(res.code).toBe("terminal_conflict");
    expect(r.deleteEvent).not.toHaveBeenCalled();
  });

  it("timed_block delete is fail-closed (operation_not_implemented)", async () => {
    const r = rest();
    const { store: st } = store({});
    const res = await run("event.delete", { rest: r, store: st }, ctx({ opType: "event.delete", honeEntityType: "timed_block" }));
    expect(res).toEqual({ code: "retry_ineligible", errorCode: "operation_not_implemented" });
  });
});
