import { describe, expect, it, vi } from "vitest";
import {
  classifyActiveLink,
  classifyConfirmedAppointment,
  reconcileStudio,
  runReconciliation,
  type OpenJob,
  type ReconcileApptState,
  type ReconcileContinuation,
  type ReconcileContinuationStore,
  type ReconcileLinkRow,
  type ReconcileLock,
  type ReconcileStore,
  type StudioReconcileResult,
} from "@/lib/google-calendar/sync/reconcile";

// Phase B2.3-b — the reconciliation sweep core. Layers:
//   (1) pure classifiers with the op+version STALE-JOB model + placeholder rules;
//   (2) orchestration against a FAITHFUL in-memory store (bump/orphan mimic the real
//       DB trigger + repair RPCs), a durable continuation store, injected clock, and
//       fake locks — proving convergence, stale-job generation, revalidation,
//       resumable pagination, mid-page renewal + deadline, and the outcome model.

const pending = (op: string, v: number | null): OpenJob => ({ opType: op, syncVersion: v, status: "pending" });
const dead = (op: string, v: number | null): OpenJob => ({ opType: op, syncVersion: v, status: "dead" });
const realLink = (over: Partial<ReconcileLinkRow> = {}): ReconcileLinkRow => ({
  id: "l1",
  honeEntityId: "a1",
  googleEventId: "ev",
  lastHoneVersion: 1,
  ...over,
});
const placeholderLink = (over: Partial<ReconcileLinkRow> = {}): ReconcileLinkRow => realLink({ googleEventId: null, ...over });

// ---------------------------------------------------------------------------
// Pure classifier — appointment pass (op+version stale model + placeholder).
// ---------------------------------------------------------------------------
describe("classifyConfirmedAppointment", () => {
  const appt = { id: "a1", syncVersion: 3 };

  it("no link, no jobs -> Class 1 create", () => {
    expect(classifyConfirmedAppointment(appt, undefined, [])).toEqual({ act: "bump", class: "missing_link_job", appointmentId: "a1" });
  });
  it("no link, a STALE pending create (older version) does NOT block -> bump", () => {
    expect(classifyConfirmedAppointment(appt, undefined, [pending("event.create", 1)])).toMatchObject({ act: "bump" });
  });
  it("no link, a current-or-newer create -> skip work_in_flight", () => {
    expect(classifyConfirmedAppointment(appt, undefined, [pending("event.create", 3)])).toEqual({ act: "skip", reason: "work_in_flight" });
    expect(classifyConfirmedAppointment(appt, undefined, [pending("event.create", 5)])).toEqual({ act: "skip", reason: "work_in_flight" });
  });
  it("placeholder link, no jobs -> re-drive create (NOT converged)", () => {
    expect(classifyConfirmedAppointment(appt, placeholderLink(), [])).toMatchObject({ act: "bump", class: "missing_link_job" });
  });
  it("placeholder link with a DEAD create -> manual review (no auto re-drive)", () => {
    expect(classifyConfirmedAppointment(appt, placeholderLink(), [dead("event.create", 1)])).toEqual({
      act: "skip",
      reason: "dead_create_manual_review",
    });
  });
  it("placeholder link with a current pending create -> work_in_flight", () => {
    expect(classifyConfirmedAppointment(appt, placeholderLink(), [pending("event.create", 3)])).toEqual({ act: "skip", reason: "work_in_flight" });
  });
  it("real link behind + no current job -> Class 3 update", () => {
    expect(classifyConfirmedAppointment(appt, realLink({ lastHoneVersion: 1 }), [])).toEqual({
      act: "bump",
      class: "link_version_behind",
      appointmentId: "a1",
    });
  });
  it("real link behind + STALE pending update (older) -> still bump", () => {
    expect(classifyConfirmedAppointment(appt, realLink({ lastHoneVersion: 1 }), [pending("event.update", 2)])).toMatchObject({ act: "bump" });
  });
  it("real link behind + current update -> work_in_flight", () => {
    expect(classifyConfirmedAppointment(appt, realLink({ lastHoneVersion: 1 }), [pending("event.update", 3)])).toEqual({ act: "skip", reason: "work_in_flight" });
  });
  it("real link caught up -> converged", () => {
    expect(classifyConfirmedAppointment(appt, realLink({ lastHoneVersion: 3 }), [])).toEqual({ act: "skip", reason: "converged" });
  });
});

