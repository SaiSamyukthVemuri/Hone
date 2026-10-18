"use client";

// Treatment-area editor for an electrolysis session.
//
// Session Logging Phase A: practitioner-facing language is "treatment
// area," not "block." The underlying schema (session_blocks) and the
// create/update server actions are unchanged. This is an area-first UI
// over the existing fields:
//   - Treatment area (primary_area / side / custom_area_detail, 0039) is
//     the section identity and comes first.
//   - block_name is NOT collected in this flow. New areas save with a
//     null block_name; legacy rows keep their block_name (we never send
//     it in the edit patch, so it's preserved).
//   - Minutes performed is optional: session_blocks.minutes_performed is
//     nullable and createSessionBlockAction defaults blank → null, so a
//     blank field saves as null (not 0).
//
// Dual mode: with `block` it edits that row via updateSessionBlockAction;
// without, it creates a new row via createSessionBlockAction. Both
// actions already accept every field used here, no action behavior
// change.

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  APILUS_MODALITIES_BY_MODE,
  ELECTROLYSIS_MODES,
  MACHINE_FREQUENCIES,
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
  PULSE_DELAY_DEFAULT,
  PULSE_DELAY_MIN,
  PULSE_DELAY_MAX,
  apilusModalityLabel,
} from "@/lib/constants";
import type { ProbeLotSuggestions } from "@/lib/record-keeping/probe-lot-suggestion";
import { ProbeLotSelect } from "@/components/probe-lot-select";
import {
  activeProbeLotOptionsForProbe,
  probeLotOptionsForProbe,
  type ProbeLotOption,
} from "@/lib/record-keeping/probe-lot-inventory";
import {
  probeLotDraftPatch,
  probeLotSourceMessage,
  resolveProbeLotAutofill,
  type ProbeLotAutofillResult,
} from "@/lib/record-keeping/probe-lot-autofill";
import type { SessionBlockWithEntries } from "@/lib/supabase/queries";
import {
  buildTreatmentSetupDraftPatch,
  firstLiveEntry,
} from "@/lib/sessions/treatment-setup-snapshot";
import type {
  ApilusModality,
  ElectrolysisEntry,
  ElectrolysisMode,
  MachineFrequency,
  SessionBlock,
  SessionBlockSide,
  SessionMode,
} from "@/lib/types/database";
import {
  isChipSelected,
  toggleFindingChip,
  resolveDisplayChips,
  mergeReactionIntoChips,
  MERGED_OBSERVATION_CHIPS,
} from "@/lib/observation-chips";
import { SelectedObservations } from "@/components/selected-observations";
import {
  NUMBING_OPTIONS,
  TOLERANCE_OPTIONS,
  isReactionType,
  reactionTypeLabel,
  type ReactionType,
} from "@/lib/sessions/clinical-response";
import {
  OBSERVATIONS_RESPONSE_HEADING,
  OBSERVATIONS_RESPONSE_HELPER,
  ADDITIONAL_NOTES_HEADING,
  ADDITIONAL_NOTES_HELPER,
} from "@/lib/sessions/charting-labels";
import { SESSION_BLOCK_SIDE_OPTIONS } from "@/lib/sessions/side-labels";
import {
  readAreaOperationId,
  syncAreaOperationParam,
} from "@/lib/machines/area-operation";
import { AreaPicker } from "@/components/area-picker";
import { isCanonicalTreatmentArea } from "@/lib/sessions/area-validation";
import { BodyMapAreaPicker } from "@/components/body-map-area-picker";
import { MultiAreaEditor } from "@/components/multi-area-editor";
import { resolveBlockAreas, type BlockArea } from "@/lib/sessions/block-areas";
import { MachineFirstSetupConnected } from "@/components/machines/machine-first-setup-connected";
import { ProbePicker } from "@/components/probe-picker";
import { READING_INPUT_CLS } from "@/lib/sessions/charting-input-styles";
import { resolveModeSections } from "@/lib/sessions/mode-sections";
import {
  INITIAL_SAVE_ALREADY_SAVED,
  INITIAL_SAVE_RESUME_NEEDS_SETTINGS,
  INITIAL_SAVE_RESUME_UNKNOWN,
  INITIAL_SAVE_UNRESOLVED,
  prepareHandoff,
  type PendingSetupIdentity,
} from "@/lib/machines/pending-setup";
import {
  lookupAreaCreateClaimAction,
  type AreaCreateClaimLookup,
} from "./machine-setup-actions";
import type { GroupSubmission } from "@/lib/machines/setting-groups";
import {
  createTreatmentAreaWithEntryAction,
  updateTreatmentAreaWithEntryAction,
} from "./block-actions";
import { SectionLabel } from "@/components/ui/section-label";

const PRIMARY_AREA_MAX = 60;
const CUSTOM_AREA_DETAIL_MAX = 60;
const MINUTES_MAX = 1440;

