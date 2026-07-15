import { describe, expect, it, vi } from "vitest";
import {
  classifyActiveLink,
  classifyConfirmedAppointment,
  reconcileStudio,
  runReconciliation,
  type ReconcileApptState,
  type ReconcileLinkRow,
  type ReconcileLock,
  type ReconcileStore,
} from "@/lib/google-calendar/sync/reconcile";

// Phase B2.3-b — the reconciliation sweep core. Two layers:
//   (1) the pure classifiers (the four-class decision logic), and
//   (2) the orchestration against a FAITHFUL in-memory store whose bump()/orphan
//       actuators mimic the real DB trigger + repair RPCs (create/update/delete
//       intent, link creation, idempotent orphan delete). The REAL DB behavior is
//       proven separately in tests/db/google-calendar-b2-3b-reconcile.db.test.ts;
//       here we prove convergence, no-duplicate on repeat, the supersede guard,
//       revalidation, and fail-closed / lock-held handling deterministically.

// ---------------------------------------------------------------------------
// Pure classifiers.
// ---------------------------------------------------------------------------
describe("classifyConfirmedAppointment (appointment pass)", () => {
  const appt = { id: "a1", syncVersion: 3 };
  const link = (v: number): ReconcileLinkRow => ({ id: "l1", honeEntityId: "a1", googleEventId: "ev", lastHoneVersion: v });

  it("no link + no job -> Class 1 bump (create)", () => {
    expect(classifyConfirmedAppointment(appt, undefined, false)).toEqual({
      act: "bump",
      class: "missing_link_job",
      appointmentId: "a1",
    });
  });
  it("link behind + no job -> Class 3 bump (update)", () => {
    expect(classifyConfirmedAppointment(appt, link(1), false)).toEqual({
      act: "bump",
      class: "link_version_behind",
      appointmentId: "a1",
    });
  });
  it("link current -> skip converged", () => {
    expect(classifyConfirmedAppointment(appt, link(3), false)).toEqual({ act: "skip", reason: "converged" });
  });
  it("open job present -> skip work_in_flight (supersede-safe), even with no link", () => {
    expect(classifyConfirmedAppointment(appt, undefined, true)).toEqual({ act: "skip", reason: "work_in_flight" });
    expect(classifyConfirmedAppointment(appt, link(1), true)).toEqual({ act: "skip", reason: "work_in_flight" });
  });
});

describe("classifyActiveLink (link pass)", () => {
  const link = (over: Partial<ReconcileLinkRow> = {}): ReconcileLinkRow => ({
    id: "l1",
    honeEntityId: "a1",
    googleEventId: "ev",
    lastHoneVersion: 1,
    ...over,
  });
  const appt = (over: Partial<ReconcileApptState> = {}): ReconcileApptState => ({
    id: "a1",
    status: "confirmed",
    syncVersion: 1,
    cancellationKind: null,
    ...over,
  });

  it("appointment gone + real event -> Class 2 orphan delete", () => {
    expect(classifyActiveLink(link(), undefined, false)).toEqual({
      act: "orphan_delete",
      class: "orphaned_link_delete",
      linkId: "l1",
    });
  });
  it("appointment gone + placeholder (no google_event_id) -> skip inert (no remote event)", () => {
    expect(classifyActiveLink(link({ googleEventId: null }), undefined, false)).toEqual({
      act: "skip",
      reason: "inert_placeholder",
    });
  });
  it("cancelled withdrawn + no job -> Class 4 bump (delete via trigger)", () => {
    expect(classifyActiveLink(link(), appt({ status: "cancelled", cancellationKind: "withdrawn" }), false)).toEqual({
      act: "bump",
      class: "surplus_event_delete",
      appointmentId: "a1",
    });
  });
  it("cancelled RESCHEDULED -> skip keep_event (successor rebinds; delete suppressed)", () => {
    expect(classifyActiveLink(link(), appt({ status: "cancelled", cancellationKind: "rescheduled" }), false)).toEqual({
      act: "skip",
      reason: "keep_event",
    });
  });
  it("cancelled withdrawn + open job -> skip work_in_flight", () => {
    expect(classifyActiveLink(link(), appt({ status: "cancelled", cancellationKind: "withdrawn" }), true)).toEqual({
      act: "skip",
      reason: "work_in_flight",
    });
  });
  it("confirmed link -> skip (handled by appointment pass)", () => {
    expect(classifyActiveLink(link(), appt({ status: "confirmed" }), false)).toEqual({
      act: "skip",
      reason: "handled_by_appointment_pass",
    });
  });
  it("completed / no_show -> skip keep_event (historical block remains)", () => {
    for (const status of ["completed", "no_show"]) {
      expect(classifyActiveLink(link(), appt({ status }), false)).toEqual({ act: "skip", reason: "keep_event" });
    }
  });
});