// ---------------------------------------------------------------------------
// Pure classifier — link pass.
// ---------------------------------------------------------------------------
describe("classifyActiveLink", () => {
  const appt = (over: Partial<ReconcileApptState> = {}): ReconcileApptState => ({
    id: "a1",
    status: "confirmed",
    syncVersion: 2,
    cancellationKind: null,
    ...over,
  });

  it("appt gone + real event -> orphan delete", () => {
    expect(classifyActiveLink(realLink(), undefined, [])).toEqual({ act: "orphan_delete", class: "orphaned_link_delete", linkId: "l1" });
  });
  it("appt gone + placeholder -> inert", () => {
    expect(classifyActiveLink(placeholderLink(), undefined, [])).toEqual({ act: "skip", reason: "inert_placeholder" });
  });
  it("withdrawn cancel + real link + no current delete -> Class 4 delete", () => {
    expect(classifyActiveLink(realLink(), appt({ status: "cancelled", cancellationKind: "withdrawn" }), [])).toEqual({
      act: "bump",
      class: "surplus_event_delete",
      appointmentId: "a1",
    });
  });
  it("withdrawn cancel + PLACEHOLDER link -> inert (no remote delete without provider coords)", () => {
    expect(classifyActiveLink(placeholderLink(), appt({ status: "cancelled", cancellationKind: "withdrawn" }), [])).toEqual({
      act: "skip",
      reason: "inert_placeholder",
    });
  });
  it("rescheduled cancel -> keep_event (successor rebinds)", () => {
    expect(classifyActiveLink(realLink(), appt({ status: "cancelled", cancellationKind: "rescheduled" }), [])).toEqual({ act: "skip", reason: "keep_event" });
  });
  it("withdrawn cancel + current delete -> work_in_flight; STALE delete -> still bump", () => {
    expect(classifyActiveLink(realLink(), appt({ status: "cancelled", cancellationKind: "withdrawn" }), [pending("event.delete", 2)])).toEqual({
      act: "skip",
      reason: "work_in_flight",
    });
    expect(classifyActiveLink(realLink(), appt({ status: "cancelled", cancellationKind: "withdrawn" }), [pending("event.delete", 1)])).toMatchObject({ act: "bump" });
  });
  it("confirmed -> handled by appointment pass; completed/no_show -> keep_event", () => {
    expect(classifyActiveLink(realLink(), appt({ status: "confirmed" }), [])).toEqual({ act: "skip", reason: "handled_by_appointment_pass" });
    for (const s of ["completed", "no_show"]) {
      expect(classifyActiveLink(realLink(), appt({ status: s }), [])).toEqual({ act: "skip", reason: "keep_event" });
    }
  });
});

// ---------------------------------------------------------------------------
// Faithful in-memory store + continuation + locks.
// ---------------------------------------------------------------------------
type Appt = { id: string; studioId: string; status: string; syncVersion: number; cancellationKind: string | null; endsAt: string; createdAt: string };
type Link = { id: string; studioId: string; honeEntityId: string; googleEventId: string | null; lastHoneVersion: number; deletedAt: string | null };
type Job = { studioId: string; honeEntityId: string | null; opType: string; syncVersion: number | null; status: "pending" | "processing" | "dead"; googleEventId?: string | null };

const FUTURE = new Date(Date.UTC(2030, 0, 1)).toISOString();
const PAST = new Date(Date.UTC(2020, 0, 1)).toISOString();
const BASE = Date.UTC(2026, 6, 14, 12, 0, 0);

class FakeStore implements ReconcileStore {
  studios = new Map<string, { flag: boolean; owner: boolean; writeCalendar: string | null }>();
  appts = new Map<string, Appt>();
  links = new Map<string, Link>();
  jobs: Job[] = [];
  bumpCalls: string[] = [];
  orphanCalls: string[] = [];
  private linkSeq = 0;

  seedStudio(id: string, eligible = true) {
    this.studios.set(id, { flag: eligible, owner: eligible, writeCalendar: eligible ? "primary" : null });
  }
  seedAppt(a: Partial<Appt> & { id: string; studioId: string }) {
    this.appts.set(a.id, { status: "confirmed", syncVersion: 1, cancellationKind: null, endsAt: FUTURE, createdAt: PAST, ...a });
  }
  seedLink(l: Partial<Link> & { id: string; studioId: string; honeEntityId: string }) {
    this.links.set(l.id, { googleEventId: "ev", lastHoneVersion: 1, deletedAt: null, ...l });
  }
  seedJob(j: Partial<Job> & { studioId: string; honeEntityId: string | null; opType: string; syncVersion: number | null }) {
    this.jobs.push({ status: "pending", ...j });
  }
  private activeLink(studioId: string, entityId: string): Link | undefined {
    for (const l of this.links.values()) if (l.studioId === studioId && l.honeEntityId === entityId && l.deletedAt === null) return l;
    return undefined;
  }
  private eligible(studioId: string): boolean {
    const s = this.studios.get(studioId);
    return Boolean(s && s.flag && s.owner && s.writeCalendar);
  }

