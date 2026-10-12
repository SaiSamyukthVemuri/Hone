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
 * 2. `PersistenceCapability` makes the difference between a REAL store and a
 *    TEST store a value the UI can read, instead of an assumption. The server
 *    adapter reports `persisted: false` today because there is no column; an
 *    in-memory store used by tests reports `kind: "test-store"`. A panel that
 *    rendered "remembered" while backed by a test double would be the exact
 *    dishonesty this type exists to prevent, and a test asserts the real
 *    adapter never claims persistence.
 *
 * NO MIGRATION IS ASSUMED. A fresh census on 2026-10-12 found 0211-0222 all
 * claimed across open PRs and worktrees - 0219 went to G1 - so the first free
 * number was 0223 at that moment. It must be re-censused before anyone authors
 * against it, and nothing in this file encodes it.
 */

import type {
  SelectionScope,
  SelectionStore,
  StoredSelection,
} from "./selection";
import { selectionKey } from "./selection";

// ---------------------------------------------------------------------------

/** Where a remembered selection actually lives, and whether it survives. */
export type PersistenceCapability = {
  /** Does a choice outlive this request? */
  persisted: boolean;
  kind: "none" | "test-store" | "database";
  /** Practitioner-facing sentence when `persisted` is false. */
  reason: string;
};

/** The real capability today: none. Stated once, read by the UI. */
export const NO_PERSISTENCE: PersistenceCapability = {
  persisted: false,
  kind: "none",
  reason:
    "A remembered machine needs a stored field that does not exist in the " +
    "database yet, so your choice lasts for this form only.",
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
 * The store the server actually has: reads nothing, refuses to pretend a write
 * happened.
 *
 * `read` returning null is truthful - there is nowhere for a selection to have
 * been stored. `write` throwing is the honest half: a no-op write would let the
 * UI report a remembered choice that no later request can find.
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
