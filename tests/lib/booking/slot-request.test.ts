import { describe, expect, it } from "vitest";
import {
  eligibleFetchIdentity,
  fetchForIdentity,
  slotFetchIdentity,
  type EligibleFetchInput,
  type SlotFetchInput,
} from "@/lib/booking/slot-request";

// THE ASYNC-AUTHORITY RACES, driven deterministically with deferred promises.
//
// Four repairs of these surfaces each fixed one stale value and left another,
// because the identity was hand-listed and the invalidation hand-maintained.
// The identity is now DERIVED from the request object, so a new input dimension
// joins it automatically.

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const REQ = (over: Partial<SlotFetchInput> = {}): SlotFetchInput => ({
  serviceId: "svc-1",
  date: "2026-08-20",
  practitionerId: "prac-A",
  capacityMode: true,
  ...over,
});

// Drive one race: start a fetch for `request`, mutate what is current, resolve.
async function race(request: SlotFetchInput, becomesCurrent: SlotFetchInput) {
  const gate = deferred<string>();
  let current = request;
  const pending = fetchForIdentity<SlotFetchInput, string>({
    request,
    identityOf: slotFetchIdentity,
    readCurrentRequest: () => current,
    fetch: () => gate.promise,
    // Deliberately still "current": these races must be caught by IDENTITY
    // alone, with no counter helping.
    generation: 1,
    isCurrentGeneration: () => true,
  });
  current = becomesCurrent;
  gate.resolve("stale payload");
  return pending;
}

describe("the identity is DERIVED from the request, so it cannot fall behind", () => {
  it("changing ANY input changes the identity", () => {
    const base = REQ();
    // Iterating the keys is what makes this future-proof: a dimension added to
    // SlotFetchInput is covered here without anyone editing this test.
    const mutations: Record<keyof SlotFetchInput, SlotFetchInput> = {
      serviceId: REQ({ serviceId: "svc-2" }),
      date: REQ({ date: "2026-08-21" }),
      practitionerId: REQ({ practitionerId: null }),
      capacityMode: REQ({ capacityMode: false }),
    };
    for (const key of Object.keys(base) as (keyof SlotFetchInput)[]) {
      expect(
        slotFetchIdentity(mutations[key]),
        `${String(key)} must participate in the identity`,
      ).not.toBe(slotFetchIdentity(base));
    }
  });

  it("every key of the request participates — no field can be forgotten", () => {
    // Guards the derivation itself: if identityOf ever stopped covering all
    // keys, some mutation above would silently stop changing the identity.
    const base = REQ();
    const seen = slotFetchIdentity(base);
    for (const key of Object.keys(base) as (keyof SlotFetchInput)[]) {
      expect(seen).toContain(`"${String(key)}"`);
    }
  });

  it("an identical request yields an identical identity", () => {
    expect(slotFetchIdentity(REQ())).toBe(slotFetchIdentity(REQ()));
  });

  it("DURATION is deliberately absent, and here is why", () => {
    // fetchSlotsForClientBookingAction's signature is
    // (serviceId, date, practitionerId): the server derives the appointment
    // length from the LOCKED service row, so serviceId already determines it.
    // Including it would force refetches that cannot change the answer. The
    // buffer EXCEPTION does depend on the interval, and is keyed separately by
    // bookingCandidateKey.
    expect(Object.keys(REQ()).sort()).toEqual([
      "capacityMode",
      "date",
      "practitionerId",
      "serviceId",
    ]);
  });
});

describe("A — an old DATE completion cannot install", () => {
  it("is discarded even though NOTHING newer was issued", async () => {
    const d = await race(REQ({ date: "2026-08-20" }), REQ({ date: "2026-08-21" }));
    expect(d.kind === "discard" && d.reason).toBe("identity_changed");
  });
});

describe("B — an old PRACTITIONER completion cannot install", () => {
  it("an explicit switch to P2 discards P1's result", async () => {
    const d = await race(
      REQ({ practitionerId: "prac-A" }),
      REQ({ practitionerId: "prac-B" }),
    );
    expect(d.kind === "discard" && d.reason).toBe("identity_changed");
  });
});

describe("C — an old SERVICE completion cannot install", () => {
  it("changing service discards the previous service's result", async () => {
    const d = await race(REQ({ serviceId: "svc-1" }), REQ({ serviceId: "svc-2" }));
    expect(d.kind === "discard" && d.reason).toBe("identity_changed");
  });
});

describe("D — CAPACITY MODE is part of the identity", () => {
  it("a capacity flip discards a result fetched under the other mode", async () => {
    // The dimension a hand-written identity missed: the argument list does not
    // change for a non-owner, but the server reads a different window source.
    const d = await race(REQ({ capacityMode: true }), REQ({ capacityMode: false }));
    expect(d.kind === "discard" && d.reason).toBe("identity_changed");
  });
});

