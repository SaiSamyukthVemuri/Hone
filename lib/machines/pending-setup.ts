import type { GroupSubmission } from "@/lib/machines/setting-groups";

/**
 * Carrying a machine-settings draft across the BLOCK-CREATE boundary.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * The create form collects machine settings before any settings block exists,
 * and `create_block_with_initial_setup` (0223) writes the area and those
 * settings in ONE transaction. This carries the draft across that boundary.
 *
 * IT USED TO SAY THERE WAS NO CREATE-AND-RECORD, which was true when it was
 * written: the panel refused to collect a reading it had nowhere to put, and
 * she saved the area, re-opened it, and recorded. That two-step flow is gone,
 * and the one-step path is proved - 183 DB tests and a mounted gate-open run
 * on 2026-10-15.
 *
 * The handoff still has four ways to record the WRONG thing permanently, and
 * captures are append-only, so each of them is unamendable:
 *
 *   1. nothing to record, handed off anyway, allocating an empty capture;
 *   2. the draft recorded under a machine or mode the practitioner changed
 *      AFTER typing those numbers, so the values are stored meaning something
 *      she never read;
 *   3. the draft recorded against a DIFFERENT block than the one it was
 *      entered for - a double create is enough;
 *   4. a retry after a lost answer recorded as a second capture - CLOSED for
 *      the edit path by the submission command's per-block key, and for the
 *      INITIAL save by 0223's session-scoped create claim. It stays on this
 *      list because the key's LIFETIME is what closes it: one key per save,
 *      reused by every retry of that save. Mint one per attempt and the hole
 *      reopens with every test still passing.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A PURE MODULE
 * ---------------------------------------------------------------------------
 * This decides what gets written to an append-only clinical table, and this
 * repository has no jsdom, so the same logic inside a component would be
 * provable only by mounting a browser. Three defects in the sibling save path
 * were found by review rather than by a test for exactly that reason.
 *
 * THE FORM CALLS IT NOW - `block-setup-form.tsx` mints the retry key through
 * `prepareHandoff` on every save attempt. The wire was held back until it
 * could be mounted, because this lane had already shipped two features that
 * were inert in production while every unit test passed: `priorUnitNames`,
 * which the connected wrapper never forwarded (Codex, 2351742d), and the
 * remembered mode, which the loader resolved and the wrapper dropped
 * (Codex, 15cc6c99). It has been mounted since.
 *
 * ATOMIC WITH THE BLOCK CREATE SINCE 0223, and this paragraph said the
 * opposite until the command existed. It argued that two commands were the
 * right design and that one doing both would give the clinical setup command a
 * second responsibility - which was a fair reading of the choice at the time,
 * and was wrong about where the responsibility lands:
 * `create_block_with_initial_setup` DELEGATES the area to
 * `create_block_with_entry` (0166) rather than inserting a block itself, so
 * `session_blocks` keeps a single write path and nothing moved into the setup
 * command at all.
 *
 * WHAT SURVIVES FROM IT, because it was the true half: an area with no machine
 * settings is still an ordinary, representable state, and the command must not
 * invent a reason to refuse one. What is gone is the window where the area
 * committed and its settings did not.
 *
 * AND ONE THING THE RUN ADDED THAT NO REASONING HERE PREDICTED: the retry key
 * does NOT make the initial save idempotent, because the key is unique per
 * (BLOCK, key) and this path creates the block first. See
 * `INITIAL_SAVE_UNRESOLVED` below - it is measured against a real database,
 * not inferred.
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

/**
 * What to say when the INITIAL save's answer is lost.
 *
 * THE ADVICE INVERTED, because the command's behaviour did. This constant used
 * to tell her NOT to save again and to reload the chart instead, and that was
 * the honest instruction at the time: the submission command's retry key is
 * unique per (BLOCK, key), the initial save creates the block first, so a
 * repeat collided with nothing and produced a SECOND treatment area carrying a
 * second copy of the settings. Measured against a real database, not reasoned
 * about.
 *
 * `treatment_area_create_claims` (0223) anchors the key to the SESSION, which
 * does pre-exist the area, so a retry carrying the same key now returns the
 * ORIGINAL area, entry and submission. Pressing Save again is the right move,
 * and it is the SAME advice `save-attempt.ts` gives the edit path - the two
 * paths no longer disagree.
 *
 * IT STILL WARNS ABOUT EDITING, which is the one part that did not change. The
 * key identifies a SAVE, not an attempt: a changed draft is a different save,
 * so retrying after an edit either records the edited version (if the first
 * attempt never arrived) or is refused as a used key (if it did). Neither is
 * harmful, and both are confusing, so the plain instruction is to retry as-is.
 */
export const INITIAL_SAVE_UNRESOLVED =
  "The connection failed, so whether this treatment area was saved is not " +
  "known — it may have been. Press Save again without changing anything: " +
  "this save carries a retry key, so if it did save you will get that same " +
  "area back rather than a second copy of it.";

/**
 * The resumed save DID commit, and she is simply told so.
 *
 * NOTHING IS RE-ENTERED and nothing is retried (A1b, Codex #922
 * 4305312331). After a reload the retry key survives in the URL but the
 * payload does not, so the honest move is to answer the question the reload
 * actually raises — "did my save go through?" — by reading the claim, rather
 * than asking her to reconstruct a payload that would have to match a stored
 * digest byte for byte.
 */
export const INITIAL_SAVE_ALREADY_SAVED =
  "This treatment area was already saved — the connection dropped before the " +
  "confirmation reached you, but the save itself completed. It is on the " +
  "chart below, and nothing was duplicated.";