// ---------------------------------------------------------------------------
// Faithful in-memory store + fake locks.
// ---------------------------------------------------------------------------
type Appt = { id: string; studioId: string; status: string; syncVersion: number; cancellationKind: string | null; endsAt: string; createdAt: string };
type Link = { id: string; studioId: string; honeEntityId: string; googleEventId: string | null; lastHoneVersion: number; deletedAt: string | null };
type Job = { studioId: string; honeEntityId: string | null; status: string; opType: string; googleEventId?: string | null; key: string };

const FUTURE = new Date(Date.UTC(2030, 0, 1)).toISOString();
const PAST = new Date(Date.UTC(2020, 0, 1)).toISOString();
const NOW = () => Date.UTC(2026, 6, 14, 12, 0, 0);

class FakeStore implements ReconcileStore {
  studios = new Map<string, { flag: boolean; owner: boolean; writeCalendar: string | null }>();
  appts = new Map<string, Appt>();
  links = new Map<string, Link>();
  jobs: Job[] = [];
  bumpCalls: string[] = [];
  orphanCalls: string[] = [];
  private linkSeq = 0;
  // Override the open-jobs read to appear empty on the first call and populated
  // afterwards — used to prove the immediately-before-bump revalidation.
  openJobsOverride?: (ids: string[], nth: number) => Set<string>;
  private openJobsCalls = 0;

  seedStudio(id: string, opts: { eligible?: boolean } = {}) {
    const eligible = opts.eligible ?? true;
    this.studios.set(id, { flag: eligible, owner: eligible, writeCalendar: eligible ? "primary" : null });
  }
  seedAppt(a: Partial<Appt> & { id: string; studioId: string }) {
    this.appts.set(a.id, {
      status: "confirmed",
      syncVersion: 1,
      cancellationKind: null,
      endsAt: FUTURE,
      createdAt: PAST,
      ...a,
    });
  }
  seedLink(l: Partial<Link> & { id: string; studioId: string; honeEntityId: string }) {
    this.links.set(l.id, { googleEventId: "ev", lastHoneVersion: 1, deletedAt: null, ...l });
  }
  seedJob(j: Partial<Job> & { studioId: string; honeEntityId: string | null }) {
    this.jobs.push({ status: "pending", opType: "event.create", key: `k-${this.jobs.length}`, ...j });
  }
  private activeLink(studioId: string, entityId: string): Link | undefined {
    for (const l of this.links.values()) {
      if (l.studioId === studioId && l.honeEntityId === entityId && l.deletedAt === null) return l;
    }
    return undefined;
  }
  private isEligible(studioId: string): boolean {
    const s = this.studios.get(studioId);
    return Boolean(s && s.flag && s.owner && s.writeCalendar);
  }

