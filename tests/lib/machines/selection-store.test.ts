import { describe, expect, it } from "vitest";

import {
  DATABASE_PERSISTENCE,
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

describe("database, test-store and degraded are three distinguishable states", () => {
  // These three were two before the storage migration landed. The point is
  // unchanged: a double must never render as a real column, and a failure must
  // never render as a kept choice.
  it("the DATABASE capability is the only one that claims a real column", () => {
    expect(DATABASE_PERSISTENCE.persisted).toBe(true);
    expect(DATABASE_PERSISTENCE.kind).toBe("database");
  });

  it("the degraded capability says nothing persists, and why", () => {
    expect(NO_PERSISTENCE.persisted).toBe(false);
    expect(NO_PERSISTENCE.kind).toBe("none");
    // It is now reported for a FAILED read or an unauthenticated caller, not
    // because the column is missing - so the wording must not blame the schema.
    expect(NO_PERSISTENCE.reason).toMatch(/lasts for\s+this form only/i);
    expect(NO_PERSISTENCE.reason).not.toMatch(/does not exist/i);
  });

  it("the test capability is labelled as a test store, not as a database", () => {
    expect(TEST_STORE_PERSISTENCE.kind).toBe("test-store");
    expect(TEST_STORE_PERSISTENCE.reason).toMatch(/not a database/i);
  });

  it("every kind is distinct, so the UI can never conflate them", () => {
    const kinds = [NO_PERSISTENCE, DATABASE_PERSISTENCE, TEST_STORE_PERSISTENCE].map(
      (c) => c.kind,
    );
    expect(new Set(kinds).size).toBe(3);
  });
});

describe("the device inventory distinguishes empty from unreadable", () => {
  /** A client whose read succeeds and returns no rows. */
  const emptyDb = {
    rpc: async () => ({ data: null, error: null }),
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({ order: async () => ({ data: [], error: null }) }),
          order: () => ({ limit: async () => ({ data: [], error: null }) }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof listStudioDevices>[0];

  /** A client whose read FAILS. Emptiness here means nothing about the studio. */
  const brokenDb = {
    rpc: async () => ({ data: null, error: { message: "boom" } }),
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            order: async () => ({ data: null, error: { message: "boom" } }),
          }),
          order: () => ({
            limit: async () => ({ data: null, error: { message: "boom" } }),
          }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof listStudioDevices>[0];

  it("a studio with nothing registered says so, and is NOT 'unreadable'", async () => {
    const inv = await listStudioDevices(emptyDb, "studio-A");
    expect(inv.devices).toEqual([]);
    expect(inv.source).toBe("empty-for-studio");
    expect(inventoryUnavailable(inv)).toBe(false);
    expect(inv.reason).toMatch(/no machine registered yet/i);
  });

  it("a FAILED read warns against adding a duplicate", async () => {
    // The distinction that matters: an empty picker after a failed read would
    // invite a second registration of a machine that already exists.
    const inv = await listStudioDevices(brokenDb, "studio-A");
    expect(inv.devices).toEqual([]);
    expect(inv.source).toBe("unreadable");
    expect(inventoryUnavailable(inv)).toBe(true);
    expect(inv.reason).toMatch(/do not add a\s+duplicate/i);
  });

  it("writes down what has to exist, without encoding a migration number", () => {
    expect(INVENTORY_SOURCE.table).toBe("public.studio_machines");
    expect(INVENTORY_SOURCE.columns).toContain("machine_profile_version");
    // A number here would be a reservation this lane has not been granted.
    expect(JSON.stringify(INVENTORY_SOURCE)).not.toMatch(/\b02\d\d\b/);
    expect(INVENTORY_SOURCE.note).toMatch(/never here/i);
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