/**
 * The resumed save could not be CHECKED, which is not the same as not saved.
 *
 * FAILS SAFE. It does not claim the save completed and it does not quietly
 * invite a second one: a duplicate clinical record is the cost of guessing
 * wrong in either direction, so she is told what is unknown and left the
 * choice.
 */
export const INITIAL_SAVE_RESUME_UNKNOWN =
  "Whether this treatment area was already saved could not be checked just " +
  "now. Look at the chart below before saving again: if the area is already " +
  "there, close this form instead of saving.";

/**
 * A resumed save whose SETTINGS did not survive the reload.
 *
 * WHY SAVE IS HELD (A1b, Codex #922 4305550889). The retry key travels to
 * `create_block_with_initial_setup` only inside `initialSetup`, so a save with
 * an empty machine draft sends NO key, takes the ordinary create path, and
 * creates a SECOND treatment area. An `area_op` is only ever minted for a save
 * that HAD settings, so a bare save in a resumed form is definitionally a
 * different save — and the one thing that must not proceed unkeyed while the
 * original may still be committing.
 *
 * So she is told what is missing and what to do, rather than being given a
 * button that would duplicate her treatment.
 */
export const INITIAL_SAVE_RESUME_NEEDS_SETTINGS =
  "The machine settings for this area were entered before the page reloaded, " +
  "so they are not on screen any more. Re-enter them to save this area, or " +
  "close this form to abandon it — the area may already be on the chart " +
  "below, so check there before adding another.";

/**
 * THE RECORDED GROUPS MOVED WHILE THIS FORM WAS OPEN.
 *
 * WHY THIS REFUSES RATHER THAN SAVES (Codex, #860 4305780322). Group
 * identities are derived from the recorded snapshot this form loaded, so two
 * page loads that both add a group both pick the SAME next key - and
 * `record_setup_group_in_scope` then takes the second as the next REVISION of
 * the first. Two distinct probe sets merge into one timeline and only the
 * second one's values read as current: a silent loss of what she recorded
 * first.
 *
 * `setting-groups.ts` already names this outcome for a sibling case and says
 * it sits "one guard away from a corrupt clinical record". This is that guard
 * for the case that is actually reachable - a second tab, or a draft left open
 * while another save landed.
 */
export const SETUP_GROUPS_MOVED =
  "Another save added or changed the settings groups for this treatment " +
  "while this form was open, so saving now could overwrite them. Reload the " +
  "chart and enter these settings again - nothing here has been recorded.";

/**
 * AN EARLIER SAVE MAY STILL BE FINISHING, and she has to say which this is.
 *
 * WHY SHE IS ASKED RATHER THAN GUESSED AT (ops01's ruling on #922
 * 4307515255). The retained retry key is what lets a resumed save be absorbed
 * instead of duplicated. Absorption is only correct if this IS the same save:
 * if she has returned to create a genuinely second area with the same values,
 * absorbing it suppresses an area she meant to make. Sam's standing
 * requirement is that recovery preserve the ability to create an identical
 * second area deliberately, so the ambiguity is resolved by asking.
 *
 * PLAIN AND FACTUAL. It says what is uncertain - the earlier save MAY still
 * be finishing - without implying either that it failed or that it worked,
 * because neither is known. And it never asks her to change a value.
 *
 * PRODUCT WORDING, flagged for Sam's packet rather than settled here.
 */
export const RESUME_CHOICE_PROMPT =
  "An earlier save of this treatment area may still be finishing. Choose " +
  "whether this is that same save, or a new area you want as well.";

/** Keep the earlier save's identity, so it cannot be recorded twice. */
export const RESUME_CHOICE_RESUME = "Resume that save";

/**
 * A SECOND AREA, DELIBERATELY, with no value changed to get it.
 *
 * The label says "as well" rather than "instead" because nothing is being
 * replaced: if the earlier save did commit, both areas exist, which is what
 * she asked for.
 */
export const RESUME_CHOICE_NEW = "Start a new area as well";

/**
 * NOTHING FROM THE EARLIER ATTEMPT SURVIVED THE RELOAD, and she has to know
 * that before she saves (Codex, #922 4307763145).
 *
 * THE DEFECT. A reload resets the WHOLE draft - the treatment area, minutes,
 * entry readings, observations, numbing details and notes - not only the
 * machine setup. The recovery gate treated just `machineDraft.groups` as the
 * lost payload, so Save enabled as soon as one machine group was re-entered.
 * If the original never committed, the save then recorded null and default
 * values for every field she had filled in before the reload: a clinical
 * record quietly thinner than the treatment it describes.
 *
 * WHY A CONFIRMATION AND NOT A VALIDATION RULE. A treatment area with blank
 * notes, no observations and no numbing detail is LEGAL - a practitioner may
 * genuinely have none to record - so there is no existing notion of
 * "required" to lean on, and inventing one would be deciding a clinical
 * completeness rule that is not mine to decide. What is wrong here is not
 * that the fields are empty; it is that they are empty BY ACCIDENT while she
 * believes she is restoring an earlier save. So the fix is to make the
 * emptiness deliberate rather than silent: she is told what was lost and
 * confirms that what is on screen is everything.
 *
 * SHE IS NEVER ASKED TO CHANGE A VALUE, only to confirm the ones she has
 * re-entered - which keeps Sam's rule intact on this path too.
 */
export const RESUME_RECONSTRUCT_NOTICE =
  "The reload cleared everything you had entered for this area, not just the " +
  "machine settings. Only what is on screen now will be saved.";

/** The affirmation that turns an accidental blank into a deliberate one. */
export const RESUME_RECONSTRUCT_CONFIRM =
  "Everything I recorded for this area is back on screen";

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
