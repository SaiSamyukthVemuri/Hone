import { describe, expect, it } from "vitest";
import {
  loadForCandidate,
  sameSlotCandidate,
  type SlotCandidateIdentity,
} from "@/lib/booking/slot-request";

// THE ASYNC-STATE RACE, driven deterministically with deferred promises.
//
// A capacity-enabled owner is on DATE A with a slot load in flight. They change
// to DATE B, which clears state and starts an eligibility refresh -- but the
// DATE-A request is still outstanding. If it resolves first and is allowed to
// commit, the form shows DATE B while holding DATE-A availability facts, and an
// ordinary time on B can be classified against A's window, acknowledged, and
// persisted as a false outside-availability exception.

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ID = (
  date: string,
  targetPractitionerId = "prac-A",
  serviceId = "svc-1",
): SlotCandidateIdentity => ({ serviceId, date, targetPractitionerId });

const A = ID("2026-08-20");
const B = ID("2026-08-21");

describe("sameSlotCandidate", () => {
  it("is true only for an identical identity", () => {
    expect(sameSlotCandidate(A, ID("2026-08-20"))).toBe(true);
    expect(sameSlotCandidate(A, B)).toBe(false);
    expect(sameSlotCandidate(A, ID("2026-08-20", "prac-B"))).toBe(false);
    expect(sameSlotCandidate(A, ID("2026-08-20", "prac-A", "svc-2"))).toBe(false);
  });

  it("a missing identity never matches", () => {
    expect(sameSlotCandidate(A, null)).toBe(false);
    expect(sameSlotCandidate(null, A)).toBe(false);
  });
});

describe("CASE A — an old DATE-A response after a change to DATE B", () => {
  it("is discarded, even though NOTHING NEWER was ever issued", async () => {
    // This is the interleaving a generation counter cannot see: the DATE-B
    // eligibility refresh has not started its own slot load yet, so the DATE-A
    // request is still the newest promise in flight. Only the identity has
    // moved on.
    const gate = deferred<string>();
    let current: SlotCandidateIdentity = A;

    const pending = loadForCandidate<string>({
      generation: 1,
      isCurrentGeneration: () => true, // deliberately still "current"
      captured: A,
      readCurrentIdentity: () => current,
      fetch: () => gate.promise,
    });

    current = B; // the owner changed the date
    gate.resolve("DATE-A window + slots");

    const d = await pending;
    expect(d.kind).toBe("discard");
    expect(d.kind === "discard" && d.reason).toBe("identity_changed");
  });

  it("a bumped generation ALSO discards it", async () => {
    const gate = deferred<string>();
    let gen = 1;
    const pending = loadForCandidate<string>({
      generation: 1,
      isCurrentGeneration: (g) => g === gen,
      captured: A,
      readCurrentIdentity: () => A,
      fetch: () => gate.promise,
    });
    gen = 2;
    gate.resolve("stale");
    const d = await pending;
    expect(d.kind === "discard" && d.reason).toBe("superseded");
  });
});

describe("CASE B — an old response after an explicit TARGET change", () => {
  it("cannot install target A's slots once target B is selected", async () => {
    const gate = deferred<string>();
    let current = ID("2026-08-20", "prac-A");
    const pending = loadForCandidate<string>({
      generation: 1,
      isCurrentGeneration: () => true,
      captured: ID("2026-08-20", "prac-A"),
      readCurrentIdentity: () => current,
      fetch: () => gate.promise,
    });
    current = ID("2026-08-20", "prac-B"); // explicit switch
    gate.resolve("target A slots");
    const d = await pending;
    expect(d.kind === "discard" && d.reason).toBe("identity_changed");
  });
});

describe("CASE C — a current result installs normally", () => {
  it("commits when the identity is unchanged and the generation is current", async () => {
    const gate = deferred<string>();
    const pending = loadForCandidate<string>({
      generation: 3,
      isCurrentGeneration: (g) => g === 3,
      captured: A,
      readCurrentIdentity: () => ID("2026-08-20"),
      fetch: () => gate.promise,
    });
    gate.resolve("DATE-A truth");
    const d = await pending;
    expect(d.kind).toBe("commit");
    expect(d.kind === "commit" && d.result).toBe("DATE-A truth");
  });
});

describe("CASE D — DATE B resolves after the stale A response was rejected", () => {
  it("installs normally", async () => {
    const gateA = deferred<string>();
    const gateB = deferred<string>();
    let current: SlotCandidateIdentity = A;
    let gen = 1;

    const pendingA = loadForCandidate<string>({
      generation: 1,
      isCurrentGeneration: (g) => g === gen,
      captured: A,
      readCurrentIdentity: () => current,
      fetch: () => gateA.promise,
    });

    // Date changes: identity moves and the generation is invalidated.
    current = B;
    gen = 2;
    const pendingB = loadForCandidate<string>({
      generation: 2,
      isCurrentGeneration: (g) => g === gen,
      captured: B,
      readCurrentIdentity: () => current,
      fetch: () => gateB.promise,
    });

    gateA.resolve("A");
    expect((await pendingA).kind).toBe("discard");

    gateB.resolve("B");
    const dB = await pendingB;
    expect(dB.kind).toBe("commit");
    expect(dB.kind === "commit" && dB.result).toBe("B");
  });
});

describe("the identity is exactly the availability inputs", () => {
  it("does not include the client — slots and windows do not vary by client", () => {
    // Adding dimensions that cannot change the answer would cause needless
    // refetch churn. The buffer EXCEPTION is client-scoped, but that is a
    // separate identity (bookingCandidateKey).
    const keys = Object.keys(A).sort();
    expect(keys).toEqual(["date", "serviceId", "targetPractitionerId"]);
  });
});