  async listEligibleStudioIds() {
    return [...this.studios.keys()].filter((id) => this.eligible(id));
  }
  async pageConfirmedFutureAppointments(studioId: string, activationIso: string, snapshotIso: string, afterId: string | null, limit: number) {
    return [...this.appts.values()]
      .filter((a) => a.studioId === studioId && a.status === "confirmed" && a.endsAt >= activationIso && a.createdAt <= snapshotIso && (afterId === null || a.id > afterId))
      .sort((x, y) => (x.id < y.id ? -1 : 1))
      .slice(0, limit)
      .map((a) => ({ id: a.id, syncVersion: a.syncVersion }));
  }
  async pageActiveAppointmentLinks(studioId: string, afterId: string | null, limit: number) {
    return [...this.links.values()]
      .filter((l) => l.studioId === studioId && l.deletedAt === null && (afterId === null || l.id > afterId))
      .sort((x, y) => (x.id < y.id ? -1 : 1))
      .slice(0, limit)
      .map((l) => ({ id: l.id, honeEntityId: l.honeEntityId, googleEventId: l.googleEventId, lastHoneVersion: l.lastHoneVersion }));
  }
  async getActiveLinksForEntities(studioId: string, ids: string[]) {
    const m = new Map<string, ReconcileLinkRow>();
    for (const id of ids) {
      const l = this.activeLink(studioId, id);
      if (l) m.set(id, { id: l.id, honeEntityId: l.honeEntityId, googleEventId: l.googleEventId, lastHoneVersion: l.lastHoneVersion });
    }
    return m;
  }
  async getActiveLinkById(studioId: string, linkId: string) {
    const l = this.links.get(linkId);
    if (!l || l.studioId !== studioId || l.deletedAt !== null) return null;
    return { id: l.id, honeEntityId: l.honeEntityId, googleEventId: l.googleEventId, lastHoneVersion: l.lastHoneVersion };
  }
  async getAppointmentStates(studioId: string, ids: string[]) {
    const m = new Map<string, ReconcileApptState>();
    for (const id of ids) {
      const a = this.appts.get(id);
      if (a && a.studioId === studioId) m.set(id, { id: a.id, status: a.status, syncVersion: a.syncVersion, cancellationKind: a.cancellationKind });
    }
    return m;
  }
  async getOpenJobsForEntities(studioId: string, ids: string[]) {
    const m = new Map<string, OpenJob[]>();
    for (const j of this.jobs) {
      if (j.studioId !== studioId || !j.honeEntityId || !ids.includes(j.honeEntityId)) continue;
      const arr = m.get(j.honeEntityId) ?? [];
      arr.push({ opType: j.opType, syncVersion: j.syncVersion, status: j.status });
      m.set(j.honeEntityId, arr);
    }
    return m;
  }
  async bumpAppointmentSyncVersion(apptId: string) {
    this.bumpCalls.push(apptId);
    const a = this.appts.get(apptId);
    if (!a) return null;
    a.syncVersion += 1;
    if (this.eligible(a.studioId)) {
      if (a.status === "confirmed") {
        const link = this.activeLink(a.studioId, apptId);
        if (!link) {
          this.links.set(`L${this.linkSeq++}`, { id: `L${this.linkSeq}`, studioId: a.studioId, honeEntityId: apptId, googleEventId: null, lastHoneVersion: a.syncVersion, deletedAt: null });
          this.seedJob({ studioId: a.studioId, honeEntityId: apptId, opType: "event.create", syncVersion: a.syncVersion });
        } else {
          this.seedJob({ studioId: a.studioId, honeEntityId: apptId, opType: "event.update", syncVersion: a.syncVersion });
        }
      } else if (a.status === "cancelled" && a.cancellationKind !== "rescheduled") {
        const link = this.activeLink(a.studioId, apptId);
        if (link && link.googleEventId !== null) this.seedJob({ studioId: a.studioId, honeEntityId: apptId, opType: "event.delete", syncVersion: a.syncVersion });
      }
    }
    return a.syncVersion;
  }
  async enqueueOrphanLinkDelete(linkId: string) {
    this.orphanCalls.push(linkId);
    const l = this.links.get(linkId);
    if (!l || l.deletedAt !== null || l.googleEventId === null) return "no_active_link";
    const inFlight = this.jobs.some((j) => j.opType === "event.delete" && (j.status === "pending" || j.status === "processing") && j.googleEventId === l.googleEventId);
    if (inFlight) return "delete_in_flight";
    this.seedJob({ studioId: l.studioId, honeEntityId: null, opType: "event.delete", syncVersion: null, googleEventId: l.googleEventId });
    return "uuid";
  }
  async listStudiosWithDeadOutbox() {
    const counts = new Map<string, number>();
    for (const j of this.jobs) if (j.status === "dead") counts.set(j.studioId, (counts.get(j.studioId) ?? 0) + 1);
    return [...counts.entries()].map(([studioId, deadCount]) => ({ studioId, deadCount }));
  }
}

