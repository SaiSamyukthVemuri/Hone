import { describe, expect, it } from "vitest";

import {
  NO_PERSISTENCE,
  PersistenceUnavailableError,
  ScopeMismatchError,
  TEST_STORE_PERSISTENCE,
  createMemoryStore,
  createUnavailableStore,
  createVerifyingStore,
} from "@/lib/machines/selection-store";
import {
  inventoryUnavailable,
  listStudioDevices,
  INVENTORY_SOURCE,
} from "@/lib/machines/studio-devices";
import { resolveSelection, selectionKey } from "@/lib/machines/selection";

// ===========================================================================
// MPX-03 — the remembered-selection adapter.
//
// Two separate claims are under test and they must not be confused with each
// other: that a scope the caller does not own is refused at the STORE boundary
// (not only at the action boundary), and that the difference between a real
// store and a test double is a value the UI can read rather than an assumption.
// ===========================================================================

const ALICE = { studioId: "studio-A", practitionerId: "alice" };
const BOB = { studioId: "studio-A", practitionerId: "bob" };
const ALICE_AT_B = { studioId: "studio-B", practitionerId: "alice" };

const asAlice = async () => ALICE;
const asNobody = async () => null;

describe("a scope the caller does not own is refused at the store boundary", () => {
  it("reads the caller's own selection", async () => {
    const inner = createMemoryStore();
    await inner.write(ALICE, { deviceId: "room-1", modeKey: null });
    const store = createVerifyingStore(asAlice, inner);
    expect(await store.read(ALICE)).toEqual({ deviceId: "room-1", modeKey: null });
  });

  it("returns NOTHING for another practitioner, leaking not even existence", async () => {
    const inner = createMemoryStore();
    await inner.write(BOB, { deviceId: "room-2", modeKey: null });
    const store = createVerifyingStore(asAlice, inner);
    // Null rather than an error: Alice asking about Bob is told nothing, which
    // does not reveal whether Bob has a selection at all.
    expect(await store.read(BOB)).toBeNull();
  });

  it("returns nothing for the same person in another studio", async () => {
    const inner = createMemoryStore();
    await inner.write(ALICE_AT_B, { deviceId: "b-1", modeKey: null });
    const store = createVerifyingStore(asAlice, inner);
    expect(await store.read(ALICE_AT_B)).toBeNull();
  });

  it("THROWS on a write to a scope the caller does not own", async () => {
    const inner = createMemoryStore();
    const store = createVerifyingStore(asAlice, inner);
    await expect(
      store.write(BOB, { deviceId: "room-2", modeKey: null }),
    ).rejects.toBeInstanceOf(ScopeMismatchError);
    // A silently dropped write would look like success, so nothing was stored.
    expect(inner.size()).toBe(0);
  });

  it("refuses both halves when there is no authenticated caller", async () => {
    const inner = createMemoryStore();
    await inner.write(ALICE, { deviceId: "room-1", modeKey: null });
    const store = createVerifyingStore(asNobody, inner);
    expect(await store.read(ALICE)).toBeNull();
    await expect(
      store.write(ALICE, { deviceId: "room-1", modeKey: null }),
    ).rejects.toBeInstanceOf(ScopeMismatchError);
  });

  it("compares through the real key, so both halves of the scope count", async () => {
    // If the comparison ever drops the studio, this is what catches it.
    expect(selectionKey(ALICE)).not.toBe(selectionKey(ALICE_AT_B));
    expect(selectionKey(ALICE)).not.toBe(selectionKey(BOB));
  });
});

describe("the real store refuses to pretend", () => {
  it("reads null, because there is nowhere a selection could have been stored", async () => {
    expect(await createUnavailableStore().read(ALICE)).toBeNull();
  });

  it("THROWS on write rather than no-op", async () => {
    // A no-op write would let the UI report a remembered choice that no later
    // request can find. That is the dishonesty this throw prevents.
    await expect(
      createUnavailableStore().write(ALICE, { deviceId: "x", modeKey: null }),
    ).rejects.toBeInstanceOf(PersistenceUnavailableError);
  });

  it("carries the practitioner-facing reason on the error", async () => {
    await expect(
      createUnavailableStore().write(ALICE, { deviceId: "x", modeKey: null }),
    ).rejects.toThrow(/lasts for this form only/i);
  });
});

