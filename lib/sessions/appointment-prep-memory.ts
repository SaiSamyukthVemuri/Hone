// APPOINTMENT PREPARATION MEMORY: the "what happened last time" view model
// rendered on the calendar appointment-detail screen, before the client arrives.
//
// WHY THIS EXISTS
// ---------------
// Three surfaces answer "what happened last time", at three different distances
// from the client:
//
//   /sessions/new                 buildLastSessionSummary , a five-second recap
//   the live charting screen      buildPointOfCareMemory  , the setup to reproduce
//   the appointment detail page   THIS MODULE             : the full pre-visit read
//
// The first two are deliberately compact: one is a glance before starting, the
// other is read over the client with a probe in hand. The appointment page is
// neither. Chloe opens it before the client walks in, and what she needs there
// is everything: every treated area, the complete per-area setup and outcome,
// and the whole practitioner narrative: WITHOUT opening the prior chart and
// WITHOUT entering Edit.
//
// So this module is the point-of-care memory PLUS the narrative that the
// point-of-care card deliberately reduces to an excerpt. It does not fork any
// display vocabulary to get there: areas, probe lines, mode-gated readings,
// tolerance, numbing, unified response labels and the blockless copy all come
// from buildPointOfCareMemory, which in turn takes them from the shared
// clinical helpers. The ONLY thing added here is the narrative layer.
//
// WHAT "NARRATIVE" MEANS HERE (audited against the schema AND the write paths;
// a column is included only when it is proven practitioner-authored treatment
// text belonging to THIS session):
//
//   sessions.session_notes                General notes.       LEGACY, no
//                                         writer survives, but it is the only
//                                         render of the column in the product
//                                         and the text can never be recreated.
//   sessions.next_session_note            For next visit.      LIVE.
//   session_blocks.caution_note           Caution.             LEGACY read.
//   session_blocks.reaction_notes         Response.            LEGACY read.
//   session_blocks.numbing_notes          Numbing.             LIVE.
//   electrolysis_entries.comments         Additional notes.    LIVE: the
//                                         highest-volume practitioner text in
//                                         the product, and invisible on every
//                                         memory surface until now.
//   laser_entries.observation_notes       Observation notes.   LIVE: the only
//                                         narrative a laser visit has.
//
// DELIBERATELY EXCLUDED, each for a stated reason:
//   observation_chips        structured; already rendered as response labels.
//   custom_area_detail       area identity, not narrative; current form writes NULL.
//   block_name               legacy heading; already the area-label fallback.
//   block_notes              dead, only ever written as literal null.
//   ejection_results         dead column: zero reads, zero writes in the app.
//   delete_reason (any)      deletion/audit metadata.
//   intake / consent / payment / cancellation / audit / relationship notes
//                            different records entirely; see Phase 4 of the brief.
//
// DUPLICATION IS PREVENTED STRUCTURALLY, not by eyeballing the render:
//   * Each note carries its SOURCE and its AREA. Two notes are the same note
//     only when source, area and text all match, so the identical sentence
//     recorded against two different areas keeps both, with provenance.
//   * next_session_note is a field of its own. If session_notes happens to hold
//     the same text, the general entry is dropped, not shown twice.
//   * The notes section is the SINGLE render authority for free text. The area
//     cards carry the same values on the model (so the outcome model is
//     complete and independently assertable) but render structured values only.
//     One text, one place on the page, which is also the only way ten areas of
//     narrative stay readable at 390px.
//
// Pure. No I/O. Client-safe.

import {
  buildPointOfCareMemory,
  type PointOfCareArea,
  type PointOfCareBlock,
  type PointOfCareEntry,
} from "@/lib/sessions/point-of-care-memory";
import { formatAreaLabel, resolveBlockAreas } from "@/lib/sessions/block-areas";

// The exact copy shown when the selected treatment carries no practitioner
// narrative at all. The section is NEVER suppressed: an absent section is
// indistinguishable from a failed query, and "did the notes not load?" is
// exactly the doubt this whole feature exists to remove.
export const NO_LAST_SESSION_NOTES_COPY =
  "No notes recorded at the last session.";

