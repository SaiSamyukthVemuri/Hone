/**
 * MPX-03 — the remembered-selection adapter, and what it can honestly claim.
 *
 * TWO SEPARATE THINGS LIVE HERE, and keeping them apart is the point.
 *
 * 1. `createVerifyingStore` wraps any store so that EVERY read and write is
 *    checked against the authenticated identity. A scope that does not match
 *    the caller's own practitioner and studio is refused. That is the
 *    "never trust a submitted ownership field" rule enforced at the storage
 *    boundary rather than only at the action boundary, so a future caller that
 *    forgets cannot reintroduce the hole. It mirrors 0178's
 *    `set_own_default_machine_frequency`, which resolves
 *    `own_practitioner_in_studio(p_studio_id)` and returns NULL for a
 *    non-member rather than trusting the studio it was handed.
 *
 * 2. `PersistenceCapability` makes WHERE a selection lives a value the UI can
 *    read, instead of an assumption. The database-backed store reports
 *    `kind: "database"`; an in-memory double used by tests reports
 *    `kind: "test-store"`; and `kind: "none"` is the DEGRADED state - no
 *    authenticated caller, or a read that failed. A panel backed by a double
 *    rendering the same "yes" a real column would is the dishonesty this type
 *    exists to prevent.
 */

import type {
  SelectionScope,
  SelectionStore,
  StoredSelection,
} from "./selection";
import { selectionKey } from "./selection";
import {
  readRememberedMachine,
  rememberMachine,
  type MachineDb,
} from "./machine-queries";

// ---------------------------------------------------------------------------

/** Where a remembered selection actually lives, and whether it survives. */
export type PersistenceCapability = {
  /** Does a choice outlive this request? */
  persisted: boolean;
  kind: "none" | "test-store" | "database";
  /** Practitioner-facing sentence when `persisted` is false. */
  reason: string;
};

/**
 * No persistence. Since 0223 this is the DEGRADED state rather than the normal
 * one: it is reported when there is no authenticated caller, or when the
 * remembered-machine read itself failed, so the UI never claims a choice is
 * kept when it is not.
 */
export const NO_PERSISTENCE: PersistenceCapability = {
  persisted: false,
  kind: "none",
  reason:
    "Your machine could not be remembered just now, so this choice lasts for " +
    "this form only.",
};

/**
 * The real capability once 0223 is applied: a remembered machine lives in
 * `practitioners.default_machine_id` and survives every later request.
 */
export const DATABASE_PERSISTENCE: PersistenceCapability = {
  persisted: true,
  kind: "database",
  reason: "",
};

/** What a test double reports. Never produced by server code. */
export const TEST_STORE_PERSISTENCE: PersistenceCapability = {
  persisted: true,
  kind: "test-store",
  reason: "In-memory store used by tests. Not a database.",
};

// ---------------------------------------------------------------------------

/** Resolves the caller's OWN identity. Server-side, from the session. */
export type IdentityResolver = () => Promise<SelectionScope | null>;

export class ScopeMismatchError extends Error {
  constructor() {
    super(
      "Refusing to read or write another practitioner's remembered machine.",
    );
    this.name = "ScopeMismatchError";
  }
}

export class PersistenceUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PersistenceUnavailableError";
  }
}

/**
 * Wrap a store so neither half can be reached for a scope the caller does not
 * own.
 *
 * A mismatched READ returns null rather than throwing: a caller asking about a
 * scope it does not own is told "nothing", which leaks nothing about whether
 * that other practitioner has a selection. A mismatched WRITE throws, because
 * silently dropping a write would look like success.
 */
export function createVerifyingStore(
  resolveIdentity: IdentityResolver,
  inner: SelectionStore,
): SelectionStore {
  const owns = async (scope: SelectionScope): Promise<boolean> => {
    const mine = await resolveIdentity();
    return mine != null && selectionKey(mine) === selectionKey(scope);
  };

  return {
    async read(scope) {
      return (await owns(scope)) ? inner.read(scope) : null;
    },
    async write(scope, selection) {
      if (!(await owns(scope))) throw new ScopeMismatchError();
      return inner.write(scope, selection);
    },
  };
}

/**
 * The DEGRADED store: reads nothing, refuses to pretend a write happened.
 *
 * Used when there is no authenticated caller. `write` throws rather than
 * no-opping, because a silent no-op would let the UI report a remembered
 * choice that no later request can find.
 */
export function createUnavailableStore(
  capability: PersistenceCapability = NO_PERSISTENCE,
): SelectionStore {
  return {
    async read() {
      return null;
    },
    async write() {
      throw new PersistenceUnavailableError(capability.reason);
    },
  };
}

/**
 * An in-memory store, keyed through the REAL `selectionKey` so isolation is
 * proved by production code rather than by the double's own habits. Exported
 * for tests; server code must never construct it.
 */
export function createMemoryStore(): SelectionStore & {
  keys: () => string[];
  size: () => number;
} {
  const rows = new Map<string, StoredSelection>();
  return {
    async read(scope) {
      return rows.get(selectionKey(scope)) ?? null;
    },
    async write(scope, selection) {
      if (selection === null) rows.delete(selectionKey(scope));
      else rows.set(selectionKey(scope), selection);
    },
    keys: () => [...rows.keys()],
    size: () => rows.size,
  };
}

/**
 * The REAL store, backed by 0223's `set_own_default_machine` command and the
 * practitioner's own row.
 *
 * Note what it does NOT do: it performs no ownership check of its own. The
 * command resolves the caller through `own_practitioner_in_studio` and returns
 * NULL for a non-member, so the authority is the database's. Wrapping this in
 * `createVerifyingStore` adds a second, earlier refusal - deliberate
 * repetition, so a future caller that forgets the scope check is still caught.
 *
 * A write the database declines (non-member) throws rather than resolving, so
 * the caller cannot mistake a refusal for a stored choice.
 */
export function createDatabaseStore(
  db: MachineDb,
  practitionerIdFor: (scope: SelectionScope) => string,
): SelectionStore {
  return {
    async read(scope) {
      const got = await readRememberedMachine(db, practitionerIdFor(scope));
      if (!got.ok) throw new PersistenceUnavailableError(got.error);
      if (!got.value.machineId) return null;
      return { deviceId: got.value.machineId, modeKey: got.value.modeKey };
    },
    async write(scope, selection) {
      const wrote = await rememberMachine(db, {
        studioId: scope.studioId,
        machineId: selection?.deviceId ?? null,
        modeKey: selection?.modeKey ?? null,
      });
      if (!wrote.ok) throw new PersistenceUnavailableError(wrote.error);
      if (!wrote.value) {
        // The command returned NULL: no active membership in that studio.
        throw new ScopeMismatchError();
      }
    },
  };
}