describe("persisted behaviour and test-store behaviour are distinguishable", () => {
  it("the real capability says nothing persists, and why", () => {
    expect(NO_PERSISTENCE.persisted).toBe(false);
    expect(NO_PERSISTENCE.kind).toBe("none");
    expect(NO_PERSISTENCE.reason).toMatch(/does not exist in the database yet/i);
  });

  it("the test capability is labelled as a test store, not as a database", () => {
    expect(TEST_STORE_PERSISTENCE.kind).toBe("test-store");
    expect(TEST_STORE_PERSISTENCE.reason).toMatch(/not a database/i);
  });

  it("no capability claims a database today", () => {
    for (const cap of [NO_PERSISTENCE, TEST_STORE_PERSISTENCE]) {
      expect(cap.kind).not.toBe("database");
    }
  });
});

describe("the device inventory reports its own absence honestly", () => {
  it("returns no devices, and says the source does not exist", async () => {
    const inv = await listStudioDevices("studio-A");
    expect(inv.devices).toEqual([]);
    expect(inv.source).toBe("no-inventory-table");
    expect(inventoryUnavailable(inv)).toBe(true);
    expect(inv.reason).toMatch(/no machine inventory exists in the database yet/i);
  });

  it("distinguishes a missing source from a studio that registered nothing", () => {
    expect(inventoryUnavailable({ devices: [], source: "empty-for-studio", reason: "" })).toBe(
      false,
    );
  });

  it("writes down what has to exist, without encoding a migration number", () => {
    expect(INVENTORY_SOURCE.table).toBe("public.studio_machines");
    expect(INVENTORY_SOURCE.columns).toContain("machine_profile_version");
    // A number here would be a reservation this lane has not been granted.
    expect(JSON.stringify(INVENTORY_SOURCE)).not.toMatch(/\b02\d\d\b/);
    expect(INVENTORY_SOURCE.note).toMatch(/fresh\s+census/i);
  });
});

// ---------------------------------------------------------------------------
// Isolation and reload, proved against the TEST STORE and labelled as such.
// ---------------------------------------------------------------------------

describe("isolation and reload, through the verifying store (TEST STORE)", () => {
  // These exercise the semantics the database column will have to honour. They
  // are NOT evidence that anything persists today - `createUnavailableStore`
  // above is the real server behaviour, and it stores nothing.
  const forAlice = () => createVerifyingStore(asAlice, shared);
  let shared = createMemoryStore();

  it("a remembered choice survives repeated reads, as reload would", async () => {
    shared = createMemoryStore();
    await forAlice().write(ALICE, { deviceId: "room-1", modeKey: null });
    for (let i = 0; i < 3; i++) {
      expect(await forAlice().read(ALICE)).toEqual({
        deviceId: "room-1",
        modeKey: null,
      });
    }
  });

  it("two practitioners in one studio keep different machines", async () => {
    shared = createMemoryStore();
    await createVerifyingStore(asAlice, shared).write(ALICE, {
      deviceId: "room-1",
      modeKey: null,
    });
    await createVerifyingStore(async () => BOB, shared).write(BOB, {
      deviceId: "room-2",
      modeKey: null,
    });
    expect(await createVerifyingStore(asAlice, shared).read(ALICE)).toEqual({
      deviceId: "room-1",
      modeKey: null,
    });
    expect(await createVerifyingStore(async () => BOB, shared).read(BOB)).toEqual({
      deviceId: "room-2",
      modeKey: null,
    });
    expect(shared.keys().sort()).toEqual(["studio-A:alice", "studio-A:bob"]);
  });

  it("resolution through the real store yields nothing, so no machine is offered", async () => {
    // The end-to-end consequence on the server today: even a perfectly valid
    // scope resolves to "none", because the store has nothing and the catalogue
    // offers nothing.
    const resolved = await resolveSelection(ALICE, [], createUnavailableStore());
    expect(resolved).toEqual({ state: "none" });
  });
});