  async listEligibleStudioIds() {
    return [...this.studios.keys()].filter((id) => this.isEligible(id));
  }
  async pageConfirmedFutureAppointments(studioId: string, activationIso: string, snapshotIso: string, afterId: string | null, limit: number) {
    return [...this.appts.values()]
      .filter(
        (a) =>
          a.studioId === studioId &&
          a.status === "confirmed" &&
          a.endsAt >= activationIso &&
          a.createdAt <= snapshotIso &&
          (afterId === null || a.id > afterId),
      )
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
  async getAppointmentStates(studioId: string, ids: string[]) {
    const m = new Map<string, ReconcileApptState>();
    for (const id of ids) {
      const a = this.appts.get(id);
      if (a && a.studioId === studioId) m.set(id, { id: a.id, status: a.status, syncVersion: a.syncVersion, cancellationKind: a.cancellationKind });
    }
    return m;
  }
  async getEntitiesWithOpenJobs(studioId: string, ids: string[]) {
    const nth = this.openJobsCalls++;
    if (this.openJobsOverride) return this.openJobsOverride(ids, nth);
    const set = new Set<string>();
    for (const j of this.jobs) {
      if (j.studioId === studioId && j.honeEntityId && ids.includes(j.honeEntityId) && (j.status === "pending" || j.status === "processing")) {
        set.add(j.honeEntityId);
      }
    }
    return set;
  }

  // Faithful actuator: mimics repair_bump_appointment_sync_version + the enqueue trigger.
  async bumpAppointmentSyncVersion(apptId: string) {
    this.bumpCalls.push(apptId);
    const a = this.appts.get(apptId);
    if (!a) return null;
    a.syncVersion += 1;
    if (this.isEligible(a.studioId)) {
      if (a.status === "confirmed") {
        let link = this.activeLink(a.studioId, apptId);
        if (!link) {
          link = { id: `L${this.linkSeq++}`, studioId: a.studioId, honeEntityId: apptId, googleEventId: null, lastHoneVersion: a.syncVersion, deletedAt: null };
          this.links.set(link.id, link);
          this.seedJob({ studioId: a.studioId, honeEntityId: apptId, status: "pending", opType: "event.create", key: `appointment:${apptId}:event.create:${a.syncVersion}` });
        } else {
          this.seedJob({ studioId: a.studioId, honeEntityId: apptId, status: "pending", opType: "event.update", key: `appointment:${apptId}:event.update:${a.syncVersion}` });
        }
      } else if (a.status === "cancelled" && a.cancellationKind !== "rescheduled") {
        if (this.activeLink(a.studioId, apptId)) {
          this.seedJob({ studioId: a.studioId, honeEntityId: apptId, status: "pending", opType: "event.delete", key: `appointment:${apptId}:event.delete:${a.syncVersion}` });
        }
      }
    }
    return a.syncVersion;
  }
  // Faithful actuator: mimics repair_enqueue_orphan_link_delete (idempotent).
  async enqueueOrphanLinkDelete(linkId: string) {
    this.orphanCalls.push(linkId);
    const l = this.links.get(linkId);
    if (!l || l.deletedAt !== null || l.googleEventId === null) return "no_active_link";
    const inFlight = this.jobs.some((j) => j.opType === "event.delete" && (j.status === "pending" || j.status === "processing") && j.googleEventId === l.googleEventId);
    if (inFlight) return "delete_in_flight";
    this.seedJob({ studioId: l.studioId, honeEntityId: null, status: "pending", opType: "event.delete", googleEventId: l.googleEventId, key: `orphan:${linkId}` });
    return "uuid-generated";
  }
}

const lockAlways = (): ReconcileLock => ({
  acquire: vi.fn(async () => ({ ok: true, token: "t" }) as const),
  release: vi.fn(async () => {}),
  renew: vi.fn(async () => true),
});
const lockHeld = (): ReconcileLock => ({ acquire: async () => ({ ok: false, reason: "held" }), release: async () => {} });
const lockUnavailable = (): ReconcileLock => ({ acquire: async () => ({ ok: false, reason: "unavailable" }), release: async () => {} });
function lockSingleSlot(): ReconcileLock {
  const held = new Map<string, string>();
  let seq = 0;
  return {
    async acquire(studioId) {
      if (held.has(studioId)) return { ok: false, reason: "held" };
      const token = `tok-${seq++}`;
      held.set(studioId, token);
      return { ok: true, token };
    },
    async release(studioId, token) {
      if (held.get(studioId) === token) held.delete(studioId);
    },
  };
}

const deps = (store: FakeStore, lock: ReconcileLock) => ({ store, lock, now: NOW });

// ---------------------------------------------------------------------------
// Orchestration behavior.
// ---------------------------------------------------------------------------
describe("Class 1 — intent-off window: missing link+job converges to one create", () => {
  it("first sweep bumps once (create); second sweep is a no-op", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" }); // confirmed future, NO link, NO job (post-intent-off state)

    const r1 = await runReconciliation(deps(s, lockAlways()));
    expect(s.bumpCalls).toEqual(["a1"]);
    expect(r1.enqueued).toBe(1);
    expect(r1.byClass.missing_link_job).toBe(1);
    // A link + a pending create job now exist.
    expect([...s.links.values()].some((l) => l.honeEntityId === "a1")).toBe(true);
    expect(s.jobs.filter((j) => j.honeEntityId === "a1" && j.opType === "event.create")).toHaveLength(1);

    const r2 = await runReconciliation(deps(s, lockAlways()));
    expect(s.bumpCalls).toEqual(["a1"]); // NOT bumped again
    expect(r2.enqueued).toBe(0);
  });
});

