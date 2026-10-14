import {
  decideHandoff,
  pinToBlock,
  type PendingSetup,
  type PendingSetupIdentity,
} from "@/lib/machines/pending-setup";

/**
 * CREATE THE TREATMENT AREA, THEN RECORD THE MACHINE SETTINGS SHE ENTERED.
 *
 * ---------------------------------------------------------------------------
 * THE GAP
 * ---------------------------------------------------------------------------
 * One-step create-and-record does not exist. In create mode the settings block
 * has no row, so the machine panel refuses to collect a reading it has nowhere
 * to put: she saves the area, re-opens it, and only then records what the
 * machine showed. Two steps for one act, and the browser journey spec asserts
 * that as today's truth rather than pretending otherwise.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PURE ORCHESTRATOR AND NOT A THIRD SERVER ACTION
 * ---------------------------------------------------------------------------
 * `createTreatmentAreaWithEntryAction` ALREADY returns the created block, so
 * the id is already in the caller's hand and there is no source gap to close
 * there. Wrapping the two existing actions in a third would resolve identity
 * twice - each inner action calls `getCurrentPractitionerWithStudio` - add an
 * entry point to grant and guard, and buy nothing, because the interesting
 * part is what happens when the block is created and the record fails, and
 * that is identical wherever it is composed.
 *
 * A worse version would create the block ITSELF rather than delegating, which
 * would be a SECOND clinical write path for `session_blocks`.
 *
 * So: both calls are INJECTED. The decision is made once, here, where it needs
 * no database to prove, and the same function serves the form today or a
 * server action later. The type-level guards in the test file assert that the
 * real actions satisfy these signatures, which is the check that would have
 * caught `priorUnitNames` dying in the connected wrapper (Codex, 2351742d).
 *
 * ---------------------------------------------------------------------------
 * THE STATE THAT MATTERS IS "CREATED, NOT RECORDED"
 * ---------------------------------------------------------------------------
 * The two writes are NOT atomic with each other and deliberately so - one
 * command creates a treatment area, another records a clinical setup, and
 * merging them would give the setup command a responsibility it should not
 * have. So the block can exist with nothing recorded against it, which is an
 * ordinary, honest state: an area whose machine settings have not been entered
 * yet.
 *
 * What must never happen is reporting that state as saved, or as a failure of
 * the whole save. The area IS created; only the settings are not. And the
 * retry is safe, because the retry key is the one minted at handoff and the
 * database recognises a repeat - which is why the outcome carries both the
 * block id and the pinned draft rather than a bare error string.
 */

/** Whatever the create call returns, reduced to what this needs. */
export type CreatedBlock = { id: string };

export type CreateOutcome =
  | { ok: true; block: CreatedBlock }
  | { ok: false; error?: string };

export type RecordOutcome = {
  ok: boolean;
  error?: string;
  captures?: number;
  written?: number;
  reused?: boolean;
};

export type CreateAndRecordResult =
  /** Nothing was entered; the area is saved and that is the whole act. */
  | { kind: "created"; blockId: string }
  /** The area is saved and the settings are recorded. */
  | {
      kind: "recorded";
      blockId: string;
      captures: number;
      readings: number;
      /** The retry was absorbed: these captures already existed. */
      reused: boolean;
    }
  /**
   * The area is saved and the settings are NOT.
   *
   * RETRYABLE, and the caller is given what a retry needs: the block and the
   * draft pinned to it, still carrying its original key. Reported as neither
   * saved nor failed, because the area really was created.
   */
  | {
      kind: "created-not-recorded";
      blockId: string;
      pending: PendingSetup;
      error?: string;
      /** The transport never answered, so the record MAY have committed. */
      unresolved: boolean;
    }
  /** The settings must not be recorded at all. The area is still saved. */
  | { kind: "created-draft-discarded"; blockId: string; reason: string }
  /** The area itself was not created, so nothing was handed off. */
  | { kind: "not-created"; error?: string };

/**
 * Create the area, then hand the draft off to the setup command.
 *
 * `currentIdentity` is the setup identity the panel is on AT THE MOMENT OF
 * SAVING, which is not necessarily the one the values were typed under - she
 * can change the machine between typing and pressing save, and then the
 * numbers mean something she never read off anything.
 */