// The sentence the compact summary has always used for a caution FLAG carrying
// no note (lib/sessions/clinical-summary.ts / point-of-care-memory watchLines).
// Reused rather than reworded so the two surfaces cannot drift.
export const FLAGGED_TO_WATCH_COPY = "Flagged to watch.";

// Where a piece of narrative came from. Half of the dedup key, and the reason
// two areas can record the same sentence without either being swallowed.
export type NarrativeSource =
  | "session_notes"
  | "next_session_note"
  | "caution_note"
  | "reaction_notes"
  | "numbing_notes"
  | "entry_comments"
  | "laser_observation_notes";

// The practitioner-facing label for each source. Every string is the one the
// product already uses at the point of capture or of saved-record display,
// never a new vocabulary invented for this card.
export const NARRATIVE_SOURCE_LABELS: Readonly<Record<NarrativeSource, string>> =
  {
    // No writer survives; naming it "legacy" is the honest description and
    // mirrors the established "Legacy skin notes:" / "Legacy response note"
    // wording elsewhere in the product.
    session_notes: "Legacy session notes",
    next_session_note: "For next visit",
    caution_note: "Watch",
    reaction_notes: "Response",
    numbing_notes: "Numbing",
    // components/entry-row.tsx labels the saved value "Notes"; the capture
    // control is "Additional notes". The fuller capture-side label is used here
    // because this card is read far from the form that wrote it.
    entry_comments: "Additional notes",
    laser_observation_notes: "Observation notes",
  };

export type NarrativeItem = {
  // Stable React key AND stable test handle: "<source>:<areaKey>:<ordinal>".
  key: string;
  source: NarrativeSource;
  label: string;
  // The full stored text. Never truncated, never re-wrapped, never collapsed.
  text: string;
};

export type AreaNarrativeItem = NarrativeItem & {
  // The block id, or a synthetic id for session-level and laser narrative.
  areaKey: string;
  // "Left Cheek · Right Sideburn". Provenance, so an identical sentence
  // recorded against two areas stays attributable to both.
  areaLabel: string;
};

export type AppointmentPrepNotes = {
  general: NarrativeItem[];
  forNextVisit: NarrativeItem | null;
  // NOTE: no provenance field here any more. This slot now carries ONLY the
  // selected treatment's own plan, so the treatment header already supplies its
  // date. Narrative from any other visit is a separate, attributed surface,
  // see buildPrepProvenanceModel.
  cautions: AreaNarrativeItem[];
  additional: AreaNarrativeItem[];
  responses: AreaNarrativeItem[];
  hasAny: boolean;
};

// A treated area, complete. Every setup field and every outcome field the
// product records, kept as two named groups so "setup" and "what happened" are
// separable in the MODEL and not only in the layout.
export type AppointmentPrepArea = {
  key: string;
  areaLabel: string;
  // Each treated area as its own label: "Left Cheek", "Right Sideburn". The
  // joined areaLabel above is the heading; this is what proves a multi-area
  // block never collapses to its first area.
  areaParts: string[];
  passCount: number;
  setup: Pick<
    PointOfCareArea,
    | "modeLabel"
    | "modalityLabel"
    | "frequency"
    | "probeLine"
    | "energyLevel"
    | "readings"
  >;
  outcome: Pick<
    PointOfCareArea,
    | "minutes"
    | "hairs"
    | "numbing"
    | "toleranceLine"
    | "responseLine"
    | "responseNote"
    | "cautionNote"
    | "cautionFlag"
    | "notes"
  >;
  // True when NOTHING about the setup was recorded, so the card can say that
  // once instead of rendering an empty chip row.
  setupRecorded: boolean;
  // True when a LATER live pass recorded different machine readings from the
  // canonical (earliest) one.
  //
  // The readings shown come from the canonical pass: Session 1B's rule, shared
  // with the live charting card and with the in-form Copy settings control, and
  // deliberately not changed here. But this card's whole promise is that the
  // prior visit can be read without opening the chart, and silently showing
  // only the first pass of a session that ended somewhere else would break that
  // promise quietly. Chloe gets told to look, rather than misled.
  settingsChangedDuringSession: boolean;
  // True when any outcome value was recorded. An absent outcome reads as
  // absent; it is never fabricated into 0 hairs / 0 minutes / "no reaction".
  outcomeRecorded: boolean;
};