describe("Class 3 — link version behind converges to one update; repeat is a no-op", () => {
  it("bumps to enqueue an update; the pending job blocks a second bump (no version inflation)", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", syncVersion: 5 });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: "ev", lastHoneVersion: 3 });

    await runReconciliation(deps(s, lockAlways()));
    expect(s.bumpCalls).toEqual(["a1"]);
    expect(s.jobs.filter((j) => j.opType === "event.update")).toHaveLength(1);

    await runReconciliation(deps(s, lockAlways())); // open job present -> skip
    expect(s.bumpCalls).toEqual(["a1"]);
  });
});

describe("multi-mutation collapse: many prior changes -> exactly one op at the current version", () => {
  it("a far-behind link produces a single bump, not one per missed version", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", syncVersion: 10 });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", lastHoneVersion: 2 });
    await runReconciliation(deps(s, lockAlways()));
    expect(s.bumpCalls).toEqual(["a1"]);
  });
});

describe("Class 2 — orphaned link (appointment gone)", () => {
  it("real event -> one orphan delete; repeat is delete_in_flight (no dup)", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "gone-appt", googleEventId: "ev-1" }); // no appointment row
    const r1 = await runReconciliation(deps(s, lockAlways()));
    expect(s.orphanCalls).toEqual(["l1"]);
    expect(r1.byClass.orphaned_link_delete).toBe(1);
    expect(s.jobs.filter((j) => j.opType === "event.delete")).toHaveLength(1);

    const r2 = await runReconciliation(deps(s, lockAlways()));
    expect(r2.enqueued).toBe(0); // delete_in_flight -> skip
  });

  it("placeholder link (no google_event_id) -> inert, no orphan delete", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "gone", googleEventId: null });
    const r = await runReconciliation(deps(s, lockAlways()));
    expect(s.orphanCalls).toEqual([]);
    expect(r.enqueued).toBe(0);
  });
});

