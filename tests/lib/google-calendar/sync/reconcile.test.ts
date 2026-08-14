import { describe, expect, it } from "vitest";
import {
  classifyActiveLink,
  classifyConfirmedAppointment,
  reconcileStudio,
  rotateAfter,
  runReconciliation,
  type OpenJob,
  type ReconcileApptState,
  type ReconcileContinuation,
  type ReconcileContinuationStore,
  type ReconcileCoordinator,
  type ReconcileLinkRow,
  type ReconcileLock,
  type ReconcileStore,
} from "@/lib/google-calendar/sync/reconcile";

// Phase B2.3-b: reconciliation sweep core (round-3 corrections).

const pending = (op: string, v: number | null): OpenJob => ({ opType: op, syncVersion: v, status: "pending" });
const dead = (op: string, v: number | null): OpenJob => ({ opType: op, syncVersion: v, status: "dead" });
const realLink = (o: Partial<ReconcileLinkRow> = {}): ReconcileLinkRow => ({ id: "l1", honeEntityId: "a1", googleEventId: "ev", lastHoneVersion: 1, ...o });
const placeholderLink = (o: Partial<ReconcileLinkRow> = {}): ReconcileLinkRow => realLink({ googleEventId: null, ...o });

// ---------------------------------------------------------------------------
// Pure classifiers (op+version stale model + placeholder).
// ---------------------------------------------------------------------------
describe("classifyConfirmedAppointment", () => {
  const appt = { id: "a1", syncVersion: 3 };
  it("no link, no jobs -> create", () => {
    expect(classifyConfirmedAppointment(appt, undefined, [])).toEqual({ act: "bump", class: "missing_link_job", appointmentId: "a1" });
  });
  it("stale create does not block; current-or-newer create -> work_in_flight", () => {
    expect(classifyConfirmedAppointment(appt, undefined, [pending("event.create", 1)])).toMatchObject({ act: "bump" });
    expect(classifyConfirmedAppointment(appt, undefined, [pending("event.create", 3)])).toEqual({ act: "skip", reason: "work_in_flight" });
  });
  it("placeholder + no job -> re-drive upsert intent; + dead create -> manual review", () => {
    expect(classifyConfirmedAppointment(appt, placeholderLink(), [])).toMatchObject({ act: "bump", class: "missing_link_job" });
    expect(classifyConfirmedAppointment(appt, placeholderLink(), [dead("event.create", 1)])).toEqual({ act: "skip", reason: "dead_create_manual_review" });
  });
  it("real link behind -> update; caught up -> converged", () => {
    expect(classifyConfirmedAppointment(appt, realLink({ lastHoneVersion: 1 }), [])).toEqual({ act: "bump", class: "link_version_behind", appointmentId: "a1" });
    expect(classifyConfirmedAppointment(appt, realLink({ lastHoneVersion: 3 }), [])).toEqual({ act: "skip", reason: "converged" });
  });
});

describe("classifyActiveLink", () => {
  const appt = (o: Partial<ReconcileApptState> = {}): ReconcileApptState => ({ id: "a1", status: "confirmed", syncVersion: 2, cancellationKind: null, ...o });
  it("appt gone + real -> orphan; + placeholder -> inert", () => {
    expect(classifyActiveLink(realLink(), undefined, [])).toEqual({ act: "orphan_delete", class: "orphaned_link_delete", linkId: "l1" });
    expect(classifyActiveLink(placeholderLink(), undefined, [])).toEqual({ act: "skip", reason: "inert_placeholder" });
  });
  it("withdrawn cancel: real -> delete, placeholder -> inert, rescheduled -> keep", () => {
    expect(classifyActiveLink(realLink(), appt({ status: "cancelled", cancellationKind: "withdrawn" }), [])).toEqual({ act: "bump", class: "surplus_event_delete", appointmentId: "a1" });
    expect(classifyActiveLink(placeholderLink(), appt({ status: "cancelled", cancellationKind: "withdrawn" }), [])).toEqual({ act: "skip", reason: "inert_placeholder" });
    expect(classifyActiveLink(realLink(), appt({ status: "cancelled", cancellationKind: "rescheduled" }), [])).toEqual({ act: "skip", reason: "keep_event" });
  });
});