export type AppointmentPrepMemory = {
  sessionId: string;
  startedAt: string;
  modality: string;
  areaHeadline: string | null;
  totalMinutes: number | null;
  totalHairs: number | null;
  areas: AppointmentPrepArea[];
  notes: AppointmentPrepNotes;
  // Non-null ONLY when the selected visit is genuinely charted but carries no
  // settings blocks: a laser visit, or pre-0019 legacy electrolysis. Says what
  // the record IS; never "Area not recorded" about a visit that plainly
  // happened.
  blocklessNote: string | null;
  supersededByEmptySession: boolean;
};

// A piece of practitioner narrative recovered from the CANDIDATE WINDOW, with
// the visit it belongs to. Lives here (pure, client-safe) rather than in the
// server-only loader so both the loader and this module can name it.
export type PrepNarrativeItem = {
  sessionId: string;
  startedAt: string;
  text: string;
};

// One fallback narrative line, ready to render, with its provenance resolved.
export type PrepFallbackItem = {
  // Stable React key AND test handle.
  key: string;
  source: Extract<NarrativeSource, "next_session_note" | "session_notes">;
  label: string;
  text: string;
  sessionId: string;
  // The visit the text was written on. Rendered whenever the item does NOT
  // belong to the treatment shown above it, so a note from a later uncharted
  // visit is never read as part of that treatment.
  startedAt: string;
};

// THE PROVENANCE AUTHORITY, one pure function, exhaustively tested.
//
// Three repair cycles found defects in narrative ownership and provenance, each
// time because the decision was spread across a boolean here, a JSX branch
// there, and a chronology comparison somewhere else. It is settled here instead:
// the render receives a decision already made.
//
// TWO CONCEPTS, never merged:
//
//   A. Narrative belonging to the SELECTED TREATMENT. Session 1D promises the
//      complete practitioner narrative from that treatment, so a newer note
//      written on some other visit must never cause the treatment's own text to
//      disappear. Its own plan is historical treatment narrative and stays.
//
//   B. Narrative from ANOTHER eligible visit. A newer uncharted consultation
//      carrying "Client started doxycycline, do not treat" is not part of the
//      July treatment, and must not be shown as though it were, but it is
//      exactly what Chloe needs today, so it renders separately, attributed.
//
// PROVENANCE. Every item from a session other than the selected treatment
// carries its source date AND its chronological relationship. Chronology is the
// only relationship Hone can actually know: "before" and "after" are facts,
// whereas "current", "still applies", "supersedes", "completed" and "resolved"
// are inferences the data does not support, and none is ever emitted.
//
// The bug this closes: chronology was gated on `planAt > selectedAt`, so an
// OLDER plan rendered with NO date while the newer case always carried one,
// and that silence read as "written at the treatment above", inverting the
// status of an instruction that may already have been carried out.
//
// DEDUPLICATION is by SOURCE SEMANTIC + SESSION + normalized TEXT, never by
// text alone. The same sentence on two different visits is two historical
// facts; collapsing them would hide practitioner text. Only one visit that
// stored the same string in both of its own columns collapses.

export type NarrativeOwnership = "selected_treatment" | "external_visit";

export type NarrativeChronology =
  | "same"
  | "before_selected_treatment"
  | "after_selected_treatment";

export type PrepNarrativeRenderItem = {
  // Stable React key AND test handle: "<source>:<sessionId>".
  key: string;
  source: Extract<NarrativeSource, "next_session_note" | "session_notes">;
  label: string;
  text: string;
  sessionId: string;
  startedAt: string;
  ownership: NarrativeOwnership;
  chronology: NarrativeChronology;
};