export async function createAndRecord(args: {
  pending: PendingSetup | null;
  currentIdentity: PendingSetupIdentity;
  createBlock: () => Promise<CreateOutcome>;
  recordSetup: (input: {
    blockId: string;
    machineId: string;
    modeKey: string;
    idempotencyKey: string;
    groups: PendingSetup["groups"];
  }) => Promise<RecordOutcome>;
}): Promise<CreateAndRecordResult> {
  // THE AREA FIRST, ALWAYS. It is the thing she asked to save, and it must not
  // be held hostage to the settings: a machine draft that cannot be recorded
  // is a reason to tell her so, not a reason to lose the treatment area.
  let created: CreateOutcome;
  try {
    created = await args.createBlock();
  } catch (e) {
    return { kind: "not-created", error: errorText(e) };
  }
  if (!created.ok) return { kind: "not-created", error: created.error };

  const blockId = created.block.id;

  const decision = decideHandoff(args.pending, blockId, args.currentIdentity);
  if (decision.kind === "nothing") return { kind: "created", blockId };
  if (decision.kind === "discard") {
    return {
      kind: "created-draft-discarded",
      blockId,
      reason: decision.reason,
    };
  }

  // PINNED BEFORE THE CALL, not after a successful answer. If it waited for
  // the answer, a lost one would leave the draft unpinned and a second create
  // could claim it.
  const pinned = pinToBlock(args.pending!, blockId);

  let recorded: RecordOutcome;
  try {
    recorded = await args.recordSetup({
      blockId,
      machineId: decision.machineId,
      modeKey: decision.modeKey,
      idempotencyKey: decision.idempotencyKey,
      groups: decision.groups,
    });
  } catch (e) {
    // THE TRANSPORT FAILED, SO THE ANSWER IS UNKNOWN - not negative. The
    // write may well have committed, and the retry carries the same key, so
    // the database will return the original submission rather than appending.
    return {
      kind: "created-not-recorded",
      blockId,
      pending: pinned,
      error: errorText(e),
      unresolved: true,
    };
  }

  if (!recorded.ok) {
    // AN ACKNOWLEDGED REFUSAL. Nothing was written, and that is a different
    // fact from a lost answer - it is safe to say so, and a retry under the
    // same key is still correct.
    return {
      kind: "created-not-recorded",
      blockId,
      pending: pinned,
      error: recorded.error,
      unresolved: false,
    };
  }

  return {
    kind: "recorded",
    blockId,
    // THE DATABASE'S OWN TALLY where it gave one. Counting the groups sent
    // would be wrong on a reused submission: it reports what the ORIGINAL
    // save recorded, which is the only true answer.
    captures: recorded.captures ?? decision.groups.length,
    readings: recorded.written ?? 0,
    reused: recorded.reused === true,
  };
}

function errorText(e: unknown): string | undefined {
  if (e instanceof Error && e.message) return e.message;
  return undefined;
}

export const CREATED_NOT_RECORDED_NOTE =
  "The treatment area is saved. The machine settings are not yet recorded — " +
  "save them again from this area; the save carries a retry key, so if they " +
  "did record, saving again returns the same capture rather than recording it " +
  "twice.";

export const CREATED_DRAFT_DISCARDED_PREFIX = "The treatment area is saved. ";

/**
 * What to tell the practitioner, derived from the outcome rather than decided
 * at a call site.
 *
 * THE WORDING IS PART OF THE CONTRACT. "Saved" for a state where the settings
 * were not recorded is the failure this whole module exists to prevent, and a
 * component free to phrase it is a component free to get it wrong.
 */
export function outcomeNote(result: CreateAndRecordResult): string | null {
  switch (result.kind) {
    case "created":
      return null;
    case "recorded":
      return result.reused
        ? "The treatment area is saved. These machine settings were already recorded — nothing was recorded twice."
        : "The treatment area and its machine settings are saved.";
    case "created-not-recorded":
      return CREATED_NOT_RECORDED_NOTE;
    case "created-draft-discarded":
      return CREATED_DRAFT_DISCARDED_PREFIX + result.reason;
    case "not-created":
      return result.error ?? "The treatment area could not be saved.";
  }
}