describe("rotateAfter (wrap-around studio ordering)", () => {
  it("null cursor -> unchanged; after a cursor -> starts after it, wrapping", () => {
    expect(rotateAfter(["a", "b", "c"], null)).toEqual(["a", "b", "c"]);
    expect(rotateAfter(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
    expect(rotateAfter(["a", "b", "c"], "c")).toEqual(["a", "b", "c"]); // cursor >= all -> wrap to start
    expect(rotateAfter(["a", "b", "c"], "b")).toEqual(["c", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Faithful in-memory seams.
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
  async isStudioIntentEligible(studioId: string) {
    return this.eligible(studioId);
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
          this.jobs.push({ studioId: a.studioId, honeEntityId: apptId, opType: "event.create", syncVersion: a.syncVersion, status: "pending" });
        } else {
          this.jobs.push({ studioId: a.studioId, honeEntityId: apptId, opType: "event.update", syncVersion: a.syncVersion, status: "pending" });
        }
      } else if (a.status === "cancelled" && a.cancellationKind !== "rescheduled") {
        const link = this.activeLink(a.studioId, apptId);
        if (link && link.googleEventId !== null) this.jobs.push({ studioId: a.studioId, honeEntityId: apptId, opType: "event.delete", syncVersion: a.syncVersion, status: "pending" });
      }
    }
    return a.syncVersion;
  }
  async enqueueOrphanLinkDelete(linkId: string) {
    this.orphanCalls.push(linkId);
    const l = this.links.get(linkId);
    if (!l || l.deletedAt !== null || l.googleEventId === null) return "no_active_link";
    if (this.jobs.some((j) => j.opType === "event.delete" && (j.status === "pending" || j.status === "processing") && j.googleEventId === l.googleEventId)) return "delete_in_flight";
    this.jobs.push({ studioId: l.studioId, honeEntityId: null, opType: "event.delete", syncVersion: null, googleEventId: l.googleEventId, status: "pending" });
    return "uuid";
  }
  async pageStudiosWithDeadOutbox(after: string | null, limit: number) {
    const counts = new Map<string, number>();
    for (const j of this.jobs) if (j.status === "dead") counts.set(j.studioId, (counts.get(j.studioId) ?? 0) + 1);
    return [...counts.entries()]
      .map(([studioId, deadCount]) => ({ studioId, deadCount }))
      .filter((x) => (after === null || x.studioId > after))
      .sort((a, b) => (a.studioId < b.studioId ? -1 : 1))
      .slice(0, limit);
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
  async write(studioId: string, _token: string, v: ReconcileContinuation) {
    if (this.writeError) return false;
    this.map.set(studioId, v);
    return true;
  }
  async clear(studioId: string, _token: string) {
    this.map.delete(studioId);
    return true;
  }
}

class FakeCoordinator implements ReconcileCoordinator {
  private held = false;
  private ownerToken: string | null = null;
  cursor: string | null = null;
  acquireResult: "ok" | "held" | "unavailable" = "ok";
  private seq = 0;
  async acquire() {
    if (this.acquireResult !== "ok") return { ok: false as const, reason: this.acquireResult };
    if (this.held) return { ok: false as const, reason: "held" as const };
    this.held = true;
    this.ownerToken = `c-${this.seq++}`;
    return { ok: true as const, token: this.ownerToken };
  }
  async release(token: string) {
    if (this.ownerToken === token) {
      this.held = false;
      this.ownerToken = null;
    }
  }
  async renew(token: string) {
    return this.ownerToken === token;
  }
  async readCursor() {
    return { ok: true as const, cursor: this.cursor };
  }
  async writeCursor(token: string, cursor: string | null) {
    if (this.ownerToken !== token) return false;
    this.cursor = cursor;
    return true;
  }
}

const lockAlways = (): ReconcileLock => ({ acquire: async () => ({ ok: true, token: "t" }), release: async () => {}, renew: async () => true });

function deps(store: FakeStore, over: Partial<Parameters<typeof runReconciliation>[0]> = {}) {
  return { store, lock: lockAlways(), coordinator: new FakeCoordinator(), continuation: new FakeContinuation(), now: () => BASE, ...over };
}

// ---------------------------------------------------------------------------
// §2, cross-studio anti-starvation (global cursor + coordinator).
// ---------------------------------------------------------------------------
describe("§2 cross-studio anti-starvation", () => {
  it("every eligible studio eventually gets a turn without restarting from the first", async () => {
    const s = new FakeStore();
    for (const id of ["s1", "s2", "s3"]) {
      s.seedStudio(id);
      s.seedAppt({ id: `a-${id}`, studioId: id });
    }
    const coord = new FakeCoordinator();
    const cont = new FakeContinuation();
    const attempted: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runReconciliation(deps(s, { coordinator: coord, continuation: cont, studioBatchLimit: 1 }));
      attempted.push(...r.results.map((x) => x.studioId));
      expect(r.studiosDeferred).toBe(2);
      expect(r.outcome).toBe("degraded"); // deferred work is reported truthfully
    }
    expect(attempted).toEqual(["s1", "s2", "s3"]); // in order, each once, never restarted at s1
    for (const id of ["s1", "s2", "s3"]) expect(s.jobs.some((j) => j.honeEntityId === `a-${id}` && j.opType === "event.create")).toBe(true);
  });

  it("coordinator HELD -> benign skip (ok); UNAVAILABLE -> degraded; no work either way", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const held = new FakeCoordinator();
    held.acquireResult = "held";
    const rHeld = await runReconciliation(deps(s, { coordinator: held }));
    expect(rHeld.coordinatorSkipped).toBe("held");
    expect(rHeld.outcome).toBe("ok");
    expect(s.bumpCalls).toEqual([]);
    const un = new FakeCoordinator();
    un.acquireResult = "unavailable";
    const rUn = await runReconciliation(deps(s, { coordinator: un }));
    expect(rUn.coordinatorSkipped).toBe("unavailable");
    expect(rUn.outcome).toBe("degraded");
    expect(s.bumpCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2 stale open jobs.
// ---------------------------------------------------------------------------
describe("§2 stale open jobs", () => {
  it("stale create v1 + appt v3 -> generates one newer op; repeat no-op", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", syncVersion: 3 });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: null, lastHoneVersion: 1 });
    s.jobs.push({ studioId: "st", honeEntityId: "a1", opType: "event.create", syncVersion: 1, status: "pending" });
    const c = new FakeContinuation();
    const co = new FakeCoordinator();
    expect((await runReconciliation(deps(s, { continuation: c, coordinator: co }))).enqueued).toBe(1);
    expect((await runReconciliation(deps(s, { continuation: c, coordinator: co }))).enqueued).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4, forced ownership check immediately before the actuator.
// ---------------------------------------------------------------------------
describe("§4 pre-actuator ownership", () => {
  it("ownership lost at the forced pre-actuator check -> no bump, cursor before the item, degraded", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    // A huge renew interval means the page/per-item ensureOwned() never renew (return
    // true); only the FORCED ensureOwnedNow() before the RPC renews, and it fails.
    const lock: ReconcileLock = { acquire: async () => ({ ok: true, token: "t" }), release: async () => {}, renew: async () => false };
    const cont = new FakeContinuation();
    const res = await reconcileStudio(
      "st",
      { store: s, lock, coordinator: new FakeCoordinator(), continuation: cont, now: () => BASE, lockRenewIntervalMs: 10_000_000 },
      new Date(BASE).toISOString(),
    );
    expect(s.bumpCalls).toEqual([]); // actuator never reached
    expect(res.ownershipLost).toBe(true);
    expect(res.outcome).toBe("degraded");
    expect(cont.map.get("st")?.cursor).toBeNull(); // cursor stayed BEFORE a1
  });
});

// ---------------------------------------------------------------------------
// §6, post-bump intent verification + pre-mutation intent recheck.
// ---------------------------------------------------------------------------
describe("§6 intent verification", () => {
  it("bump returns but no matching op appears -> intentVerifyFailed, not enqueued, degraded", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    // Sabotage the trigger enqueue: bump increments but creates NO outbox job.
    s.bumpAppointmentSyncVersion = async (id: string) => {
      s.bumpCalls.push(id);
      const a = s.appts.get(id);
      if (!a) return null;
      a.syncVersion += 1;
      return a.syncVersion;
    };
    const r = await runReconciliation(deps(s));
    expect(s.bumpCalls).toEqual(["a1"]);
    expect(r.enqueued).toBe(0);
    expect(r.intentVerifyFailed).toBe(1);
    expect(r.outcome).toBe("degraded");
  });

  it("intent-eligibility lost before mutation -> intent_lost, no bump, continuation persisted, degraded", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    s.isStudioIntentEligible = async () => false;
    const cont = new FakeContinuation();
    const res = await reconcileStudio("st", deps(s, { continuation: cont }), new Date(BASE).toISOString());
    expect(s.bumpCalls).toEqual([]);
    expect(res.intentLost).toBe(true);
    expect(res.outcome).toBe("degraded");
    expect(cont.map.has("st")).toBe(true);
  });

  it("normal bump -> exactly one matching current op, enqueued 1", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const r = await runReconciliation(deps(s));
    expect(r.enqueued).toBe(1);
    expect(r.intentVerifyFailed).toBe(0);
    expect(s.jobs.filter((j) => j.honeEntityId === "a1" && j.opType === "event.create")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §3 placeholder handling.
// ---------------------------------------------------------------------------
describe("§3 placeholder handling", () => {
  it("confirmed placeholder + no job -> re-drive; + dead -> manual review (no bump)", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: null });
    expect((await runReconciliation(deps(s))).enqueued).toBe(1);
    const s2 = new FakeStore();
    s2.seedStudio("st");
    s2.seedAppt({ id: "a1", studioId: "st" });
    s2.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: null });
    s2.jobs.push({ studioId: "st", honeEntityId: "a1", opType: "event.create", syncVersion: 1, status: "dead" });
    await runReconciliation(deps(s2));
    expect(s2.bumpCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §4/§5 continuation + deadline (retained).
// ---------------------------------------------------------------------------
describe("continuation + deadline", () => {
  it("multi-invocation coverage exactly once across a shared continuation", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    for (let i = 1; i <= 5; i++) s.seedAppt({ id: `a${i}`, studioId: "st" });
    const c = new FakeContinuation();
    const co = new FakeCoordinator();
    let guard = 0;
    while (c.map.size > 0 || guard === 0) {
      await runReconciliation(deps(s, { continuation: c, coordinator: co, pageSize: 2, maxPagesPerStudioPerPass: 1 }));
      if (++guard > 20) throw new Error("did not converge");
    }
    for (let i = 1; i <= 5; i++) expect(s.jobs.filter((j) => j.honeEntityId === `a${i}` && j.opType === "event.create")).toHaveLength(1);
  });

  it("continuation READ failure -> not swept, degraded", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const c = new FakeContinuation();
    c.readError = true;
    const r = await runReconciliation(deps(s, { continuation: c }));
    expect(s.bumpCalls).toEqual([]);
    expect(r.studiosContinuationFailed).toBe(1);
    expect(r.outcome).toBe("degraded");
  });

  it("deadline reached mid-run -> truncated + continuation persisted", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    for (let i = 1; i <= 5; i++) s.seedAppt({ id: `a${i}`, studioId: "st" });
    const c = new FakeContinuation();
    const res = await reconcileStudio("st", { store: s, lock: lockAlways(), coordinator: new FakeCoordinator(), continuation: c, now: () => BASE, deadlineMs: BASE - 1 }, new Date(BASE).toISOString());
    expect(res.truncated).toBe(true);
    expect(res.deadlineHit).toBe(true);
    expect(s.bumpCalls).toEqual([]);
    expect(c.map.has("st")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6 revalidation (retained).
// ---------------------------------------------------------------------------
describe("pre-actuation revalidation", () => {
  it("orphan delete cancelled when the link was rebound to a live appointment", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "gone", googleEventId: "ev" });
    const realById = s.getActiveLinkById.bind(s);
    s.getActiveLinkById = async (studioId, linkId) => {
      s.seedAppt({ id: "gone", studioId: "st" });
      return realById(studioId, linkId);
    };
    await runReconciliation(deps(s));
    expect(s.orphanCalls).toEqual([]);
    expect(s.jobs.filter((j) => j.opType === "event.delete")).toHaveLength(0);
  });
});

describe("dormancy", () => {
  it("intent-off studio is never eligible / swept", async () => {
    const s = new FakeStore();
    s.seedStudio("st", false);
    s.seedAppt({ id: "a1", studioId: "st" });
    const r = await runReconciliation(deps(s));
    expect(r.eligibleStudios).toBe(0);
    expect(r.outcome).toBe("ok");
    expect(s.bumpCalls).toEqual([]);
  });
});