class FakeContinuation implements ReconcileContinuationStore {
  map = new Map<string, ReconcileContinuation>();
  readError = false;
  writeError = false;
  async read(studioId: string) {
    if (this.readError) return { ok: false as const };
    return { ok: true as const, value: this.map.get(studioId) ?? null };
  }
  async write(studioId: string, v: ReconcileContinuation) {
    if (this.writeError) return false;
    this.map.set(studioId, v);
    return true;
  }
  async clear(studioId: string) {
    this.map.delete(studioId);
    return true;
  }
}

const lockAlways = (): ReconcileLock => ({ acquire: async () => ({ ok: true, token: "t" }), release: async () => {}, renew: async () => true });
const lockHeld = (): ReconcileLock => ({ acquire: async () => ({ ok: false, reason: "held" }), release: async () => {} });
const lockUnavailable = (): ReconcileLock => ({ acquire: async () => ({ ok: false, reason: "unavailable" }), release: async () => {} });

function deps(store: FakeStore, over: Partial<Parameters<typeof runReconciliation>[0]> = {}) {
  return { store, lock: lockAlways(), continuation: new FakeContinuation(), now: () => BASE, ...over };
}

// ---------------------------------------------------------------------------
// §2 stale-open-job — an older job never blocks generating current intent.
// ---------------------------------------------------------------------------
describe("§2 stale open jobs", () => {
  it("pending create v1, appointment now v3 -> generates exactly one newer op; repeat is a no-op", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", syncVersion: 3 });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: null, lastHoneVersion: 1 }); // placeholder from create v1
    s.seedJob({ studioId: "st", honeEntityId: "a1", opType: "event.create", syncVersion: 1 }); // STALE pending create
    const c = new FakeContinuation();
    const r1 = await runReconciliation(deps(s, { continuation: c }));
    expect(r1.enqueued).toBe(1); // one newer op generated
    expect(s.bumpCalls).toEqual(["a1"]);
    const r2 = await runReconciliation(deps(s, { continuation: c }));
    expect(r2.enqueued).toBe(0); // now a current job exists -> skip
  });

  it("pending create v1, appointment becomes withdrawn-cancelled -> no remote op, safe no-event state", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", status: "cancelled", cancellationKind: "withdrawn", syncVersion: 2 });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: null }); // placeholder (no event ever created)
    s.seedJob({ studioId: "st", honeEntityId: "a1", opType: "event.create", syncVersion: 1 }); // stale create
    const r = await runReconciliation(deps(s));
    expect(r.enqueued).toBe(0); // placeholder cancel -> inert, no delete enqueued
    expect(s.bumpCalls).toEqual([]);
  });

  it("processing OLDER job + newer appointment version -> generates current, does not falsely converge", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", syncVersion: 4 });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: "ev", lastHoneVersion: 1 });
    s.jobs.push({ studioId: "st", honeEntityId: "a1", opType: "event.update", syncVersion: 1, status: "processing" });
    const r = await runReconciliation(deps(s));
    expect(r.enqueued).toBe(1);
    expect(s.bumpCalls).toEqual(["a1"]);
  });

  it("current matching open job -> no-op", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", syncVersion: 4 });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: "ev", lastHoneVersion: 1 });
    s.seedJob({ studioId: "st", honeEntityId: "a1", opType: "event.update", syncVersion: 4 });
    const r = await runReconciliation(deps(s));
    expect(r.enqueued).toBe(0);
    expect(s.bumpCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §3 placeholder semantics (orchestration).
// ---------------------------------------------------------------------------
describe("§3 placeholder link handling", () => {
  it("confirmed placeholder + no job -> re-drive; +dead create -> manual review (no bump)", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: null });
    expect((await runReconciliation(deps(s))).enqueued).toBe(1); // re-drive
    // Now with a dead create + placeholder, a fresh store:
    const s2 = new FakeStore();
    s2.seedStudio("st");
    s2.seedAppt({ id: "a1", studioId: "st" });
    s2.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: null });
    s2.jobs.push({ studioId: "st", honeEntityId: "a1", opType: "event.create", syncVersion: 1, status: "dead" });
    expect(s2.bumpCalls).toEqual([]);
    await runReconciliation(deps(s2));
    expect(s2.bumpCalls).toEqual([]); // dead create -> manual review, no auto re-drive
  });
});

