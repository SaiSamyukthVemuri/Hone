import type { GroupSubmission } from "@/lib/machines/setting-groups";

/**
 * Carrying a machine-settings draft across the BLOCK-CREATE boundary.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS IS FOR, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * There is no create-and-record today, and that is deliberate rather than
 * missing: in create mode the settings block has no row, so the panel refuses
 * to collect a reading it has nowhere to put. A practitioner therefore saves
 * the treatment area, re-opens it, and only then records what the machine
 * showed. Two steps for one act.
 *
 * Doing it in one needs a draft to survive the moment the block is created,
 * and that handoff has four ways to record the WRONG thing permanently -
 * captures are append-only, so each of them is unamendable:
 *
 *   1. nothing to record, handed off anyway, allocating an empty capture;
 *   2. the draft recorded under a machine or mode the practitioner changed
 *      AFTER typing those numbers, so the values are stored meaning something
 *      she never read;
 *   3. the draft recorded against a DIFFERENT block than the one it was
 *      entered for - a double create is enough;
 *   4. a retry after a lost answer recorded as a second capture.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A PURE MODULE, AND WHY NOTHING CALLS IT YET
 * ---------------------------------------------------------------------------
 * This decides what gets written to an append-only clinical table, and this
 * repository has no jsdom, so the same logic inside a component would be
 * provable only by mounting a browser. Three defects in the sibling save path
 * were found by review rather than by a test for exactly that reason.
 *
 * AND THE FORM IS NOT WIRED TO IT. The wire from the create form through the
 * block-create action is the half that only a mounted run can prove, and this
 * lane has already shipped two features that were inert in production while
 * every unit test passed - `priorUnitNames`, which the connected wrapper never
 * forwarded (Codex, 2351742d), and the remembered mode, which the loader
 * resolved and the wrapper dropped (Codex, 15cc6c99). So the rule lands with
 * its proof; the wire lands when it can be mounted. Until then this module is
 * a building block and the feature does not exist.
 *
 * NOT ATOMIC WITH THE BLOCK CREATE, and that is a real property rather than an
 * oversight. Creating the block and recording the settings are two commands,
 * so the block can exist with no settings recorded against it. That state is
 * REPRESENTABLE and honest - an area with no machine settings yet is an
 * ordinary thing - and the retry key is what makes the second half safely
 * repeatable. The alternative, one command that does both, would put block
 * creation inside the clinical setup command and give it a second
 * responsibility it should not have.
 */

/**
 * What the readings MEAN. All four parts, because each one changes the
 * interpretation of the same numbers: a different unit, a different registered
 * contract version, a different mode's field set.
 */
export type PendingSetupIdentity = {
  deviceId: string;
  profileId: string;
  profileVersion: number;
  modeKey: string;
};

export type PendingSetup = {
  identity: PendingSetupIdentity;
  groups: GroupSubmission[];
  /**
   * The retry key, minted ONCE at handoff.
   *
   * Minted here rather than at the call means every attempt to record this
   * draft - including one after a lost answer - carries the same key, so the
   * database recognises the repeat and returns the original submission. A key
   * minted per attempt would make each retry a new save.
   */
  idempotencyKey: string;
  /**
   * The block this draft has been handed off to, once there is one.
   *
   * Null until the block exists. After that it is FIXED: the draft may be
   * retried against that block and may never be applied to another, because
   * the values were entered for that treatment area.
   */
  appliedToBlockId: string | null;
};

export const IDENTITY_CHANGED =
  "The machine or mode changed after these settings were entered, so they " +
  "have to be read off the machine again before they can be recorded.";

export const WRONG_BLOCK =
  "These settings were entered for a different treatment area and cannot be " +
  "recorded against this one.";

/**
 * Capture a draft for handoff, or decline to.
 *
 * Returns null when there is nothing to record. An empty handoff is the first
 * of the four failures above: `record_treatment_setup_submission` refuses an
 * empty save, but reaching it at all means the create form believed it had
 * something to store.
 */
export function prepareHandoff(
  identity: PendingSetupIdentity,
  groups: readonly GroupSubmission[],
  mint: () => string,
): PendingSetup | null {
  const withReadings = groups.filter((g) => g.readings.length > 0);
  if (withReadings.length === 0) return null;
  return {
    identity,
    groups: withReadings.map((g) => ({ ...g })),
    idempotencyKey: mint(),
    appliedToBlockId: null,
  };
}

/** Do these readings still mean what they meant when they were typed? */
export function identityMatches(
  pending: PendingSetup,
  current: PendingSetupIdentity,
): boolean {
  const a = pending.identity;
  return (
    a.deviceId === current.deviceId &&
    a.profileId === current.profileId &&
    a.profileVersion === current.profileVersion &&
    a.modeKey === current.modeKey
  );
}

export type HandoffDecision =
  | {
      kind: "record";
      blockId: string;
      machineId: string;
      modeKey: string;
      idempotencyKey: string;
      groups: GroupSubmission[];
    }
  /** Nothing was entered. Not an error; the block is simply saved alone. */
  | { kind: "nothing" }
  /** Entered, but must not be recorded. The sentence is for the practitioner. */
  | { kind: "discard"; reason: string };

/**
 * What to do with a draft now that the block exists.
 *
 * `current` is the setup identity the panel is on AT THIS MOMENT, which is not
 * necessarily the one the values were typed under - she can change the machine
 * between typing and saving, and then the numbers mean something she never
 * read off anything.
 */
export function decideHandoff(
  pending: PendingSetup | null,
  blockId: string,
  current: PendingSetupIdentity,
): HandoffDecision {
  if (!pending) return { kind: "nothing" };
  if (!identityMatches(pending, current)) {
    return { kind: "discard", reason: IDENTITY_CHANGED };
  }
  // ALREADY HANDED OFF TO ANOTHER BLOCK. A retry against the SAME block is
  // the whole point of the key and is allowed; a different block is not, and a
  // double create is enough to produce one.
  if (pending.appliedToBlockId !== null && pending.appliedToBlockId !== blockId) {
    return { kind: "discard", reason: WRONG_BLOCK };
  }
  return {
    kind: "record",
    blockId,
    machineId: pending.identity.deviceId,
    modeKey: pending.identity.modeKey,
    idempotencyKey: pending.idempotencyKey,
    groups: pending.groups,
  };
}

/**
 * Pin a draft to the block it was handed off to.
 *
 * Called once the decision to record has been made, BEFORE the call rather
 * than after it: if it waited for a successful answer, a lost answer would
 * leave the draft unpinned and a second create could claim it.
 */
export function pinToBlock(pending: PendingSetup, blockId: string): PendingSetup {
  if (pending.appliedToBlockId === blockId) return pending;
  return { ...pending, appliedToBlockId: blockId };
}