describe("E — a still-current result installs normally", () => {
  it("commits when nothing moved", async () => {
    const gate = deferred<string>();
    const pending = fetchForIdentity<SlotFetchInput, string>({
      request: REQ(),
      identityOf: slotFetchIdentity,
      readCurrentRequest: () => REQ(),
      fetch: () => gate.promise,
      generation: 3,
      isCurrentGeneration: (g) => g === 3,
    });
    gate.resolve("fresh");
    const d = await pending;
    expect(d.kind).toBe("commit");
    expect(d.kind === "commit" && d.result).toBe("fresh");
  });

  it("...and the NEW request still commits after a stale one was rejected", async () => {
    const gateA = deferred<string>();
    const gateB = deferred<string>();
    let current = REQ({ date: "2026-08-21" });
    const stale = fetchForIdentity<SlotFetchInput, string>({
      request: REQ({ date: "2026-08-20" }),
      identityOf: slotFetchIdentity,
      readCurrentRequest: () => current,
      fetch: () => gateA.promise,
    });
    const fresh = fetchForIdentity<SlotFetchInput, string>({
      request: REQ({ date: "2026-08-21" }),
      identityOf: slotFetchIdentity,
      readCurrentRequest: () => current,
      fetch: () => gateB.promise,
    });
    gateA.resolve("A");
    gateB.resolve("B");
    expect((await stale).kind).toBe("discard");
    const f = await fresh;
    expect(f.kind === "commit" && f.result).toBe("B");
  });
});

describe("the generation counter is cancellation only, never the sole authority", () => {
  it("a bumped generation discards as superseded", async () => {
    const gate = deferred<string>();
    let gen = 1;
    const pending = fetchForIdentity<SlotFetchInput, string>({
      request: REQ(),
      identityOf: slotFetchIdentity,
      readCurrentRequest: () => REQ(),
      fetch: () => gate.promise,
      generation: 1,
      isCurrentGeneration: (g) => g === gen,
    });
    gen = 2;
    gate.resolve("x");
    const d = await pending;
    expect(d.kind === "discard" && d.reason).toBe("superseded");
  });

  it("with NO counter at all, identity still rejects a stale completion", async () => {
    const gate = deferred<string>();
    let current = REQ({ date: "2026-08-20" });
    const pending = fetchForIdentity<SlotFetchInput, string>({
      request: REQ({ date: "2026-08-20" }),
      identityOf: slotFetchIdentity,
      readCurrentRequest: () => current,
      fetch: () => gate.promise,
    });
    current = REQ({ date: "2026-08-21" });
    gate.resolve("stale");
    expect((await pending).kind).toBe("discard");
  });

  it("no current request at all never matches", async () => {
    const gate = deferred<string>();
    const pending = fetchForIdentity<SlotFetchInput, string>({
      request: REQ(),
      identityOf: slotFetchIdentity,
      readCurrentRequest: () => null,
      fetch: () => gate.promise,
    });
    gate.resolve("x");
    const d = await pending;
    expect(d.kind === "discard" && d.reason).toBe("identity_changed");
  });
});

describe("ELIGIBILITY has its own identity, separate from user selection", () => {
  const E = (over: Partial<EligibleFetchInput> = {}): EligibleFetchInput => ({
    serviceId: "svc-1",
    capacityMode: true,
    ...over,
  });

  it("depends on service and capacity mode, and NOT on the selected target", () => {
    // The eligible LIST is a property of the service. Which practitioner is
    // selected is USER STATE and must never be overwritten by an older result;
    // that rule lives in resolveEligibleSelection, which reads the target at
    // resolve time.
    expect(eligibleFetchIdentity(E())).toBe(eligibleFetchIdentity(E()));
    expect(eligibleFetchIdentity(E({ serviceId: "svc-2" }))).not.toBe(
      eligibleFetchIdentity(E()),
    );
    expect(eligibleFetchIdentity(E({ capacityMode: false }))).not.toBe(
      eligibleFetchIdentity(E()),
    );
    expect(Object.keys(E()).sort()).toEqual(["capacityMode", "serviceId"]);
  });

  it("an old-service eligibility completion cannot install", async () => {
    const gate = deferred<string>();
    let current = E({ serviceId: "svc-1" });
    const pending = fetchForIdentity<EligibleFetchInput, string>({
      request: E({ serviceId: "svc-1" }),
      identityOf: eligibleFetchIdentity,
      readCurrentRequest: () => current,
      fetch: () => gate.promise,
    });
    current = E({ serviceId: "svc-2" });
    gate.resolve("svc-1 list");
    expect((await pending).kind).toBe("discard");
  });
});