describe("Class 4 — withdrawn cancellation with a live link converges to one delete", () => {
  it("bumps to enqueue a delete; rescheduled/ completed are left alone", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", status: "cancelled", cancellationKind: "withdrawn" });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", googleEventId: "ev" });
    // rescheduled predecessor (delete suppressed) + completed (event kept)
    s.seedAppt({ id: "a2", studioId: "st", status: "cancelled", cancellationKind: "rescheduled" });
    s.seedLink({ id: "l2", studioId: "st", honeEntityId: "a2", googleEventId: "ev2" });
    s.seedAppt({ id: "a3", studioId: "st", status: "completed" });
    s.seedLink({ id: "l3", studioId: "st", honeEntityId: "a3", googleEventId: "ev3" });

    const r = await runReconciliation(deps(s, lockAlways()));
    expect(s.bumpCalls).toEqual(["a1"]); // only the withdrawn one
    expect(r.byClass.surplus_event_delete).toBe(1);
    expect(s.jobs.filter((j) => j.opType === "event.delete" && j.honeEntityId === "a1")).toHaveLength(1);
  });
});

describe("supersede / revalidation guards", () => {
  it("a pending job present at classify time -> skip (superseded), never bumped", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st", syncVersion: 5 });
    s.seedLink({ id: "l1", studioId: "st", honeEntityId: "a1", lastHoneVersion: 3 });
    s.seedJob({ studioId: "st", honeEntityId: "a1", status: "pending", opType: "event.update" });
    const r = await runReconciliation(deps(s, lockAlways()));
    expect(s.bumpCalls).toEqual([]);
    expect(r.superseded).toBeGreaterThanOrEqual(1);
  });

  it("revalidation: a job appearing AFTER classification cancels the bump", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" }); // Class 1 candidate
    // Appear empty during the page classification (nth 0), populated during the
    // immediately-before-bump revalidation (nth >= 1).
    s.openJobsOverride = (_ids, nth) => (nth === 0 ? new Set() : new Set(["a1"]));
    const r = await runReconciliation(deps(s, lockAlways()));
    expect(s.bumpCalls).toEqual([]); // revalidation saw the job -> no bump
    expect(r.superseded).toBeGreaterThanOrEqual(1);
  });
});

describe("lock behavior (fail-closed)", () => {
  it("lock HELD -> studio skipped, no reads/bumps", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const r = await runReconciliation(deps(s, lockHeld()));
    expect(s.bumpCalls).toEqual([]);
    expect(r.studiosSkippedHeld).toBe(1);
    expect(r.studiosSwept).toBe(0);
  });

  it("lock UNAVAILABLE -> studio skipped (never swept unlocked)", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const r = await runReconciliation(deps(s, lockUnavailable()));
    expect(s.bumpCalls).toEqual([]);
    expect(r.studiosSkippedUnavailable).toBe(1);
  });

  it("concurrent sweeps under a single-slot lock: exactly one bump (no duplicate)", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const lock = lockSingleSlot();
    await Promise.all([runReconciliation(deps(s, lock)), runReconciliation(deps(s, lock))]);
    // Either the second run was locked out, or it ran after the first converged
    // the appointment — either way, exactly one create bump.
    expect(s.bumpCalls).toEqual(["a1"]);
  });
});

describe("dormancy: ineligible studios are never swept", () => {
  it("an intent-OFF studio yields no eligible studios and no work", async () => {
    const s = new FakeStore();
    s.seedStudio("st", { eligible: false });
    s.seedAppt({ id: "a1", studioId: "st" });
    const acquire = vi.fn(async () => ({ ok: true, token: "t" }) as const);
    const r = await runReconciliation(deps(s, { acquire, release: async () => {}, renew: async () => true }));
    expect(r.eligibleStudios).toBe(0);
    expect(acquire).not.toHaveBeenCalled(); // never even attempts a lock
    expect(s.bumpCalls).toEqual([]);
  });
});

describe("reconcileStudio result shape", () => {
  it("reports locked + cursors + aggregate counts", async () => {
    const s = new FakeStore();
    s.seedStudio("st");
    s.seedAppt({ id: "a1", studioId: "st" });
    const res = await reconcileStudio("st", deps(s, lockAlways()), new Date(NOW()).toISOString());
    expect(res.locked).toBe(true);
    expect(res.enqueued).toBe(1);
    expect(res.appointmentCursor).toBe("a1");
  });
});