export type PrepProvenanceModel = {
  // Rendered by the treatment card: the selected visit's own narrative.
  owned: PrepNarrativeRenderItem[];
  // Rendered separately, attributed: narrative from any other visit.
  external: PrepNarrativeRenderItem[];
};

function chronologyOf(
  itemStartedAt: string,
  selectedStartedAt: string | null,
): NarrativeChronology {
  if (selectedStartedAt == null) return "same";
  const a = new Date(itemStartedAt).getTime();
  const b = new Date(selectedStartedAt).getTime();
  // A malformed timestamp yields no claim rather than a false one.
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return "same";
  return a > b ? "after_selected_treatment" : "before_selected_treatment";
}

export function buildPrepProvenanceModel(input: {
  // The selected charted treatment, when one exists.
  selected: { sessionId: string; startedAt: string } | null;
  // The selected treatment's OWN stored narrative.
  ownPlan?: string | null;
  ownLegacyNotes?: string | null;
  // Narrative resolved from the candidate window; may belong to another visit.
  windowPlan?: PrepNarrativeItem | null;
  windowLegacyNotes?: PrepNarrativeItem | null;
}): PrepProvenanceModel {
  const selectedId = input.selected?.sessionId ?? null;
  const selectedAt = input.selected?.startedAt ?? null;
  const owned: PrepNarrativeRenderItem[] = [];
  const external: PrepNarrativeRenderItem[] = [];
  // source + session + normalized text, never text alone.
  const seen = new Set<string>();

  const push = (
    source: PrepNarrativeRenderItem["source"],
    sessionId: string,
    startedAt: string,
    raw: string | null | undefined,
  ) => {
    const text = trimmedOrNull(raw);
    if (!text) return;
    const identity = JSON.stringify([source, sessionId, text]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const ownership: NarrativeOwnership =
      selectedId != null && sessionId === selectedId
        ? "selected_treatment"
        : "external_visit";
    const item: PrepNarrativeRenderItem = {
      key: `${source}:${sessionId}`,
      source,
      label: NARRATIVE_SOURCE_LABELS[source],
      text,
      sessionId,
      startedAt,
      ownership,
      chronology:
        ownership === "selected_treatment"
          ? "same"
          : chronologyOf(startedAt, selectedAt),
    };
    (ownership === "selected_treatment" ? owned : external).push(item);
  };

  // The selected treatment's own narrative FIRST, so a same-visit duplicate in
  // the window collapses into the owned item rather than the other way round.
  if (input.selected) {
    push("next_session_note", input.selected.sessionId, input.selected.startedAt, input.ownPlan);
    push("session_notes", input.selected.sessionId, input.selected.startedAt, input.ownLegacyNotes);
  }

  const wp = input.windowPlan;
  if (wp) push("next_session_note", wp.sessionId, wp.startedAt, wp.text);
  const wl = input.windowLegacyNotes;
  if (wl) push("session_notes", wl.sessionId, wl.startedAt, wl.text);

  // ONE VISIT, ONE FACT: a single session that stored the identical string in
  // both next_session_note and session_notes recorded one thing twice. Scoped
  // to a single session on purpose: the same sentence on two different visits
  // stays two items, because the provenance differs.
  const collapse = (list: PrepNarrativeRenderItem[]) => {
    const plans = new Map<string, string>();
    for (const i of list) {
      if (i.source === "next_session_note") plans.set(i.sessionId, i.text);
    }
    return list.filter(
      (i) => !(i.source === "session_notes" && plans.get(i.sessionId) === i.text),
    );
  };

  return { owned: collapse(owned), external: collapse(external) };
}

// A laser pass, reduced to the two fields a prep surface reads.
export type PrepLaserEntry = {
  id?: string;
  deleted_at?: string | null;
  zone?: string | null;
  observation_notes?: string | null;
};

// An electrolysis pass that belongs to NO settings block. Pre-0019 electrolysis
// charted straight into electrolysis_entries, and 0019 added block_id as a
// NULLABLE column with ON DELETE SET NULL, so these rows exist, they are
// genuinely charted, and their `comments` are practitioner narrative that no
// block-shaped model can reach.
export type PrepOrphanEntry = {
  id?: string;
  deleted_at?: string | null;
  block_id?: string | null;
  area?: string | null;
  comments?: string | null;
  created_at?: string | null;
};

export type AppointmentPrepMemoryInput = {
  session: {
    id: string;
    started_at: string;
    modality: string;
    session_notes?: string | null;
    next_session_note?: string | null;
  };
  blocks: ReadonlyArray<PointOfCareBlock>;
  // Every laser pass on the selected session, live or soft-deleted. Filtering
  // happens HERE so a caller cannot forget it.
  laserEntries?: ReadonlyArray<PrepLaserEntry> | null;
  // Every electrolysis pass on the selected session, live or soft-deleted.
  // Only the ones with NO block_id are read: a pass that belongs to a block
  // already reaches the model through that block's area.
  electrolysisEntries?: ReadonlyArray<PrepOrphanEntry> | null;
  supersededByEmptySession?: boolean;
  // Whether the selected session has LIVE electrolysis entries. Consulted only
  // when there are no settings blocks, to tell a legacy entry-only
  // electrolysis visit apart from a laser one.
  hasLiveElectrolysisEntries?: boolean;
};

function trimmedOrNull(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t && t.length > 0 ? t : null;
}

// The dedup identity of a note: source + area + exact text.
//
// Text is compared on its TRIMMED value only. It is deliberately NOT normalised
// further, no case folding, no whitespace collapsing, no punctuation
// stripping. Two clinical notes that differ by a line break or by capitalisation
// are two different notes, and the practitioner wrote both.
function noteIdentity(
  source: NarrativeSource,
  areaKey: string,
  text: string,
): string {
  // JSON, not string concatenation: a note body may legitimately contain any
  // character, so a plain separator could let two different notes collide into
  // one identity and silently drop the second.
  return JSON.stringify([source, areaKey, text]);
}

// Collects narrative while enforcing the identity rule above. A caller cannot
// forget to dedup, and cannot dedup on text alone.
class NarrativeCollector {
  private seen = new Set<string>();
  private counter = 0;

  add(
    source: NarrativeSource,
    areaKey: string,
    areaLabel: string,
    raw: string | null | undefined,
  ): AreaNarrativeItem | null {
    const text = trimmedOrNull(raw);
    if (!text) return null;
    const identity = noteIdentity(source, areaKey, text);
    if (this.seen.has(identity)) return null;
    this.seen.add(identity);
    this.counter += 1;
    return {
      key: `${source}:${areaKey}:${this.counter}`,
      source,
      label: NARRATIVE_SOURCE_LABELS[source],
      text,
      areaKey,
      areaLabel,
    };
  }
}

// The pure note-section helper. It OWNS source identity, grouping, labels,
// deduplication and the empty-state decision, nothing about narrative is
// decided in a component.
export function buildLastSessionNoteSections(input: {
  session: { session_notes?: string | null; next_session_note?: string | null };
  areas: ReadonlyArray<AppointmentPrepArea>;
  laserEntries?: ReadonlyArray<PrepLaserEntry> | null;
  electrolysisEntries?: ReadonlyArray<PrepOrphanEntry> | null;
  // sessionId identifies the SELECTED treatment, so a plan belonging to a later
  // session can be labelled as such.
  sessionId?: string | null;
}): AppointmentPrepNotes {
  const collect = new NarrativeCollector();
  const SESSION_KEY = "session";

  // "For next visit" is claimed FIRST, so that if session_notes happens to hold
  // the identical text it is the generic copy that drops, not the specific one.
  // The SELECTED TREATMENT'S OWN plan. It is historical treatment narrative and
  // is never replaced by a note from another visit: Session 1D promises the
  // complete narrative from this treatment, and a later consultation adding an
  // instruction does not erase what July recorded. An external plan renders on
  // its own attributed surface instead.
  const planText = trimmedOrNull(input.session.next_session_note);
  const forNextVisit = collect.add(
    "next_session_note",
    SESSION_KEY,
    "",
    planText,
  );
  const general: NarrativeItem[] = [];
  const sessionNotes = trimmedOrNull(input.session.session_notes);
  // Same text under a different source is still the same sentence on the page.
  // The plan already carries it, so the general copy is dropped rather than
  // printed twice under two headings.
  if (sessionNotes && sessionNotes !== planText) {
    const item = collect.add(
      "session_notes",
      SESSION_KEY,
      "",
      sessionNotes,
    );
    if (item) general.push(item);
  }

  const cautions: AreaNarrativeItem[] = [];
  const responses: AreaNarrativeItem[] = [];
  const additional: AreaNarrativeItem[] = [];

  for (const area of input.areas) {
    // A block can be flagged to watch with NO note. The compact summary has
    // always rendered that as "<area>: flagged to watch.", dropping it here
    // would demote a safety flag to an unstyled chip below the fold.
    const caution = collect.add(
      "caution_note",
      area.key,
      area.areaLabel,
      area.outcome.cautionNote
        ?? (area.outcome.cautionFlag ? FLAGGED_TO_WATCH_COPY : null),
    );
    if (caution) cautions.push(caution);

    const response = collect.add(
      "reaction_notes",
      area.key,
      area.areaLabel,
      area.outcome.responseNote,
    );
    if (response) responses.push(response);

    const numbing = collect.add(
      "numbing_notes",
      area.key,
      area.areaLabel,
      area.outcome.numbing?.note ?? null,
    );
    if (numbing) additional.push(numbing);

    for (const note of area.outcome.notes) {
      const item = collect.add(
        "entry_comments",
        area.key,
        area.areaLabel,
        note,
      );
      if (item) additional.push(item);
    }
  }

  // A pre-0019 electrolysis pass carries no block_id, so its narrative reaches
  // no area and would otherwise be invisible behind the blockless copy: the
  // card would print "No notes recorded at the last session." over text the
  // practitioner had written. Grouped by the entry's own `area` column.
  //
  // Passes that DO belong to a block are skipped: they already arrived through
  // that block's area, and emitting them here would render each one twice.
  // "Orphan" means NO SURVIVING AREA, not merely a null block_id. A block can
  // be soft-deleted while its entries stay live and keep pointing at it
  // (soft_delete_session_block, 0166, deliberately does not cascade), and the
  // block read filters deleted blocks out. Those entries would otherwise fall
  // through both channels and the card would claim there were no notes.
  const renderedBlockIds = new Set(input.areas.map((a) => a.key));
  const orphans = [...(input.electrolysisEntries ?? [])]
    .filter(
      (e) =>
        e.deleted_at == null
        && (!e.block_id || !renderedBlockIds.has(e.block_id)),
    )
    .sort((a, b) => {
      const ac = a.created_at ?? "";
      const bc = b.created_at ?? "";
      return ac < bc ? -1 : ac > bc ? 1 : 0;
    });
  for (const entry of orphans) {
    const area = trimmedOrNull(entry.area);
    const item = collect.add(
      "entry_comments",
      area ? `entry:${area.toLowerCase()}` : "entry:unassigned",
      area ?? "Recorded without a treatment area",
      entry.comments,
    );
    if (item) additional.push(item);
  }

  // A laser visit has no settings blocks, so its narrative would otherwise be
  // invisible behind the blockless copy. Grouped by ZONE, which is the laser
  // equivalent of an area.
  for (const entry of input.laserEntries ?? []) {
    if (entry.deleted_at != null) continue;
    const zone = trimmedOrNull(entry.zone) ?? "Laser";
    const item = collect.add(
      "laser_observation_notes",
      // Zone-scoped, so two passes on the same zone dedup against each other
      // but the same sentence on two zones keeps both.
      `laser:${zone.toLowerCase()}`,
      zone,
      entry.observation_notes,
    );
    if (item) additional.push(item);
  }

  return {
    general,
    forNextVisit,
    cautions,
    additional,
    responses,
    hasAny:
      general.length > 0
      || forNextVisit != null
      || cautions.length > 0
      || additional.length > 0
      || responses.length > 0,
  };
}

// Split one point-of-care area into the explicit setup / outcome halves.
// The reading fields whose divergence between passes actually matters. Block
// -level values (energy level, frequency, probe) cannot differ per pass.
const PASS_READING_FIELDS = [
  "thermolysis_intensity_percent",
  "thermolysis_duration_seconds",
  "galvanic_ma",
  "galvanic_duration_seconds",
  "units_of_lye",
  "pulse_count",
  "pulse_delay_seconds",
] as const;

function readingsDiverge(
  entries: ReadonlyArray<PointOfCareEntry> | null | undefined,
): boolean {
  const live = (entries ?? []).filter((e) => e.deleted_at == null);
  if (live.length < 2) return false;
  const ordered = [...live].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
  const canonical = ordered[0];
  const norm = (v: unknown) => (v == null ? null : Number(v));
  return ordered
    .slice(1)
    .some((e) =>
      PASS_READING_FIELDS.some((f) => norm(e[f]) !== norm(canonical[f])),
    );
}

function toPrepArea(
  area: PointOfCareArea,
  areaParts: string[],
  entries: ReadonlyArray<PointOfCareEntry> | null | undefined,
): AppointmentPrepArea {
  const passCountOf = area.passCount;
  const setup = {
    modeLabel: area.modeLabel,
    modalityLabel: area.modalityLabel,
    frequency: area.frequency,
    probeLine: area.probeLine,
    energyLevel: area.energyLevel,
    readings: area.readings,
  };
  const outcome = {
    minutes: area.minutes,
    hairs: area.hairs,
    numbing: area.numbing,
    toleranceLine: area.toleranceLine,
    responseLine: area.responseLine,
    responseNote: area.responseNote,
    cautionNote: area.cautionNote,
    cautionFlag: area.cautionFlag,
    notes: area.notes,
  };
  return {
    key: area.key,
    areaLabel: area.areaLabel,
    areaParts,
    passCount: area.passCount,
    setup,
    outcome,
    setupRecorded:
      setup.modeLabel != null
      || setup.modalityLabel != null
      || setup.frequency != null
      || setup.probeLine != null
      || setup.energyLevel != null
      || setup.readings.length > 0,
    settingsChangedDuringSession: readingsDiverge(entries),
    // NOTE the explicit null checks. A recorded `minutes: 0` is a real value
    // and a truthiness test would report it as "not recorded".
    //
    // `hairs: 0` is NOT currently reachable: Session 1B's buildArea sums with
    // `if (h != null && h > 0)`, so a pass recording zero hairs yields null.
    // That rule is shared with the live charting card, so changing it is a 1B
    // contract change and out of scope here: stated rather than implied,
    // because the null check below would otherwise read as covering it.
    outcomeRecorded:
      outcome.minutes != null
      || outcome.hairs != null
      || outcome.numbing != null
      || outcome.toleranceLine != null
      || outcome.responseLine != null
      || outcome.responseNote != null
      || outcome.cautionNote != null
      || outcome.cautionFlag
      // A pass count and a pass note are both recorded outcomes. Omitting them
      // printed "Not recorded" under an area whose own narrative sat a few
      // hundred pixels below on the same card.
      || outcome.notes.length > 0
      || passCountOf > 0,
  };
}

export function buildAppointmentPrepMemory(
  input: AppointmentPrepMemoryInput,
): AppointmentPrepMemory {
  // Setup + outcome come from the SHARED builder, unchanged. Nothing about
  // areas, probes, readings, tolerance, numbing, response labels or the
  // blockless copy is re-derived here.
  const memory = buildPointOfCareMemory({
    session: {
      id: input.session.id,
      started_at: input.session.started_at,
      modality: input.session.modality,
      next_session_note: input.session.next_session_note ?? null,
    },
    blocks: input.blocks,
    supersededByEmptySession: input.supersededByEmptySession,
    hasLiveElectrolysisEntries: input.hasLiveElectrolysisEntries,
  });

  // Per-area labels, in the SAME order buildPointOfCareMemory produced. Keyed
  // by block id rather than zipped by index, so the two can never drift.
  const partsByKey = new Map<string, string[]>();
  for (const block of input.blocks) {
    partsByKey.set(block.id, areaPartsFor(block));
  }

  const entriesByKey = new Map<string, ReadonlyArray<PointOfCareEntry>>();
  for (const b of input.blocks) entriesByKey.set(b.id, b.entries ?? []);

  const areas = memory.areas.map((a) =>
    toPrepArea(a, partsByKey.get(a.key) ?? [a.areaLabel], entriesByKey.get(a.key)),
  );

  return {
    sessionId: memory.sessionId,
    startedAt: memory.startedAt,
    modality: memory.modality,
    areaHeadline: memory.areaHeadline,
    totalMinutes: memory.totalMinutes,
    totalHairs: memory.totalHairs,
    areas,
    notes: buildLastSessionNoteSections({
      session: input.session,
      areas,
      laserEntries: input.laserEntries,
      electrolysisEntries: input.electrolysisEntries,
      sessionId: memory.sessionId,
    }),
    blocklessNote: memory.blocklessNote,
    supersededByEmptySession: memory.supersededByEmptySession,
  };
}

// Every treated area of one block, each as its own display label. The shared
// resolver decides structured-vs-legacy; this only declines to join them.
function areaPartsFor(block: PointOfCareBlock): string[] {
  const areas = resolveBlockAreas(block.structured_areas, {
    primary_area: block.primary_area,
    side: block.side,
  });
  if (areas.length > 0) return areas.map(formatAreaLabel);
  const legacyName = trimmedOrNull(block.block_name);
  return legacyName ? [legacyName] : [];
}

// ---------------------------------------------------------------------------
// THE ONE MAPPING from a loaded treatment to this model's input.
// ---------------------------------------------------------------------------
//
// Both surfaces that show a previous treatment: the calendar appointment page
// and the Today row: need the same fifteen lines of "which loaded field feeds
// which model field", including the two that are easy to get quietly wrong:
// the legacy `session_notes` passthrough, and `hasLiveElectrolysisEntries`,
// which is what tells a pre-0019 entry-only electrolysis visit apart from a
// laser one when there are no blocks.
//
// It lives here, once. A second copy is how two surfaces start disagreeing
// about what a visit looked like, and the disagreement would be invisible,
// because both would still render something plausible.
//
// Structurally typed on purpose: this module is pure and client-safe, so it
// must not import the server-only loader to name its return type.
export function prepMemoryInputFromTreatment(selected: {
  session: {
    id: string;
    started_at: string;
    modality: string;
    session_notes?: string | null;
    next_session_note?: string | null;
    laser_entries?: ReadonlyArray<PrepLaserEntry> | null;
    electrolysis_entries?: ReadonlyArray<PrepOrphanEntry> | null;
  };
  blocks: ReadonlyArray<PointOfCareBlock>;
  supersededByEmptySession: boolean;
}): AppointmentPrepMemoryInput {
  return {
    session: {
      id: selected.session.id,
      started_at: selected.session.started_at,
      modality: selected.session.modality,
      // Legacy, and the only render of this column anywhere in the product:
      // sessions.session_notes has no surviving writer, so the text on existing
      // rows can never be recreated once a surface stops showing it.
      session_notes: selected.session.session_notes ?? null,
      next_session_note: selected.session.next_session_note ?? null,
    },
    blocks: selected.blocks,
    laserEntries: selected.session.laser_entries ?? null,
    // Pre-0019 electrolysis charted straight into entries with no block, so
    // this is the ONLY channel that narrative has. Passes that do belong to a
    // block arrive through that block instead and are skipped there.
    electrolysisEntries: selected.session.electrolysis_entries ?? null,
    supersededByEmptySession: selected.supersededByEmptySession,
    hasLiveElectrolysisEntries: (
      selected.session.electrolysis_entries ?? []
    ).some((e) => e.deleted_at == null),
  };
}