// Parses an optional numeric reading with range checks. Empty → null.
// Mirrors the server-side validation; the action re-validates regardless.
function parseOptionalNumber(
  raw: string,
  opts: { int?: boolean; min?: number; max?: number; label: string },
): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = raw.trim();
  if (s === "") return { ok: true, value: null };
  const n = opts.int ? parseInt(s, 10) : Number(s);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${opts.label} must be a number.` };
  }
  if (opts.min != null && n < opts.min) {
    return { ok: false, error: `${opts.label} must be ${opts.min} or more.` };
  }
  if (opts.max != null && n > opts.max) {
    return { ok: false, error: `${opts.label} must be ${opts.max} or less.` };
  }
  return { ok: true, value: n };
}

// Side options for paired anatomy. The DB CHECK (migration 0039) enforces
// the same five values plus NULL. UI displays a Title-case label but
// stores the canonical lowercase value. PR #162 moved the option list +
// label-lookup into lib/sessions/side-labels.ts so the read-only blocks
// view picks up the same wording (notably "bilateral" -> "Both sides"
// after Chloe's charting feedback). We re-export the alias here so the
// rest of this file (which references SIDE_OPTIONS in two render sites)
// continues to compile without a wider rename.
const SIDE_OPTIONS = SESSION_BLOCK_SIDE_OPTIONS;

type Props = {
  sessionId: string;
  clientId: string;
  // For "Copy settings from another area in this session" (create mode only).
  previousBlock: SessionBlockWithEntries | null;
  // PR #191: every saved treatment area in this session, in sort
  // order. Copy settings prefers the most recent area matching the
  // currently selected treatment area before falling back to the
  // last one.
  savedBlocks?: SessionBlockWithEntries[];
  // When present, the form edits this existing area instead of creating.
  block?: SessionBlock | null;
  // The block's first/primary entry, if any. In edit mode its readings seed
  // the form and are updated on save; entries 2..N are never touched here.
  firstEntry?: ElectrolysisEntry | null;
  // Create-mode only: initial value for the treatment area, seeded from the
  // attached treatment plan's primary_area. UI defaulting only: fully
  // editable; never overrides the practitioner's choice on save.
  defaultPrimaryArea?: string | null;
  // Create-mode only (PR #203, migration 0084): sticky machine
  // frequency seeded from the practitioner's last-used value. UI
  // defaulting only; fully editable per treatment area.
  defaultMachineFrequency?: string | null;
  // Feature A (reliability): most recent lot/batch per probe in this studio,
  // keyed by probe_key AND by normalized probe_label (free-text fallback), each
  // carrying its confirmed flag. The form auto-populates the lot field for the
  // selected probe (studio-scoped, never auto-confirmed), keyed match first,
  // label fallback second. Empty when there is nothing to suggest.
  probeLotSuggestions?: ProbeLotSuggestions;
  // Migration 0128 charting release: the studio's ACTIVE probe-lot inventory
  // (record_keeping_sterile_items probe rows) powering the searchable selector.
  // Manual entry always stays available; expired lots are still selectable but
  // flagged. Empty = the selector shows the "No active probe lots found" state.
  probeLotInventory?: ProbeLotOption[];
  // Migration 0128: the block's structured areas on edit (empty for legacy /
  // create). Seeds the multi-area editor; the read path falls back to
  // primary_area + side when empty.
  initialAreas?: BlockArea[];
  onCancel: () => void;
};

type Draft = {
  mode: string;
  apilusModality: string;
  energyLevel: string;
  // Session Logging Phase B: a single structured probe catalog key
  // (lib/probes.ts). Empty string = no probe. Replaces the old flat
  // probeType / probeSize dropdowns.
  probeKey: string;
  probeLotNumber: string;
  machineFrequency: string;
  minutes: string;
  // Treatment area (0039, legacy). Retained for copy/back-compat but the UI now
  // drives the structured `areas` set (migration 0128) below.
  primaryArea: string;
  side: string; // SessionBlockSide | ""
  customAreaDetail: string;
  // Multi-area (0128): the areas treated with these settings, each with its own
  // laterality. This is the authoritative area input the form submits.
  areas: BlockArea[];
  // One-page charting: the first entry's readings, captured on the same
  // page and saved with the treatment area (no second form). Phase 3 splits
  // the readings into thermolysis and galvanic so blend records both.
  thermolysisIntensityPercent: string;
  thermolysisDurationSeconds: string;
  galvanicMa: string;
  galvanicDurationSeconds: string;
  // galvanic_intensity_percent is a retired reading, no longer captured, edited,
  // hydrated, or sent by this form. Historical values are preserved server-side
  // (the update omits the column); new entries always store NULL.
  unitsOfLye: string;
  pulseCount: string;
  pulseDelay: string;
  hairsTreated: string;
  comments: string;
  // Migration 0108: structured observation chips (canonical labels). Selection
  // is explicit state here, NOT re-derived from `comments`, so a selected chip
  // can never silently disappear. Free-text lives in `comments` above.
  observationChips: string[];
  // PR #190 (migration 0082): structured client response. All optional.
  // toleranceRating is "" or "1".."5"; reactionType is "" or an
  // allowlisted value from lib/sessions/clinical-response.ts.
  toleranceRating: string;
  reactionType: string;
  reactionNotes: string;
  cautionForNextSession: boolean;
  cautionNote: string;
  // PR #279 (migration 0095). numbingStatus is "" (Not recorded), "none", or
  // "used". probeLotConfirmed records that the practitioner confirmed the lot.
  numbingStatus: string;
  // 0156: optional free-text numbing note. Held in draft even while the status
  // is toggled away from "used" (so toggling back restores it); the server
  // stores it only when the saved status is "used".
  numbingNotes: string;
  probeLotConfirmed: boolean;
  // Migration 0155: the linked sterile-inventory item id when the lot was chosen
  // from inventory; null = manual/unlinked. The saved probe_lot_number is still
  // the authoritative snapshot.
  probeInventoryItemId: string | null;
};

const EMPTY: Draft = {
  mode: "",
  apilusModality: "",
  energyLevel: "",
  probeKey: "",
  probeLotNumber: "",
  machineFrequency: "",
  minutes: "",
  primaryArea: "",
  side: "",
  customAreaDetail: "",
  areas: [],
  thermolysisIntensityPercent: "",
  thermolysisDurationSeconds: "",
  galvanicMa: "",
  galvanicDurationSeconds: "",
  unitsOfLye: "",
  pulseCount: String(PULSE_COUNT_DEFAULT),
  pulseDelay: String(PULSE_DELAY_DEFAULT),
  hairsTreated: "",
  comments: "",
  observationChips: [],
  toleranceRating: "",
  reactionType: "",
  reactionNotes: "",
  cautionForNextSession: false,
  cautionNote: "",
  numbingStatus: "",
  numbingNotes: "",
  probeLotConfirmed: false,
  probeInventoryItemId: null,
};

function initialDraft(
  block: SessionBlock | null | undefined,
  firstEntry: ElectrolysisEntry | null | undefined,
  defaultPrimaryArea: string | null | undefined,
  defaultMachineFrequency?: string | null,
  initialAreas?: BlockArea[],
): Draft {
  // Create mode: start blank, but seed the treatment area from the attached
  // plan when provided, and the machine frequency from the practitioner's
  // sticky last-used default (PR #203, migration 0084). Both editable;
  // never forced.
  if (!block) {
    const seed = defaultPrimaryArea?.trim() || "";
    return {
      ...EMPTY,
      primaryArea: seed,
      areas: seed ? [{ area: seed, laterality: "not_applicable" }] : [],
      machineFrequency: defaultMachineFrequency?.trim() || "",
    };
  }
  // Migration 0108: seed structured observation chips. New rows carry
  // observation_chips directly; legacy rows (empty chips) are hydrated from
  // `comments` NON-destructively, matched chip tokens become chips, everything
  // else stays as free-text, so editing an old record shows chips reliably and
  // never double-displays them. The stored row is untouched until the
  // practitioner saves.
  // Chip-loading fix: seed the SAME way the entry-row renders: via the single
  // resolveDisplayChips contract. Structured chips preload directly; a LEGACY
  // entry (empty observation_chips) hydrates its chips out of `comments` so
  // reopening an old treatment area shows them as SELECTED controls, with the
  // remaining free-text as the note. Stored data is untouched until save.
  const hydrated = (() => {
    const r = resolveDisplayChips(firstEntry?.observation_chips, firstEntry?.comments);
    return { chips: r.chips, freeText: r.note };
  })();
  return {
    mode: block.mode ?? "",
    apilusModality: block.apilus_modality ?? "",
    energyLevel: block.energy_level != null ? String(block.energy_level) : "",
    probeKey: block.probe_key ?? "",
    probeLotNumber: block.probe_lot_number ?? "",
    machineFrequency: block.machine_frequency ?? "",
    minutes:
      block.minutes_performed != null ? String(block.minutes_performed) : "",
    // Multi-area (0128): structured child rows take precedence; a legacy block
    // (no child rows) falls back to primary_area + side as a single area.
    areas: resolveBlockAreas(initialAreas ?? [], {
      primary_area: block.primary_area,
      side: block.side,
    }),
    primaryArea: block.primary_area ?? "",
    side: block.side ?? "",
    customAreaDetail: block.custom_area_detail ?? "",
    // Seed readings from the first entry if present; otherwise blank (and
    // pulse defaults to 1, matching a fresh pass).
    thermolysisIntensityPercent:
      firstEntry?.thermolysis_intensity_percent != null
        ? String(firstEntry.thermolysis_intensity_percent)
        : "",
    thermolysisDurationSeconds:
      firstEntry?.thermolysis_duration_seconds != null
        ? String(firstEntry.thermolysis_duration_seconds)
        : "",
    galvanicMa:
      firstEntry?.galvanic_ma != null ? String(firstEntry.galvanic_ma) : "",
    galvanicDurationSeconds:
      firstEntry?.galvanic_duration_seconds != null
        ? String(firstEntry.galvanic_duration_seconds)
        : "",
    // galvanic_intensity_percent is retired: NOT hydrated into the draft. The
    // stored historical value stays untouched in the DB (the update omits the
    // column), so editing a legacy galvanic entry preserves it server-side.
    unitsOfLye:
      firstEntry?.units_of_lye != null ? String(firstEntry.units_of_lye) : "",
    pulseCount:
      firstEntry?.pulse_count != null
        ? String(firstEntry.pulse_count)
        : String(PULSE_COUNT_DEFAULT),
    pulseDelay:
      firstEntry?.pulse_delay_seconds != null
        ? String(firstEntry.pulse_delay_seconds)
        : String(PULSE_DELAY_DEFAULT),
    hairsTreated:
      firstEntry?.hairs_treated != null
        ? String(firstEntry.hairs_treated)
        : "",
    comments: hydrated.freeText,
    // Charting unification: fold a legacy reaction_type into the ONE merged chip
    // selection (shown as a selected chip). On save it migrates into
    // observation_chips and reaction_type is cleared: the value is preserved,
    // never a separate row.
    observationChips: mergeReactionIntoChips(hydrated.chips, block.reaction_type),
    // PR #190: round-trip the stored response so an edit save that
    // never touches the section preserves it unchanged.
    toleranceRating:
      block.tolerance_rating != null ? String(block.tolerance_rating) : "",
    // Keep the ORIGINAL legacy reaction_type so save can preserve it while its
    // equivalent chip stays selected, and clear it ONLY if the practitioner
    // deselects that reaction. Its label is folded into observationChips above
    // for display. Never edited directly.
    reactionType: block.reaction_type ?? "",
    reactionNotes: block.reaction_notes ?? "",
    cautionForNextSession: block.caution_for_next_session ?? false,
    cautionNote: block.caution_note ?? "",
    // PR #279 (migration 0095): round-trip numbing + lot confirmation.
    numbingStatus: block.numbing_status ?? "",
    numbingNotes: block.numbing_notes ?? "",
    probeLotConfirmed: block.probe_lot_confirmed ?? false,
    probeInventoryItemId: block.probe_inventory_item_id ?? null,
  };
}

// Where the value in the lot/batch field came from. The resolver kinds are
// auto-fill provenance; "manual" is a value the practitioner typed (or a manual
// lot on a saved block being edited); "copied" is one carried in by "Copy
// settings from another area in this session".
type LotStatus = ProbeLotAutofillResult["kind"] | "manual" | "copied" | null;

export function BlockSetupForm({
  sessionId,
  clientId,
  previousBlock,
  savedBlocks,
  block,
  firstEntry,
  defaultPrimaryArea,
  defaultMachineFrequency,
  probeLotSuggestions = { byKey: {}, byLabel: {} },
  probeLotInventory = [],
  initialAreas,
  onCancel,
}: Props) {
  const isEdit = !!block;
  const [draft, setDraftRaw] = useState<Draft>(() =>
    initialDraft(block, firstEntry, defaultPrimaryArea, defaultMachineFrequency, initialAreas),
  );
  // A lot/batch belongs to ONE probe. Provenance is therefore tracked PER PROBE
  // rather than as a global "has she edited it?" boolean.
  //
  // The global boolean was wrong in a way that matters clinically: once she
  // typed a lot for a Sterex F4, the flag latched true forever, so selecting a
  // DIFFERENT probe left the F4 lot sitting under it. The record then claimed a
  // lot that was never used on that probe. `lotOwnerProbeKey` is the probe the
  // current lot value belongs to; when the selected probe moves away from it,
  // the previous probe's value, inventory link and provenance are all dropped
  // and the resolver runs fresh for the newly selected probe.
  const [lotOwnerProbeKey, setLotOwnerProbeKey] = useState<string>(
    () => draft.probeKey,
  );
  const [error, setError] = useState<string | null>(null);
  /**
   * The machine settings the panel is collecting, in CREATE mode only.
   *
   * HELD HERE BECAUSE THIS FORM'S SAVE CARRIES THEM. With no block there is
   * nothing to record against, so the panel cannot save them itself - and
   * `create_block_with_initial_setup` writes the area and the settings in one
   * transaction, so there is exactly one Save for both.
   *
   * `blocking` is non-null when the draft is half-finished - a group with
   * some values and a missing required field, or two groups claiming the same
   * probe - and `submit` refuses rather than discarding her numbers.
   */
  /**
   * An initial save whose answer was lost.
   *
   * RETRYABLE NOW, and it was not when this state was added: 0223's create
   * claim anchors the retry key to the SESSION, so pressing Save again returns
   * the original area instead of creating a second one. The flag survives
   * because it still has a job - it keeps the key alive across attempts and
   * puts the instruction on screen. See `INITIAL_SAVE_UNRESOLVED`.
   */
  /**
   * THE OPEN SAVE THIS PAGE LOAD IS RESUMING, read from the URL exactly once.
   *
   * `syncAreaOperationParam` writes through `history.replaceState`, which
   * deliberately does NOT notify the router — so `useSearchParams()` never
   * reports our own writes back, and re-reading it later would be reading a
   * stale value. Held in state so it is the value this mount resumed from,
   * whatever the address bar says afterwards.
   *
   * ONLY AN ID WE MINTED: `readAreaOperationId` returns null for anything
   * missing, malformed, repeated or not v4-shaped, and a null simply mints a
   * fresh one. Honouring a value we did not mint could have 0223 hand her
   * ANOTHER save's treatment area, which is far worse than one extra area.
   *
   * AND ONLY IN CREATE MODE (Codex, #922 4305312335). This component is
   * dual-mode: the same file renders the EDIT form for an existing area. With
   * a stale `area_op` still in the URL, opening Edit consumed the create
   * operation's key, froze her edits and disabled Cancel — and the edit
   * success path never cleared the parameter, so every subsequent edit stayed
   * poisoned until she navigated away. An edit is not that save, so in edit
   * mode this reads nothing and touches nothing: a genuine unresolved create's
   * key has to survive her editing something else.
   */
  const router = useRouter();
  const searchParams = useSearchParams();
  const [resumedSaveKey] = useState<string | null>(() =>
    isEdit ? null : readAreaOperationId(searchParams),
  );

  /**
   * An initial save whose answer was lost.
   *
   * RETRYABLE NOW, and it was not when this state was added: 0223's create
   * claim anchors the retry key to the SESSION, so pressing Save again returns
   * the original area instead of creating a second one. The flag survives
   * because it still has a job - it keeps the key alive across attempts and
   * puts the instruction on screen. See `INITIAL_SAVE_UNRESOLVED`.
   *
   * IT IS NOT SEEDED FROM THE URL, and an earlier spelling of this change
   * made that mistake (Codex, #922 4305312331). Seeding it true on a resumed
   * key froze a draft that had just been initialised from FRESH DEFAULTS, so
   * the practitioner could not reconstruct the original payload — and the key
   * only reaches `create_block_with_initial_setup` inside `initialSetup`, so
   * saving with that empty draft sent NO key, took the ordinary create path,
   * and made the very duplicate the mechanism exists to prevent.
   *
   * A reload does not resume a RETRY. It resumes a QUESTION — "did my save
   * commit?" — and `resolvedResume` below answers it by reading the claim
   * instead of asking her to re-enter anything.
   */
  const [saveUnresolved, setSaveUnresolved] = useState(false);

  /**
   * THE ANSWER TO THE RESUMED SAVE'S QUESTION, or null while it is unknown.
   *
   *   * `checking` — the claim read is in flight. Save is held, because
   *     committing a second save before the answer lands is the one thing
   *     this must not allow.
   *   * `saved` — the claim exists: the first attempt DID commit. She is told
   *     so, the parameter is cleared, and nothing is re-entered.
   *   * `absent` — no claim: nothing committed. The key is adopted so another
   *     reload is still reconcilable, and she saves normally.
   *   * `unknown` — the read itself failed. It FAILS SAFE: it does not claim
   *     the save completed and does not silently permit a duplicate. She
   *     keeps the "check the chart before saving again" instruction and the
   *     choice.
   */
  const [resume, setResume] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "saved"; blockId: string }
    | { state: "absent" }
    | { state: "unknown" }
  >(() => (resumedSaveKey === null ? { state: "idle" } : { state: "checking" }));

  /**
   * THE RESUMED OPERATION STILL OWNS THE KEY, and nothing else may discard it.
   *
   * True while the claim read is in flight, and true when it FAILED — because
   * an unanswerable question is not a settled one. Last round adopted the key
   * on a failed read precisely so a later save could not silently duplicate an
   * operation that may have committed, and then two paths undid that:
   *
   *   * entering any machine reading fires `onSettingDraftChanged`, whose drop
   *     rule saw an ordinary completed draft change and cleared the key — so
   *     the reconstructed save minted a fresh uuid, bypassed the claim, and
   *     duplicated if the original had committed (4305431332, P1);
   *   * Cancel was live while the lookup was still in flight, and clearing the
   *     parameter discarded the answer before it arrived, leaving the next Add
   *     with nothing to reconcile against (4305431336).
   *
   * So the ownership is named once here and both paths defer to it, rather
   * than each re-deriving which states count as open.
   *
   * AND "ABSENT" IS NOT SETTLED EITHER (Codex, #922 4305501015, P1).
   * `create_block_with_initial_setup` takes its advisory lock BEFORE looking
   * for a claim and inserts the claim at the very END
   * (0223: `pg_advisory_xact_lock` then the lookup; the insert ~140 lines
   * later). The reconciliation read does not hold that lock, so a reload
   * landing while the original transaction is still committing sees NO ROW for
   * a save that is about to succeed. Treating that as settled let the next
   * keystroke clear the key, and the retry then minted a fresh uuid and
   * duplicated the area the moment the first transaction committed.
   *
   * SO THE KEY IS OWNED FOR THE WHOLE LIFE OF A RESUMED OPERATION, and the
   * only state that releases it is `saved` — the one answer that is
   * positively true, and the one where the form closes anyway. `idle` is the
   * ordinary non-resumed form, where a changed draft still mints a new key as
   * it always did.
   *
   * KEEPING THE KEY IS SAFE IN EVERY BRANCH, which is why this is the whole
   * fix and no lock is needed on the read. If the original committed and her
   * reconstruction differs, 0223 refuses the reused key and SAYS so; if it
   * matches, the save is absorbed and she gets the original area; if the
   * original never committed, the key is unused and the save proceeds. A
   * fresh key is the only option that duplicates silently.
   */
  const resumeOwnsKey = resume.state !== "idle" && resume.state !== "saved";


  /**
   * A REVISION save inside the machine panel has an unknown outcome.
   *
   * SEPARATE FROM `saveUnresolved`, which is THIS form's own create-mode
   * save. They are owned by different components and either can be true
   * alone; merging them would make clearing one clear the other. They are
   * combined only where a control has to be frozen.
   */
  const [revisionUnresolved, setRevisionUnresolved] = useState(false);

  /**
   * WHILE THE INITIAL SAVE'S OUTCOME IS UNKNOWN, ITS PAYLOAD IS FROZEN.
   *
   * `create_block_with_initial_setup` binds the retry key to a digest of the
   * WHOLE payload - all 27 parameters - so the preserved key only makes the
   * retry safe while the thing being retried is identical. Editing any field
   * first turns a committed first attempt's safe retry into a mismatch
   * refusal, which leaves her unable to recover the original result and
   * pushes toward cancel-and-recreate: a duplicate area
   * (Codex, #860 4296029608).
   *
   * FROZEN AT THE SETTER, not control by control. This form has five
   * user-driven writers across 1,700 lines and more fields than any of them
   * touches; disabling inputs one at a time is a list that goes stale the
   * next time a field is added, and a missed one is a duplicated clinical
   * record. Shadowing the setter makes the payload immutable no matter which
   * control is wired, and the controls are disabled as well so the screen
   * says what is happening rather than silently ignoring her.
   *
   * The SAVE button stays live: pressing it again, unchanged, is the whole
   * recovery.
   */
  const [pending, startTransition] = useTransition();
  /**
   * THE FREEZE COVERS THE REQUEST ITSELF, NOT ONLY ITS AFTERMATH
   * (Codex, #860 4305022475).
   *
   * `saveUnresolved` alone starts the freeze when the answer comes back, and
   * the whole payload — `attachedSetup` and every other action input — was
   * snapshotted before `startTransition`. So an edit made during a slow save
   * was already outside the thing being saved: a success discarded it
   * silently and showed a confirmation for values she had changed, and a lost
   * response retried the retained key with the NEW payload, which the create
   * claim refuses as a digest mismatch.
   *
   * `pending` is why the transition is declared here rather than beside the
   * other submit state below.
   */
  const draftFrozen = pending || saveUnresolved;

  /**
   * CLOSING THE FORM ABANDONS THE OPEN SAVE, so the parameter goes with it
   * (Codex, #922 4305312340).
   *
   * A definitive server error leaves `saveUnresolved` false and Cancel
   * enabled, and Cancel unmounted the form without going through the syncing
   * setter — so `area_op` stayed in the URL and the next Add treated an
   * abandoned attempt as an open save. Every exit routes through here, which
   * is the same reason the key is mirrored at its setter rather than at its
   * call sites.
   *
   * IN EDIT MODE IT CLEARS NOTHING, because the parameter is not this form's:
   * a genuine unresolved create must survive her editing another area.
   */
  const closeForm = () => {
    // IN EDIT MODE the parameter is not this form's to discard, and while the
    // resumed operation still owns the key, clearing it would throw away the
    // only thing that can reconcile a save that may have committed. Closing
    // the form is allowed in that state — she must be able to leave — but it
    // leaves the identity behind so reopening Add can still answer the
    // question (Codex, #922 4305431336).
    if (!isEdit && !resumeOwnsKey) syncAreaOperationParam(null);
    onCancel();
  };

  /**
   * Take the resumed key as this form's open save.
   *
   * Through the SHADOW setter, like every other write: the URL already holds
   * this value so the mirror is a no-op, and routing it here keeps "nothing
   * reaches the raw setter but the shadow" true.
   */
  const adoptResumedKey = () => {
    if (resumedSaveKey !== null) setPendingSaveKey(resumedSaveKey);
  };

  /**
   * ANSWER THE RESUMED SAVE'S QUESTION BY READING THE CLAIM.
   *
   * Runs once per mount, only when the URL carried a key we minted. The three
   * outcomes are handled where they are decided rather than being collapsed:
   * a read that FAILED is not an empty result, and treating it as one would
   * turn "we could not check" into "nothing was saved".
   */
  useEffect(() => {
    if (resumedSaveKey === null) return;
    let live = true;
    void (async () => {
      const res = await lookupAreaCreateClaimAction({
        clientId,
        sessionId,
        idempotencyKey: resumedSaveKey,
      }).catch(
        (): AreaCreateClaimLookup => ({
          // A THROW IS THE UNKNOWN CASE, not a refusal. The action returns its
          // own refusals; reaching here means the call itself did not complete.
          ok: false,
          error: INITIAL_SAVE_RESUME_UNKNOWN,
        }),
      );
      if (!live) return;

      if (!res.ok) {
        // ADOPTED EVEN THOUGH THE ANSWER IS UNKNOWN, and this is the safer
        // direction rather than the tidier one. If she decides to save anyway
        // and the first attempt HAD committed, a save carrying the original
        // key is REFUSED by 0223 as a used key with a different payload — she
        // is told. A freshly minted key would silently create the duplicate
        // instead.
        adoptResumedKey();
        setResume({ state: "unknown" });
        setError(INITIAL_SAVE_RESUME_UNKNOWN);
        return;
      }
      if (res.found) {
        // IT COMMITTED — BUT THE CHART MAY NOT SHOW IT YET (Codex, #922
        // 4305501020, P1). If the server page read `blocks` before the
        // original transaction committed and this read ran after, the claim is
        // found while `SessionBlocksView` still holds the pre-commit prop. The
        // message then said the area was "on the chart below" when it was not,
        // and after Close she would reopen Add and create a second one.
        //
        // REFRESHED FIRST, so the statement is true when she reads it. This is
        // the one place the ROUTER is right: everywhere else this form edits
        // the URL through `history.replaceState` precisely to avoid refetching
        // the server component mid-save, but here a refetch is the point.
        router.refresh();
        syncAreaOperationParam(null);
        setResume({ state: "saved", blockId: res.blockId });
        return;
      }
      // NOTHING COMMITTED. Adopt the key so another reload is still
      // reconcilable, and let her save normally — the draft is untouched and
      // unfrozen, which is the whole difference from the first spelling.
      adoptResumedKey();
      setResume({ state: "absent" });
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumedSaveKey, clientId, sessionId]);
  const setDraft: typeof setDraftRaw = (...args) => {
    if (draftFrozen) return;
    setDraftRaw(...args);
  };
  /**
   * The retry key of the save in progress, or null when none is open.
   *
   * THIS IS THE WHOLE MECHANISM, and its lifetime is the subtle part - the
   * same rule `save-attempt.ts` states for the edit path. The key identifies a
   * SAVE, not an attempt:
   *
   *   * minted when a save starts and there is none;
   *   * REUSED by every retry of that save, which is what makes the retry
   *     safe - if the first attempt committed and only its answer was lost,
   *     the command returns the original area;
   *   * dropped when she changes the draft, because a changed draft is a
   *     DIFFERENT save - EXCEPT while an attempt is unresolved, where dropping
   *     it would turn the retry into a second area.
   *
   * A key minted per attempt makes idempotence useless while every test still
   * passes, which is precisely why it is held here rather than inside
   * `machineSetupForSave`.
   */
  /**
   * THE KEY SURVIVES A RELOAD, because it is carried in the URL.
   *
   * It used to live only here, so a reload, a tab close or browser Back
   * discarded it — and a save that had COMMITTED and only lost its answer
   * then became a second treatment area when she re-entered the same
   * settings (Codex #860 4302218408). 0223 already dedupes on
   * `(session_id, idempotency_key)` alone, so nothing about the command or
   * the schema changes here; the key simply has to outlive the page.
   *
   * NOT SEEDED FROM THE URL. A resumed key is ADOPTED by the claim read
   * below, once it knows what happened, because a key whose claim may already
   * exist must not be live on a save before anything has checked.
   */
  const [pendingSaveKey, setPendingSaveKeyRaw] = useState<string | null>(null);
  /**
   * MIRRORED AT THE SETTER, not at the call sites.
   *
   * The key is dropped in two places and minted in a third, and the whole
   * mechanism fails silently if any one of them forgets the URL. Shadowing
   * the setter is the same answer this file already uses for `setDraft`, and
   * the same answer `canEditDraft(state, inFlight)` reached by a different
   * route: make the structure carry the rule instead of asking every caller
   * to remember it.
   */
  const setPendingSaveKey = (next: string | null) => {
    setPendingSaveKeyRaw(next);
    syncAreaOperationParam(next);
  };
  const [machineDraft, setMachineDraft] = useState<{
    groups: GroupSubmission[];
    blocking: string | null;
    identity: PendingSetupIdentity;
  } | null>(null);

  /**
   * The collector's report, plus the key's lifetime rule.
   *
   * A CHANGED DRAFT IS A DIFFERENT SAVE, so the open key is dropped and the
   * next attempt mints a new one. WHILE AN ATTEMPT IS UNRESOLVED it is kept
   * instead: that key is the retry's safety, and dropping it because a
   * remount reported an empty draft would turn the retry into a second area.
   */
  /**
   * A RESUMED SAVE WITH NOTHING TO SEND (Codex, #922 4305550889, P1).
   *
   * The retry key reaches `create_block_with_initial_setup` only inside
   * `initialSetup`, and a freshly reloaded form has an EMPTY machine draft —
   * so pressing Save here sent no key at all, took the ordinary
   * `create_block_with_entry` path, and created the second area this whole
   * mechanism exists to prevent. Keeping the key through draft changes, which
   * is what the previous round fixed, does not help when there is no
   * `initialSetup` for it to travel in.
   *
   * REQUIRING SETTINGS IS NOT A CONVENIENCE, it follows from what the
   * parameter means: `area_op` is only ever minted inside
   * `machineSetupForSave`, so a resumed operation ALWAYS had settings. A bare
   * save in this state is therefore a DIFFERENT save, and it is the one that
   * must not proceed unkeyed while the original may still be committing.
   *
   * Derived from `machineDraft` directly rather than from
   * `machineSetupForSave()`, because that function MINTS AND STORES a key —
   * calling it during render would set state from a render pass.
   */
  const hasSettingsToSend =
    machineDraft !== null && machineDraft.groups.length > 0;
  const resumedNeedsSettings =
    (resume.state === "absent" || resume.state === "unknown") &&
    !hasSettingsToSend;

  const onSettingDraftChanged = (
    next: {
      groups: GroupSubmission[];
      blocking: string | null;
      identity: PendingSetupIdentity;
    } | null,
  ) => {
    setMachineDraft(next);
    // NOT WHILE THE RESUMED QUESTION IS OPEN. The collector reports an EMPTY
    // draft on mount, which arrives BEFORE the claim read resolves — so
    // without this the mount report would clear the parameter out of the URL
    // for the width of the round trip, and a reload inside that window would
    // lose the save's identity. The in-flight read owns the key until it has
    // an answer.
    if (!saveUnresolved && !resumeOwnsKey) setPendingSaveKey(null);
  };

  /**
   * The settings to send with the area, or null.
   *
   * THE RETRY KEY IS MINTED HERE, ONCE PER SAVE, through `prepareHandoff` -
   * which also COPIES the groups, so a keystroke landing after the save began
   * cannot change what is recorded while the key still claims it is the same
   * save. A key minted per attempt would make every retry a new save; a key
   * that never changed would make a deliberate second capture impossible.
   */
  const machineSetupForSave = () => {
    const chosen = machineDraft;
    if (!chosen || chosen.groups.length === 0) return null;
    // THE IDENTITY COMES WITH THE DRAFT, from the report that produced it.
    //
    // That is safe only because every change of identity REPORTS - the
    // collector announces its remount with an empty draft, and the panel
    // clears this when no collector renders at all. Without those, a draft
    // typed under one machine could still be live after a switch and would be
    // saved under its own stale identity (Codex, db3373bc P1).
    const identity = chosen.identity;
    // ONE KEY PER SAVE, reused by every attempt at it. `prepareHandoff` still
    // mints through an injected function, so the module stays pure and a test
    // can pin the key; what changed is that the function returns the HELD one.
    const key = pendingSaveKey ?? crypto.randomUUID();
    if (key !== pendingSaveKey) setPendingSaveKey(key);
    const pending = prepareHandoff(identity, chosen.groups, () => key);
    if (!pending) return null;
    return {
      machineId: identity.deviceId,
      modeKey: identity.modeKey,
      idempotencyKey: pending.idempotencyKey,
      groups: pending.groups,
    };
  };
  // PR #191: inline feedback after "Copy settings" so the
  // practitioner knows what was copied and from where.
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  // 0156: stable id so the numbing-notes helper text is programmatically
  // connected to the textarea via aria-describedby.
  const numbingNotesHelpId = useId();
  // Treatment-area picker is collapsed to a compact summary when an area is
  // already selected (e.g. seeded from the plan, or in edit mode); the full
  // region-grouped picker only expands when there's no area yet or the
  // practitioner taps "Change".

  // Probe-lot auto-fill. Runs ONLY when the practitioner CHANGES the probe
  // (never on mount, so an edited block keeps its saved selection), and never
  // over a manual entry.
  //
  // THE DEFECT THIS FIXES. This used to consider ACTIVE INVENTORY ONLY. A studio
  // with no probe inventory therefore got `choose` on every probe pick, the lot
  // field was CLEARED, and the picker rendered "No active inventory lot for this
  // probe. Type the lot/batch manually…", even for a probe whose lot had been
  // charted many times. `resolveProbeLotSuggestion`, which resolves exactly that
  // recorded history, was exported and unit-tested but never called by any
  // application code; this file imported its module for the TYPE only.
  // resolveProbeLotAutofill now owns the whole precedence.
  const [lotStatus, setLotStatus] = useState<LotStatus>(() =>
    (block?.probe_lot_number ?? "").trim() !== "" &&
    (block?.probe_inventory_item_id ?? null) == null
      ? "manual"
      : null,
  );

  // Options (active + expired) for the currently selected probe.
  const probeOptions = useMemo(
    () => probeLotOptionsForProbe(probeLotInventory, draft.probeKey),
    [probeLotInventory, draft.probeKey],
  );

  useEffect(() => {
    // Same probe still selected → leave the field completely alone. This is what
    // lets a typed lot (or a copied one) survive any unrelated re-render: the
    // effect re-runs on every render, and every one of those runs exits here.
    if (draft.probeKey === lotOwnerProbeKey) return;
    // The probe CHANGED. Whatever was in the field belonged to the old probe, so
    // it is dropped unconditionally: manual, copied or auto-filled alike. A lot
    // is probe-specific; carrying one across a probe switch would attach it to a
    // probe it was never used on.
    const result = resolveProbeLotAutofill({
      probeKey: draft.probeKey,
      inventory: probeLotInventory,
      suggestions: probeLotSuggestions,
    });
    setLotOwnerProbeKey(draft.probeKey);
    setLotStatus(result.kind);
    const patch = probeLotDraftPatch(result);
    setDraft((d) => ({ ...d, ...patch }));
    // React to the PROBE changing, not our own writes (setDraft is stable).
  }, [draft.probeKey, lotOwnerProbeKey, probeLotInventory, probeLotSuggestions]);

  // "manual" is a form-local state (a saved manual lot on an edited block); the
  // resolver owns every auto-filled provenance string.
  const lotSourceMessage =
    lotStatus == null || lotStatus === "manual"
      ? null
      : lotStatus === "copied"
        ? // A copied lot is a transcription of another area's record, so say so
          // and say it still needs checking against the package in hand.
          "Copied with these settings: confirm the lot/batch on the package."
        : probeLotSourceMessage(lotStatus);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // PR #270: single area-change handler shared by the body map and the
  // list-below AreaPicker, so both write the same primary_area and clearing
  // the area also clears side + specifics (no orphan side).

  // "Copy settings from another area in this session" (PR #191 rework after
  // Chloe's smoke). Copies the reusable MACHINE SETUP a practitioner
  // expects: mode, modality, energy, machine frequency and probe.
  // Never the area identity (the practitioner chooses the new area
  // fresh), never MINUTES PERFORMED (an outcome of the treatment that
  // already happened: copying it silently overwrote destination
  // minutes already typed by hand), and never the client response
  // (tolerance / reaction / caution belong to the treatment that
  // already happened, not the one being set up). Area-aware: when a
  // treatment area is already selected and this session has a saved
  // area with the same name, that area's settings win over the most
  // recent one; the inline message says exactly what was copied.
  function copySettings() {
    const candidates = (savedBlocks && savedBlocks.length > 0
      ? savedBlocks
      : previousBlock
        ? [previousBlock]
        : []
    ).filter((b) => !block || b.id !== block.id);
    if (candidates.length === 0) {
      setCopyMessage("No previous treatment area to copy from.");
      return;
    }
    const wantedArea = draft.primaryArea.trim().toLowerCase();
    const areaMatch = wantedArea
      ? [...candidates]
          .reverse()
          .find((b) => (b.primary_area ?? "").trim().toLowerCase() === wantedArea)
      : undefined;
    const source = areaMatch ?? candidates[candidates.length - 1];
    // Full reusable setup via the shared snapshot contract: block machine
    // settings PLUS the primary (earliest live) entry's mode-gated machine
    // readings (thermolysis/galvanic/units-of-lye/pulse). Destination areas,
    // laterality, custom area detail, destination MINUTES and every outcome/
    // response field are preserved: the patch does not own those keys, and a
    // key it does not own cannot be overwritten by the spread below.
    //
    // The PROBE LOT is the deliberate exception, and an earlier version of this
    // comment wrongly claimed a manually typed destination lot survives. It does
    // NOT: the patch owns probeLotNumber, probeInventoryItemId and
    // probeLotConfirmed, so Copy settings REPLACES a lot already typed here with
    // the source's. That is intended: the lot belongs to the probe being copied
    // and it is made safe by never copying confirmation: the destination lot
    // always lands unconfirmed and the practitioner is asked to check it against
    // the package.
    const firstEntry = firstLiveEntry(source.electrolysis_entries);
    // The lot travels with the probe. Its inventory LINK is carried only when
    // the source's item is still CURRENT STOCK for the copied probe, so a copy
    // can never resurrect a link to an expired, reclassified or (migration
    // 0182) DISCARDED row. "Archived" was always the intent here; the discard
    // lifecycle finally makes it a structural fact rather than a hope.
    const linkable = new Set(
      activeProbeLotOptionsForProbe(
        probeLotInventory,
        source.probe_key ?? "",
      ).map((o) => o.id),
    );
    const patch = buildTreatmentSetupDraftPatch(source, firstEntry, linkable);
    setDraft((d) => ({ ...d, ...patch }));
    // Bind the copied lot to the copied probe, so the probe-change effect does
    // NOT then overwrite it with an unrelated historical suggestion. Selecting a
    // different probe afterwards still runs the normal resolver for that probe.
    setLotOwnerProbeKey(patch.probeKey);
    setLotStatus(patch.probeLotNumber.trim() !== "" ? "copied" : null);
    const sourceName = source.primary_area?.trim() || source.block_name?.trim();
    if (areaMatch) {
      setCopyMessage(
        `Copied settings from the ${sourceName ?? "matching"} area in this session.`,
      );
    } else if (wantedArea && sourceName) {
      setCopyMessage(
        `No earlier ${draft.primaryArea.trim()} settings in this session; copied from ${sourceName}.`,
      );
    } else {
      setCopyMessage(
        sourceName
          ? `Copied settings from ${sourceName} in this session.`
          : "Copied settings from the previous area in this session.",
      );
    }
  }

  function submit() {
    setError(null);
    // THE MACHINE DRAFT BLOCKS THE SAVE WHEN IT IS HALF-FINISHED, and says
    // which group and why. Skipping it would discard numbers she typed;
    // sending it would be refused by the command after a round trip.
    if (machineDraft?.blocking) {
      setError(machineDraft.blocking);
      return;
    }
    // AN UNRESOLVED INITIAL SAVE IS RETRYABLE, and this is where it used to be
    // refused: the form returned early and told her to reload the chart,
    // because a second attempt created a second treatment area. 0223's create
    // claim closed that, so the retry now proceeds and carries the same key.
    const el = draft.energyLevel.trim();
    const elNum = el === "" ? null : Number(el);
    if (el !== "" && (!Number.isFinite(elNum) || (elNum as number) < 0)) {
      setError("Energy level must be a non-negative number.");
      return;
    }
    const min = draft.minutes.trim();
    const minutesNum = min === "" ? null : parseInt(min, 10);
    if (
      min !== "" &&
      (!Number.isFinite(minutesNum) ||
        (minutesNum as number) < 0 ||
        (minutesNum as number) > MINUTES_MAX)
    ) {
      setError(`Minutes must be between 0 and ${MINUTES_MAX}.`);
      return;
    }
    const trimmedArea = draft.primaryArea.trim();
    if (trimmedArea.length > PRIMARY_AREA_MAX) {
      setError(`Treatment area must be ${PRIMARY_AREA_MAX} characters or fewer.`);
      return;
    }
    // PR 2: explicit custom-area intent. A non-empty area that isn't canonical
    // can only come from the picker's "Other" free-text path, so flag it so the
    // server accepts it as a deliberate custom area (not a typo/garbage).
    const areaIsCustom =
      trimmedArea.length > 0 && !isCanonicalTreatmentArea(trimmedArea);
    const trimmedDetail = draft.customAreaDetail.trim();
    if (trimmedDetail.length > CUSTOM_AREA_DETAIL_MAX) {
      setError(`Specifics must be ${CUSTOM_AREA_DETAIL_MAX} characters or fewer.`);
      return;
    }

    // Readings (the first pass). All optional except pulse, which defaults
    // to 1. Light client-side range checks; the action re-validates and
    // also nulls fields that don't apply to the chosen mode.
    const tInt = parseOptionalNumber(draft.thermolysisIntensityPercent, {
      int: true,
      min: 0,
      max: 100,
      label: "Thermolysis intensity",
    });
    if (!tInt.ok) return setError(tInt.error);
    // PR #165. Drop int: true so the parser preserves fractional
    // seconds like 0.15 / 0.2. Migration 0071 widened the DB
    // column to numeric so the round trip is now lossless.
    const tDur = parseOptionalNumber(draft.thermolysisDurationSeconds, {
      min: 0,
      label: "Thermolysis duration",
    });
    if (!tDur.ok) return setError(tDur.error);
    const gMa = parseOptionalNumber(draft.galvanicMa, {
      min: 0,
      label: "Galvanic mA",
    });
    if (!gMa.ok) return setError(gMa.error);
    const gDur = parseOptionalNumber(draft.galvanicDurationSeconds, {
      int: true,
      min: 0,
      label: "Galvanic duration",
    });
    if (!gDur.ok) return setError(gDur.error);
    // galvanic_intensity_percent is retired: not parsed, not validated, not sent.
    const ul = parseOptionalNumber(draft.unitsOfLye, {
      min: 0,
      label: "Units of lye",
    });
    if (!ul.ok) return setError(ul.error);
    const hairs = parseOptionalNumber(draft.hairsTreated, {
      int: true,
      min: 0,
      label: "Total hairs treated",
    });
    if (!hairs.ok) return setError(hairs.error);
    const pulseStr = draft.pulseCount.trim();
    const pulseCount = pulseStr === "" ? null : parseInt(pulseStr, 10);
    // Pulse delay is only recorded when multiple pulses were done. When
    // applicable, validate the range here so the practitioner gets the exact
    // message; the server re-validates (defense-in-depth).
    let pulseDelaySeconds: number | null = null;
    if (pulseCount != null && pulseCount > 1 && draft.pulseDelay.trim() !== "") {
      const pd = Number(draft.pulseDelay);
      if (!Number.isFinite(pd) || pd < PULSE_DELAY_MIN || pd > PULSE_DELAY_MAX) {
        return setError("Pulse delay must be between 0.03 and 1.90 seconds.");
      }
      pulseDelaySeconds = Math.round(pd * 100) / 100;
    }

    // PR #190: structured client response, shared by create + edit.
    const clinicalResponse = {
      toleranceRating: draft.toleranceRating
        ? parseInt(draft.toleranceRating, 10)
        : null,
      // Charting unification: the reaction is captured in the merged
      // observation_chips selection. PRESERVE a historical reaction_type while
      // its equivalent chip is still selected (so an unrelated edit never erases
      // it); clear it ONLY when the practitioner explicitly deselects that
      // reaction. Never invent/collapse a reaction_type from chips: a new
      // record keeps reaction_type NULL and lives entirely in observation_chips.
      reactionType:
        draft.reactionType &&
        isReactionType(draft.reactionType) &&
        isChipSelected(
          draft.observationChips,
          reactionTypeLabel(draft.reactionType as ReactionType),
        )
          ? draft.reactionType
          : null,
      reactionNotes: draft.reactionNotes.trim() || null,
      cautionForNextSession: draft.cautionForNextSession,
      cautionNote: draft.cautionNote.trim() || null,
      // PR #279: numbing record ("" -> Not recorded -> null in the action).
      numbingStatus: draft.numbingStatus || null,
      // 0156: optional numbing note. Always sent; the server keeps it only when
      // the saved status is "used" (else stores NULL). Held in draft across
      // status toggles so a mistaken toggle doesn't lose typed text.
      numbingNotes: draft.numbingNotes,
    };

    const readings = {
      thermolysisIntensityPercent: tInt.value,
      thermolysisDurationSeconds: tDur.value,
      galvanicMa: gMa.value,
      galvanicDurationSeconds: gDur.value,
      unitsOfLye: ul.value,
      pulseCount,
      pulseDelaySeconds,
      hairsTreated: hairs.value,
      comments: draft.comments,
      observationChips: draft.observationChips,
    };

    // COMPUTED ONCE PER ATTEMPT. Calling `machineSetupForSave()` again in
    // the catch would mint a SECOND retry key for the same save, which is the
    // defect the key exists to prevent.
    const attachedSetup = machineSetupForSave();
    startTransition(async () => {
      if (block) {
        // Edit: update the treatment area + its first entry's readings.
        // block_name/block_notes are preserved (the combined action never
        // writes them); entries 2..N are untouched.
        const res = await updateTreatmentAreaWithEntryAction({
          clientId,
          sessionId,
          blockId: block.id,
          firstEntryId: firstEntry?.id ?? null,
          // Optimistic concurrency: the version this form loaded (0129).
          expectedUpdatedAt: block.updated_at,
          mode: (draft.mode || null) as SessionMode | null,
          apilusModality: (draft.apilusModality || null) as
            | ApilusModality
            | null,
          energyLevel: elNum,
          minutesPerformed: minutesNum,
          probeOptionKey: draft.probeKey || null,
          probeLotNumber: draft.probeLotNumber.trim() || null,
          probeLotConfirmed: draft.probeLotConfirmed,
          probeInventoryItemId: draft.probeInventoryItemId,
          machineFrequency: (draft.machineFrequency || null) as
            | MachineFrequency
            | null,
          primaryArea: trimmedArea || null,
          side: draft.side || null,
          customAreaDetail: trimmedDetail || null,
          areaIsCustom,
          // Multi-area (0128): authoritative when non-empty; the action derives
          // the legacy primary_area/side projection from it.
          areas: draft.areas,
          readings,
          ...clinicalResponse,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        closeForm();
        return;
      }
      // Create: one save → treatment area + first entry. block_name omitted
      // (null), the section title falls back to the area, then a muted
      // placeholder.
      const res = await createTreatmentAreaWithEntryAction({
        clientId,
        sessionId,
        mode: (draft.mode || null) as ElectrolysisMode | null,
        apilusModality: (draft.apilusModality || null) as ApilusModality | null,
        energyLevel: elNum,
        minutesPerformed: minutesNum,
        probeOptionKey: draft.probeKey || null,
        probeLotNumber: draft.probeLotNumber.trim() || null,
        probeLotConfirmed: draft.probeLotConfirmed,
          probeInventoryItemId: draft.probeInventoryItemId,
        machineFrequency: (draft.machineFrequency || null) as
          | MachineFrequency
          | null,
        primaryArea: trimmedArea || null,
        side: draft.side || null,
        customAreaDetail: trimmedDetail || null,
        areaIsCustom,
        // Multi-area (0128): authoritative when non-empty.
        areas: draft.areas,
        readings,
        ...clinicalResponse,
        // THE SETTINGS, WHEN THERE ARE ANY. `prepareHandoff` mints the retry
        // key ONCE and copies the groups, so a keystroke after the save began
        // cannot change what is recorded while the key still claims it is the
        // same save. Null when nothing was entered, which is an ordinary save
        // of an area with no machine settings.
        initialSetup: attachedSetup,
      }).catch((cause: unknown) => {
        // THE TRANSPORT FAILED, so the server's answer is UNKNOWN - not
        // negative. The area may well have been created.
        //
        // AND HERE THE ADVICE IS THE OPPOSITE OF THE EDIT PATH'S. A save
        // against an existing block is safely retryable, because the
        // submission command recognises its retry key. This one creates the
        // block FIRST, so the key is scoped to a block that did not exist on
        // the first attempt: pressing Save again produces a SECOND treatment
        // area with a second copy of the settings. Proved against a real
        // database in tests/db/machine-initial-save.db.test.ts.
        //
        // So she is told to LOOK, and the control is held closed, rather than
        // being offered a retry that duplicates her treatment.
        return {
          ok: false as const,
          error: attachedSetup ? INITIAL_SAVE_UNRESOLVED : String(cause),
          unresolved: Boolean(attachedSetup),
        };
      });
      if (!res.ok) {
        setError(res.error);
        if ("unresolved" in res && res.unresolved) setSaveUnresolved(true);
        return;
      }
      // THE SAVE IS CLOSED. The next one is a different save and mints its own
      // key; keeping this one would make a deliberate second area look like a
      // retry of the first and be answered with it.
      setPendingSaveKey(null);
      setSaveUnresolved(false);
      closeForm();
    });
  }

  function bumpPulse(delta: number) {
    const current = parseInt(draft.pulseCount, 10);
    const base = Number.isFinite(current) ? current : PULSE_COUNT_DEFAULT;
    const next = Math.min(
      PULSE_COUNT_MAX,
      Math.max(PULSE_COUNT_MIN, base + delta),
    );
    update("pulseCount", String(next));
  }

  const mode = draft.mode;
  // Shared UI mode-gating (same helper the whole-session copy editor uses).
  const modeSections = resolveModeSections(mode);
  const showModality = modeSections.showModality;
  const modalityOptions =
    mode === "thermo"
      ? APILUS_MODALITIES_BY_MODE.thermo
      : mode === "blend"
        ? APILUS_MODALITIES_BY_MODE.blend
        : [];

  // PR #279 (Chloe charting feedback): OmniBlend-specific reading layout. For
  // OmniBlend the galvanic settings are charted BEFORE thermolysis, OmniBlend
  // thermolysis has no duration, and galvanic has no intensity. Other modalities
  // are intentionally NOT changed (pending Chloe's review of the rest). Hiding an
  // input never clears a stored value: an existing reading round-trips on save,
  // so historical OmniBlend records are not rewritten; new ones leave it empty.
  const isOmniblend = draft.apilusModality === "Omniblend";

  const thermoSection =
    modeSections.showThermo ? (
      <div className="flex flex-col gap-3">
        {mode === "blend" && (
          <SectionLabel>
            Thermolysis
          </SectionLabel>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {!isOmniblend && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Thermolysis duration (s)
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="0.001"
                min={0}
                value={draft.thermolysisDurationSeconds}
                onChange={(e) =>
                  update("thermolysisDurationSeconds", e.target.value)
                }
                className={READING_INPUT_CLS}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Thermolysis intensity %</span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min={0}
              max={100}
              value={draft.thermolysisIntensityPercent}
              onChange={(e) =>
                update("thermolysisIntensityPercent", e.target.value)
              }
              className={READING_INPUT_CLS}
            />
          </label>
        </div>
        {/* Pulse count is a THERMOLYSIS concept (Chloe): it lives inside the
            thermolysis section and is labeled "Thermolysis pulse count". Shown
            for thermolysis + blend (this section); pure galvanic has none. */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Thermolysis pulse count</span>
          <div className="flex items-stretch gap-2">
            <button
              type="button"
              onClick={() => bumpPulse(-1)}
              aria-label="Decrease thermolysis pulse count"
              className="rounded-md border border-neutral-300 px-4 text-lg font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min={PULSE_COUNT_MIN}
              max={PULSE_COUNT_MAX}
              value={draft.pulseCount}
              onChange={(e) => update("pulseCount", e.target.value)}
              className="w-20 rounded-md border border-neutral-300 bg-white px-3 py-3 text-center text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <button
              type="button"
              onClick={() => bumpPulse(1)}
              aria-label="Increase thermolysis pulse count"
              className="rounded-md border border-neutral-300 px-4 text-lg font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              +
            </button>
            <span className="self-center text-xs text-neutral-500">
              Pulses per hair (1 to {PULSE_COUNT_MAX}).
            </span>
          </div>
          {Number(draft.pulseCount) > 1 && (
            <div className="mt-2 flex flex-col gap-1.5">
              <span className="text-sm font-medium">Pulse delay</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={PULSE_DELAY_MIN}
                  max={PULSE_DELAY_MAX}
                  value={draft.pulseDelay}
                  onChange={(e) => update("pulseDelay", e.target.value)}
                  aria-label="Pulse delay in seconds"
                  className="w-24 rounded-md border border-neutral-300 bg-white px-3 py-3 text-center text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
                />
                <span className="text-sm text-neutral-500">seconds</span>
              </div>
              <span className="text-xs text-neutral-500">
                Time between high-frequency pulses ({PULSE_DELAY_MIN} to{" "}
                {PULSE_DELAY_MAX}s; default {PULSE_DELAY_DEFAULT}).
              </span>
            </div>
          )}
        </div>
      </div>
    ) : null;

  const galvSection =
    modeSections.showGalv ? (
      <div className="flex flex-col gap-3">
        {mode === "blend" && (
          <SectionLabel>
            Galvanic
          </SectionLabel>
        )}
        {/* MACHINE ORDER (Chloe): units of lye, then galvanic duration, then mA
            the order the Apilus shows them, so she can read straight down.
            The canonical list lives in lib/sessions/reading-field-order.ts. */}
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Units of lye (UL)</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0}
              value={draft.unitsOfLye}
              onChange={(e) => update("unitsOfLye", e.target.value)}
              className={READING_INPUT_CLS}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Galvanic duration (s)</span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min={0}
              value={draft.galvanicDurationSeconds}
              onChange={(e) =>
                update("galvanicDurationSeconds", e.target.value)
              }
              className={READING_INPUT_CLS}
            />
          </label>
          {/* Galvanic intensity % is a RETIRED input (Chloe / PicoBlend feedback).
              It is no longer captured, hydrated, or sent by this form. Historical
              values are preserved SERVER-SIDE: the update path omits the column, so
              editing a legacy galvanic entry never touches its recorded intensity;
              new entries always store NULL. No migration, no backfill. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Galvanic mA</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min={0}
              value={draft.galvanicMa}
              onChange={(e) => update("galvanicMa", e.target.value)}
              className={READING_INPUT_CLS}
            />
          </label>
        </div>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-5 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">
          {isEdit ? "Edit settings block" : "Add settings block"}
        </h3>
        {!isEdit && previousBlock && (
          <button
            type="button"
            onClick={copySettings}
            // Copying another area's settings REPLACES most of the payload,
            // so it is the largest possible edit under a held retry key.
            disabled={pending || draftFrozen}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Copy settings from another area in this session
          </button>
        )}
      </div>

      {/* MPX-03. Machine first: the exact model is chosen before the settings
          it governs, and the panel then shows that model's own fields under the
          machine's labels and units. It is a DISPLAY surface - it records
          nothing, and says so - so every field below remains the record and is
          untouched by it. No studio or practitioner id reaches this form, so
          identity is derived on the SERVER by machine-setup-actions.ts, which
          takes no studio or practitioner argument at all - so the client cannot
          name an owner, and cannot name the wrong one. See
          components/machines/machine-first-setup-connected.tsx.

          The block id is passed only when one EXISTS: a new settings block has
          no row yet, so there is nothing to record readings against and the
          panel shows the field contract read-only instead of inviting a value
          it would have to discard. */}
      <MachineFirstSetupConnected
        blockId={block?.id ?? null}
        clientId={clientId}
        sessionId={sessionId}
        // CREATE MODE ONLY. With no block there is nothing to record against,
        // so the panel hands its draft here and THIS form's Save carries it:
        // `create_block_with_initial_setup` writes the area and the settings
        // in one transaction. On an EXISTING block the panel records directly
        // and this is not supplied, so the two paths never both run.
        onSettingDraft={block ? undefined : onSettingDraftChanged}
        // THE MACHINE SETTINGS ARE PART OF THE SAME PAYLOAD. In create mode
        // the panel's draft is carried into THIS form's save, so the digest
        // covers it too and it has to freeze with everything else - the same
        // flag, not a second rule that could disagree.
        settingDraftFrozen={draftFrozen}
        // THE PANEL'S REVISION SAVE REACHES THIS FORM, so the Cancel button
        // below can be frozen by it (Codex, #860 4302176844).
        onRevisionUnresolved={setRevisionUnresolved}
      />

      {copyMessage && (
        <p className="text-xs text-neutral-600 dark:text-neutral-400" role="status">
          {copyMessage}
        </p>
      )}

      {/* Multi-area (0128): areas treated with these settings, each with its
          own laterality. Replaces the single-area picker; the server persists
          canonical session_block_areas rows + a legacy primary_area/side. */}
      <MultiAreaEditor
        value={draft.areas}
        onChange={(areas) => update("areas", areas)}
        idPrefix={`area-${block?.id ?? "new"}-${sessionId}`}
      />

      {/* Machine settings come after the area, in Chloe's charting
          order (PR #204): frequency (a property of the machine),
          then probe, then mode and the mode-specific modality.
          Minutes performed moved to the end, after the readings. */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Machine frequency</span>
        <div className="flex flex-wrap gap-2">
          {MACHINE_FREQUENCIES.map((f) => {
            const selected = draft.machineFrequency === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() =>
                  update("machineFrequency", selected ? "" : (f as string))
                }
                className={`rounded-full border px-4 py-2 text-sm transition ${
                  selected
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                }`}
              >
                {f}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Probe</span>
        <span className="text-xs text-neutral-500">
          Optional. Used for accurate electrolysis charting.
        </span>
        <ProbePicker
          value={draft.probeKey}
          onChange={(key) => update("probeKey", key)}
        />
        {/* PR #205 (migration 0085): lot/batch number off the probe
            box, required by the health-inspection client procedure
            record. Optional; saved on this treatment area.
            PR #279 (migration 0095): can be auto-suggested from the
            sterile-item records and CONFIRMED for this treatment. A
            suggestion is never saved as confirmed until the practitioner
            taps Confirm; typing always works and un-confirms. */}
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Probe lot/batch number</span>
          {/* Migration 0128 charting release: searchable ACTIVE probe-lot
              selector backed by the studio's sterile-item inventory. Manual
              entry always works (typing sets the value and is never replaced);
              selecting a lot fills the field. The SAVED value is still the
              free-text lot-number snapshot on session_blocks.probe_lot_number,
              no FK, so archiving/expiring a lot never rewrites past charting. */}
          <ProbeLotSelect
            value={draft.probeLotNumber}
            selectedInventoryItemId={draft.probeInventoryItemId}
            options={probeOptions}
            inventoryHref="/records?section=sterile"
            onSelectInventory={(option) => {
              // An explicit inventory selection: store the durable id + the
              // option's visible lot number, reset confirmation, NOT manual.
              setDraft((d) => ({
                ...d,
                probeInventoryItemId: option.id,
                probeLotNumber: option.lotNumber,
                probeLotConfirmed: false,
              }));
              // An explicit pick also binds the value to the current probe.
              setLotOwnerProbeKey(draft.probeKey);
              setLotStatus(null);
            }}
            onManualChange={(value) => {
              // Typing clears any inventory link and un-confirms. The value is
              // bound to the CURRENTLY selected probe: it survives every
              // unrelated re-render while that probe stays selected, and is
              // dropped the moment a different probe is chosen. Clearing it back
              // to empty drops the provenance line but keeps the binding, so the
              // field stays empty until she picks a different probe.
              setDraft((d) => ({
                ...d,
                probeInventoryItemId: null,
                probeLotNumber: value,
                probeLotConfirmed: false,
              }));
              // The typed value belongs to the probe selected RIGHT NOW.
              setLotOwnerProbeKey(draft.probeKey);
              setLotStatus(value.trim() !== "" ? "manual" : null);
            }}
          />
          {lotSourceMessage && (
            <span
              data-testid="probe-lot-source"
              className="text-xs text-neutral-600 dark:text-neutral-400"
            >
              {lotSourceMessage}
            </span>
          )}
          <span className="text-xs text-neutral-500">
            Used for health inspection and client procedure records.
          </span>
        </div>

        {/* Migration 0155: the inventory-backed lot source/status message
            (last-confirmed auto-fill / only-active / choose) is rendered
            immediately under the selector above; manual/linked state shows as a
            badge in the selector. */}

        {/* PR #279: confirm control + state. Only meaningful once a lot is
            present; confirmation is explicit (never automatic). */}
        {draft.probeLotNumber.trim() !== "" && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              aria-pressed={draft.probeLotConfirmed}
              onClick={() =>
                update("probeLotConfirmed", !draft.probeLotConfirmed)
              }
              className={
                draft.probeLotConfirmed
                  ? "rounded-full bg-emerald-600 px-3 py-1 font-medium text-white"
                  : "rounded-full border border-neutral-300 px-3 py-1 font-medium hover:border-neutral-500 dark:border-neutral-700"
              }
            >
              {draft.probeLotConfirmed
                ? "Confirmed ✓"
                : "Confirm lot/batch"}
            </button>
            {!draft.probeLotConfirmed && lotStatus === "manual" && (
              <span className="text-neutral-500">
                Lot/batch changed for this entry.
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Mode</span>
        <div className="flex flex-wrap gap-2">
          {ELECTROLYSIS_MODES.map((m) => {
            const selected = draft.mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => update("mode", selected ? "" : m.value)}
                className={`rounded-full border px-4 py-2 text-sm transition ${
                  selected
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {showModality && (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Modality</span>
          <select
            value={draft.apilusModality}
            onChange={(e) => {
              const next = e.target.value;
              setDraft((d) => ({
                ...d,
                apilusModality: next,
                // PR #279: OmniBlend has no thermolysis duration. Clear any value
                // typed under a different modality so a NEW OmniBlend record can't
                // persist a now-hidden reading. (Editing an existing OmniBlend
                // record seeds from the saved entry and fires no onChange, so its
                // history is preserved.) Galvanic intensity is retired everywhere,
                // so there is nothing to clear for it here.
                ...(next === "Omniblend"
                  ? { thermolysisDurationSeconds: "" }
                  : {}),
              }));
            }}
            className="max-w-sm rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">Select…</option>
            {modalityOptions.map((opt) => (
              <option key={opt} value={opt}>
                {apilusModalityLabel(opt)}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Treatment readings: the first pass, captured on this same page so
          there is no second form after saving. Mode-aware: thermolysis
          fields for thermolysis/blend, galvanic fields for galvanic/blend.
          All optional (pulse defaults to 1). Saved as the treatment area's
          first entry, keyed to the chosen area. */}
      <div className="flex flex-col gap-4 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <span className="text-sm font-medium">Treatment readings</span>

        {/* PR #279 (Chloe): energy level lives UNDER Treatment readings now (it
            used to sit near modality). Same energy_level column; UI move only. */}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Energy level (EL)</span>
          <input
            type="number"
            inputMode="decimal"
            step="1"
            min={0}
            value={draft.energyLevel}
            onChange={(e) => update("energyLevel", e.target.value)}
            className="max-w-[16rem] rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>

        {/* MACHINE ORDER (Chloe): the COMPLETE galvanic group precedes
            thermolysis for every blend modality: PicoBlend, OmniBlend,
            MultiBlend, EvoluBlend, SynchroBlend, not only OmniBlend as before.
            Pure modes render whichever single group applies. */}
        {galvSection}
        {thermoSection}

        <label className="flex flex-col gap-1.5 md:max-w-[16rem]">
          <span className="text-sm font-medium">Hairs treated</span>
          <input
            type="number"
            inputMode="numeric"
            step="1"
            min={0}
            value={draft.hairsTreated}
            onChange={(e) => update("hairsTreated", e.target.value)}
            placeholder="500"
            className={READING_INPUT_CLS}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Minutes performed (optional)</span>
        <input
          type="number"
          inputMode="numeric"
          step="1"
          min={0}
          max={MINUTES_MAX}
          value={draft.minutes}
          onChange={(e) => update("minutes", e.target.value)}
          className="max-w-[16rem] rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-xs text-neutral-500">
          Used for total treatment time if you track it.
        </span>
      </label>

      {/* PR #279 (migration 0095): numbing record: a factual note of whether
          the client used numbing before treatment. "Not recorded" (NULL) is the
          default. No advice / dosing / product guidance. */}
      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <span className="text-sm font-medium">Numbing</span>
        <div className="flex flex-wrap gap-2">
          {NUMBING_OPTIONS.map((opt) => {
            const selected = draft.numbingStatus === opt.value;
            return (
              <button
                key={opt.value || "not-recorded"}
                type="button"
                aria-pressed={selected}
                onClick={() => update("numbingStatus", opt.value)}
                className={
                  selected
                    ? "rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
                    : "rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {/* 0156: ONE optional free-text note, revealed ONLY when numbing was
            used. Factual, no dosing/timing/medical instructions. The draft
            value is retained across status toggles (so toggling back to "used"
            restores it); the server discards it unless the saved status is
            "used". Label wraps the textarea (accessible name) and the helper is
            connected via aria-describedby; full-width so it never overflows at
            390px; vertically resizable. */}
        {draft.numbingStatus === "used" && (
          <label className="flex flex-col gap-1">
            <SectionLabel>
              Numbing notes (optional)
            </SectionLabel>
            <textarea
              rows={3}
              value={draft.numbingNotes}
              onChange={(e) => update("numbingNotes", e.target.value)}
              data-testid="numbing-notes"
              aria-describedby={numbingNotesHelpId}
              placeholder="Record the product or any relevant details"
              className="w-full min-h-[5rem] resize-y rounded-md border border-neutral-300 bg-white px-3 py-3 text-base leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <span id={numbingNotesHelpId} className="text-xs text-neutral-500">
              Record the product or any relevant details.
            </span>
          </label>
        )}
      </div>

      {/* Client tolerance (PR #279): label-based comfort scale. The CONTROL is
          labels (the raw 1-5 was not intuitive), but the stored value is still
          the 1-5 smallint tolerance_rating, so every existing record maps
          cleanly. Factual comfort descriptions, no medical judgment. */}
      <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <div>
          <span className="text-sm font-medium">Client tolerance</span>
          <p className="text-xs text-neutral-500">
            Optional. How did the client tolerate this area?
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {TOLERANCE_OPTIONS.map((opt) => {
            const value = String(opt.value);
            const selected = draft.toleranceRating === value;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  update("toleranceRating", selected ? "" : value)
                }
                className={
                  selected
                    ? "rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
                    : "rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* UNIFIED (Chloe): "Treatment observations & skin response" is ONE box,
          a single MERGED multi-select chip list (observation presets + the former
          reaction labels). Everything is stored in observation_chips (the
          canonical multi column). A legacy session_blocks.reaction_type is folded
          into this selection on load (shown as a selected chip) and migrated into
          observation_chips on save: the value is preserved, never a separate
          single-select row. Multiple findings may be selected together. */}
      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <div>
          <span className="text-sm font-medium">
            {OBSERVATIONS_RESPONSE_HEADING}
          </span>
          <p className="text-xs text-neutral-500">
            {OBSERVATIONS_RESPONSE_HELPER}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {MERGED_OBSERVATION_CHIPS.map((c) => {
            const selected = isChipSelected(draft.observationChips, c);
            return (
              <button
                key={c}
                type="button"
                data-testid={`obs-chip-${c}`}
                aria-pressed={selected}
                onClick={() =>
                  update("observationChips", toggleFindingChip(draft.observationChips, c))
                }
                className={
                  selected
                    ? "rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
                    : "rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
                }
              >
                {selected ? c : `+ ${c}`}
              </button>
            );
          })}
        </div>
        {/* Chip confidence (Chloe): show exactly which findings are selected and
            will be saved, adjacent to the chips, so a tap visibly "takes". */}
        <SelectedObservations chips={draft.observationChips} />
        {/* Legacy per-area response note (reaction_notes): preserved + editable
            only when one already exists, so old data is never lost. */}
        {draft.reactionNotes.trim() !== "" && (
          <textarea
            rows={2}
            value={draft.reactionNotes}
            onChange={(e) => update("reactionNotes", e.target.value)}
            aria-label="Legacy response note"
            className="w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        )}
        {/* Additional notes, one large free-text box directly beneath the merged
            chip list. ~8 rows, >=12rem, full-width + vertically resizable, safe at
            390px; multiline preserved verbatim. */}
        <label className="flex flex-col gap-1">
          <SectionLabel>
            {ADDITIONAL_NOTES_HEADING}
          </SectionLabel>
          <textarea
            rows={8}
            value={draft.comments}
            onChange={(e) => update("comments", e.target.value)}
            data-testid="additional-notes"
            placeholder="Add any details not covered by the findings above"
            className="w-full min-h-[12rem] resize-y rounded-md border border-neutral-300 bg-white px-3 py-3 text-base leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <span className="text-xs text-neutral-500">
            {ADDITIONAL_NOTES_HELPER}
          </span>
        </label>
      </div>

      {/* PR #199 (Chloe iPad retest): the per-area next-visit and
          caution inputs are gone. The session-level note on the
          session page is the ONE place to write next-visit
          instructions (it can name specific areas). The draft still
          carries any previously saved caution flag/note and the save
          payload still round-trips them, so old area-level caution
          data is never lost and keeps rendering in the From last
          visit summaries. */}

      {/* THE RESUMED SAVE'S ANSWER (A1b, Codex #922 4305312331). A reload
          raises a question, not a retry: this is where it is answered, and
          "already saved" is a plain statement rather than an error. */}
      {resume.state === "saved" && (
        <div
          className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
          role="status"
          data-testid="initial-save-already-saved"
          data-block-id={resume.blockId}
        >
          <p>{INITIAL_SAVE_ALREADY_SAVED}</p>
          <button
            type="button"
            onClick={closeForm}
            className="mt-2 underline"
            data-testid="initial-save-already-saved-close"
          >
            Close
          </button>
        </div>
      )}

      {resumedNeedsSettings && (
        <p
          className="text-sm text-neutral-700 dark:text-neutral-300"
          role="status"
          data-testid="initial-save-resume-needs-settings"
        >
          {INITIAL_SAVE_RESUME_NEEDS_SETTINGS}
        </p>
      )}

      {resume.state === "checking" && (
        <p
          className="text-sm text-neutral-600 dark:text-neutral-400"
          role="status"
          data-testid="initial-save-resume-checking"
        >
          Checking whether this treatment area was already saved…
        </p>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <button
          type="button"
          onClick={submit}
          // HELD WHILE THE RESUMED QUESTION IS OPEN. Committing a second save
          // before the claim read lands is the one outcome this must not
          // allow, and once the answer is "saved" there is nothing to save.
          disabled={
            pending ||
            resume.state === "checking" ||
            resume.state === "saved" ||
            resumedNeedsSettings
          }
          data-testid="save-treatment-area"
          className="rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving…" : "Save settings block"}
        </button>
        {/*
          CANCEL IS FROZEN WHILE THE SAVE'S OUTCOME IS UNKNOWN
          (Codex, #860 4301633049).
          It was disabled only on `pending`, so the moment the lost response
          cleared `pending` this button was live again - and it is the one
          control that destroys the retry key rather than changing the
          payload. `onCancel` closes the form, `saveUnresolved` and
          `pendingSaveKey` go with it, and the next save mints a NEW key: if
          the first attempt had committed, that is a second immutable
          treatment area for one treatment.

          THIRD CONTROL, SAME INVARIANT. The draft setter was frozen in round
          5, the machine and mode pickers in round 12, and this is the
          dismissal. A control that can discard the key belongs inside the
          freeze the key depends on, whether it edits the payload or not.

          THE SAVE BUTTON STAYS LIVE, which is what keeps this from being a
          trap: pressing Save again, unchanged, is the recovery, and the
          message above says so.
        */}
        <button
          type="button"
          onClick={closeForm}
          // EITHER unresolved save freezes dismissal. Round 14 wired this
          // to `saveUnresolved` alone — the CREATE-mode flag — so on an
          // existing block, where the panel records directly, Cancel stayed
          // live through an unresolved REVISION save and unmounting the
          // entry discarded its retry key (Codex, #860 4302176844).
          // AND IT WAITS FOR A LOOKUP THAT IS ALREADY IN FLIGHT. Dismissing
          // the form mid-read would discard the answer; the read is one round
          // trip, so waiting costs her nothing and protects the identity
          // (Codex, #922 4305431336).
          disabled={
            pending ||
            saveUnresolved ||
            revisionUnresolved ||
            resume.state === "checking"
          }
          data-testid="cancel-treatment-area"
          className="rounded-md border border-neutral-300 px-5 py-3 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