// ---------------------------------------------------------------------------
// §4 resumable continuation.
// ---------------------------------------------------------------------------
describe("§4 resumable continuation", () => {
  it("a data set larger than one page ceiling is covered exactly once across invocations", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    for (let i = 1; i <= 5; i++) s.seedAppt({ id: `a${i}`, studioId: "st" });
    const c = new FakeContinuation();
    const cfg = { continuation: c, pageSize: 2, maxPagesPerStudioPerPass: 1 }; // ceiling = 2 per invocation
    let guard = 0;
    // Run until the continuation clears (studio fully drained).
    while (c.map.size > 0 || guard === 0) {
      await runReconciliation(deps(s, cfg));
      if (++guard > 20) throw new Error("did not converge");
    }
    // Every appointment got exactly one create (no skips, no duplicates).
    for (let i = 1; i <= 5; i++) {
      expect(s.jobs.filter((j) => j.honeEntityId === `a${i}` && j.opType === "event.create")).toHaveLength(1);
    }
  });

  it("continuation READ failure -> studio not swept (fail-closed, degraded)", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const c = new FakeContinuation();
    c.readError = true;
    const r = await runReconciliation(deps(s, { continuation: c }));
    expect(s.bumpCalls).toEqual([]); // never swept
    expect(r.studiosContinuationFailed).toBe(1);
    expect(r.outcome).toBe("degraded");
  });

  it("continuation WRITE failure on truncation -> degraded, not reported complete", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    for (let i = 1; i <= 3; i++) s.seedAppt({ id: `a${i}`, studioId: "st" });
    const c = new FakeContinuation();
    c.writeError = true;
    const r = await runReconciliation(deps(s, { continuation: c, pageSize: 1, maxPagesPerStudioPerPass: 1 }));
    expect(r.studiosCompleted).toBe(0);
    expect(r.outcome).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// §5 mid-page lock renewal + deadline (injected clock).
// ---------------------------------------------------------------------------
describe("§5 lock renewal + deadline", () => {
  it("renews between pages once the interval elapses", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    for (let i = 1; i <= 4; i++) s.seedAppt({ id: `a${i}`, studioId: "st" });
    let clock = BASE;
    const renew = vi.fn(async () => true);
    const lock: ReconcileLock = { acquire: async () => ({ ok: true, token: "t" }), release: async () => {}, renew };
    // advance the clock 60s each time now() is read so the 40s interval always trips
    const now = () => (clock += 60_000);
    await reconcileStudio("st", { store: s, lock, continuation: new FakeContinuation(), now, pageSize: 1, lockRenewIntervalMs: 40_000 }, new Date(BASE).toISOString());
    expect(renew).toHaveBeenCalled();
  });

  it("a failed renewal stops further mutation, persists a continuation, and is degraded", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    for (let i = 1; i <= 4; i++) s.seedAppt({ id: `a${i}`, studioId: "st" });
    let clock = BASE;
    const now = () => (clock += 60_000); // always past the renew interval
    const lock: ReconcileLock = { acquire: async () => ({ ok: true, token: "t" }), release: async () => {}, renew: async () => false };
    const c = new FakeContinuation();
    const res = await reconcileStudio("st", { store: s, lock, continuation: c, now, pageSize: 1, lockRenewIntervalMs: 40_000 }, new Date(BASE).toISOString());
    expect(res.ownershipLost).toBe(true);
    expect(res.outcome).toBe("degraded");
    expect(c.map.has("st")).toBe(true); // continuation persisted for the remainder
    // It stopped early — not all 4 appointments were bumped.
    expect(s.bumpCalls.length).toBeLessThan(4);
  });

  it("a deadline reached mid-run truncates + persists a continuation", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    for (let i = 1; i <= 5; i++) s.seedAppt({ id: `a${i}`, studioId: "st" });
    const c = new FakeContinuation();
    const res = await reconcileStudio(
      "st",
      { store: s, lock: lockAlways(), continuation: c, now: () => BASE, deadlineMs: BASE - 1 /* already past */ },
      new Date(BASE).toISOString(),
    );
    expect(res.truncated).toBe(true);
    expect(res.deadlineHit).toBe(true);
    expect(s.bumpCalls).toEqual([]); // nothing actuated after the deadline
    expect(c.map.has("st")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6 full pre-actuation revalidation.
// ---------------------------------------------------------------------------
describe("§6 pre-actuation revalidation", () => {
  it("a current job appearing between classification and actuation cancels the bump", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", syncVersion: 2 });
    // Wrap getOpenJobsForEntities: empty at classify (1st call), populated at revalidation.
    const real = s.getOpenJobsForEntities.bind(s);
    let calls = 0;
    s.getOpenJobsForEntities = async (studioId, ids) => {
      calls++;
      if (calls >= 2) return new Map([["a1", [pending("event.create", 2)]]]);
      return real(studioId, ids);
    };
    const r = await runReconciliation(deps(s));
    expect(s.bumpCalls).toEqual([]);
    expect(r.superseded).toBeGreaterThanOrEqual(1);
  });

  it("orphan delete is cancelled when the link was rebound to a live appointment", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "gone", googleEventId: "ev" }); // orphan at classify
    // Between classify and actuate, the link is rebound to a LIVE appointment.
    const realById = s.getActiveLinkById.bind(s);
    s.getActiveLinkById = async (studioId, linkId) => {
      s.seedAppt({ id: "gone", studioId: "st" }); // the entity now resolves to a live appt
      return realById(studioId, linkId);
    };
    await runReconciliation(deps(s));
    // Revalidation re-classified the rebound link as non-orphan, so the delete RPC
    // was NEVER invoked.
    expect(s.orphanCalls).toEqual([]);
    expect(s.jobs.filter((j) => j.opType === "event.delete")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §7 outcome model + lock behavior + dormancy.
// ---------------------------------------------------------------------------
describe("§7 outcome + lock", () => {
  it("clean full run -> ok", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    expect((await runReconciliation(deps(s))).outcome).toBe("ok");
  });

  it("lock HELD -> skipped (benign), run stays ok; UNAVAILABLE -> degraded", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const held = await runReconciliation(deps(s, { lock: lockHeld() }));
    expect(held.studiosSkippedHeld).toBe(1);
    expect(held.outcome).toBe("ok");
    expect(s.bumpCalls).toEqual([]);
    const unavail = await runReconciliation(deps(s, { lock: lockUnavailable() }));
    expect(unavail.studiosSkippedUnavailable).toBe(1);
    expect(unavail.outcome).toBe("degraded");
  });

  it("truncated studio -> degraded run outcome", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    for (let i = 1; i <= 3; i++) s.seedAppt({ id: `a${i}`, studioId: "st" });
    const r = await runReconciliation(deps(s, { pageSize: 1, maxPagesPerStudioPerPass: 1 }));
    expect(r.studiosTruncated).toBe(1);
    expect(r.outcome).toBe("degraded");
  });

  it("intent-off studio is never eligible / swept", async () => {
    const s = new FakeStore();
    s.seedStudio("st", false);
    s.seedAppt({ id: "a1", studioId: "st" });
    const acquire = vi.fn(async () => ({ ok: true, token: "t" }) as const);
    const r = await runReconciliation(deps(s, { lock: { acquire, release: async () => {}, renew: async () => true } }));
    expect(r.eligibleStudios).toBe(0);
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe("reconcileStudio result shape", () => {
  it("reports locked + cursor + outcome", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const res: StudioReconcileResult = await reconcileStudio("st", deps(s), new Date(BASE).toISOString());
    expect(res.locked).toBe(true);
    expect(res.enqueued).toBe(1);
    expect(res.appointmentCursor).toBe("a1");
    expect(res.outcome).toBe("ok");
  });
});
