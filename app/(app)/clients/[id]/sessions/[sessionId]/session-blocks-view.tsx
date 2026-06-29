"use client";

import { useMemo, useState } from "react";
import type { ElectrolysisEntry, SessionBlock } from "@/lib/types/database";
import type {
  SessionBlockWithEntries,
  TreatmentParams,
} from "@/lib/supabase/queries";
import { ELECTROLYSIS_MODES, apilusModalityLabel } from "@/lib/constants";
import {
  isNumbingStatus,
  isReactionType,
  numbingStatusLabel,
  reactionTypeLabel,
  toleranceLabel,
} from "@/lib/sessions/clinical-response";
import { sessionBlockSideLabel } from "@/lib/sessions/side-labels";
import { ElectrolysisEntryRow } from "@/components/entry-row";
import { BlockSetupForm } from "./block-setup-form";
import { SimplifiedEntryForm } from "./simplified-entry-form";
import { deleteElectrolysisEntryAction } from "./actions";

// Area-first view of an electrolysis session (Session Logging Phase A).
// Each session_blocks row renders as a "treatment area" section; the word
// "block" is not shown to practitioners. The section title is the chosen
// area; settings + entries follow. The underlying schema and the
// create/update actions are unchanged.

// Section title precedence (presentation only — never mutates schema):
//   1. primary_area (+ side / specifics)   — the structured area
//   2. block_name                          — legacy free-text label
//   3. "Treatment area N" placeholder      — muted; no area chosen yet
function areaTitle(block: SessionBlock): { text: string; placeholder: boolean } {
  const area = block.primary_area?.trim();
  if (area && area.length > 0) {
    const extras: string[] = [];
    // PR #162. Render the user-facing label via the shared helper
    // so a saved record with side='bilateral' prints as "Both sides"
    // here too (matches the setup-form dropdown). "n/a" is filtered
    // separately because it is the explicit "side not applicable"
    // option and should not appear in the title suffix.
    if (block.side && block.side !== "n/a") {
      const label = sessionBlockSideLabel(block.side);
      if (label) extras.push(label);
    }
    const detail = block.custom_area_detail?.trim();
    if (detail && detail.length > 0) extras.push(detail);
    return {
      text: extras.length > 0 ? `${area} · ${extras.join(" · ")}` : area,
      placeholder: false,
    };
  }
  const name = block.block_name?.trim();
  if (name && name.length > 0) return { text: name, placeholder: false };
  return { text: `Treatment area ${block.sort_order}`, placeholder: true };
}

type Props = {
  sessionId: string;
  clientId: string;
  blocks: SessionBlockWithEntries[];
  orphanEntries: ElectrolysisEntry[];
  clientTagLabels?: ReadonlyArray<string>;
  // UI defaulting only: when creating a NEW treatment area, seed the area
  // picker with the attached treatment plan's primary_area (if any). The
  // practitioner can change it; never overrides their choice or saved data.
  defaultPrimaryArea?: string | null;
  // PR #203 (migration 0084): sticky machine frequency. Seeds NEW
  // treatment-area drafts from the practitioner's last-used value;
  // editable per area; the block row still stores the actual value.
  defaultMachineFrequency?: string | null;
  // PR #279 (Chloe charting feedback): latest current probe lot/batch from the
  // sterile-item records, offered as a confirmable suggestion (never auto-saved).
  suggestedProbeLot?: string | null;
};

export function SessionBlocksView({
  sessionId,
  clientId,
  blocks,
  orphanEntries,
  clientTagLabels = [],
  defaultPrimaryArea = null,
  defaultMachineFrequency = null,
  suggestedProbeLot = null,
}: Props) {
  // First empty treatment-area editor: when a session has no areas yet,
  // open the editor immediately so logging starts without an extra click.
  // No DB row is created until the practitioner saves.
  const [adding, setAdding] = useState(blocks.length === 0);
  const previousBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;

  return (
    <div className="flex flex-col gap-6">
      {blocks.map((block) => (
        <BlockSection
          key={block.id}
          block={block}
          sessionId={sessionId}
          clientId={clientId}
          clientTagLabels={clientTagLabels}
          suggestedProbeLot={suggestedProbeLot}
        />
      ))}

      {orphanEntries.length > 0 && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-5 dark:border-amber-700 dark:bg-amber-950/30">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
            Unassigned entries
          </h3>
          <p className="mt-1 text-xs text-amber-900 dark:text-amber-100">
            These entries do not belong to a treatment area. Edit each to
            assign it.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {orphanEntries.map((e) => (
              <li key={e.id}>
                <ElectrolysisEntryRow entry={e} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {adding ? (
        <BlockSetupForm
          sessionId={sessionId}
          clientId={clientId}
          previousBlock={previousBlock}
          savedBlocks={blocks}
          suggestedProbeLot={suggestedProbeLot}
          // PR #191 (Chloe smoke feedback): the plan-area seed applies
          // only to the FIRST treatment area of the session. Adding
          // another area starts blank; a new area is usually a
          // DIFFERENT area, and silently repeating the previous one
          // (chin -> chin when she wanted upper lip) fought her.
          defaultPrimaryArea={blocks.length === 0 ? defaultPrimaryArea : null}
          // PR #203: unlike the plan-area seed, the frequency seed
          // applies to EVERY new area; the machine rarely changes.
          defaultMachineFrequency={defaultMachineFrequency ?? null}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="self-start rounded-md border border-dashed border-neutral-300 px-4 py-3 text-sm font-medium text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          {blocks.length > 0 ? "+ Add another treatment area" : "+ Add treatment area"}
        </button>
      )}
    </div>
  );
}

function BlockSection({
  block,
  sessionId,
  clientId,
  clientTagLabels,
  suggestedProbeLot = null,
}: {
  block: SessionBlockWithEntries;
  sessionId: string;
  clientId: string;
  clientTagLabels: ReadonlyArray<string>;
  suggestedProbeLot?: string | null;
}) {
  const [editing, setEditing] = useState(false);
  // Extra passes are optional and collapsed by default — the first reading
  // is captured on the one-page treatment-area form, so this is only for
  // additional passes on the same area.
  const [addingPass, setAddingPass] = useState(false);

  const params: TreatmentParams = useMemo(
    () => ({
      mode: block.mode,
      apilus_modality: block.apilus_modality,
      energy_level: block.energy_level,
      minutes_performed: block.minutes_performed,
      probe_type: block.probe_type,
      probe_size: block.probe_size,
      machine_frequency: block.machine_frequency,
    }),
    [block],
  );

  const paramsLine = useMemo(() => {
    const parts: string[] = [];
    const mLabel = ELECTROLYSIS_MODES.find((m) => m.value === block.mode)?.label;
    if (mLabel) parts.push(mLabel);
    if (block.apilus_modality) parts.push(apilusModalityLabel(block.apilus_modality));
    if (block.energy_level != null) parts.push(`EL ${block.energy_level}`);
    if (block.machine_frequency) parts.push(block.machine_frequency);
    if (block.minutes_performed != null) {
      parts.push(`${block.minutes_performed} min`);
    }
    return parts.join(" · ");
  }, [block]);

  // Probe display (Session Logging Phase B). Prefer the structured probe
  // label (migration 0041); fall back to the legacy probe_type / probe_size
  // free text so older blocks still show their probe.
  const probeLine = useMemo(() => {
    // PR #205: append the lot/batch number wherever probe details
    // show, so the health-inspection lot is visible at a glance.
    // Null-lot blocks (all legacy rows) render exactly as before.
    // PR #279: show whether the practitioner confirmed the lot for this
    // treatment. Legacy rows (probe_lot_confirmed = false) read exactly as before.
    const lot = block.probe_lot_number?.trim()
      ? `Lot #${block.probe_lot_number.trim()}${
          block.probe_lot_confirmed ? " (confirmed)" : ""
        }`
      : null;
    if (block.probe_label) {
      return lot ? `${block.probe_label} · ${lot}` : block.probe_label;
    }
    const legacy: string[] = [];
    if (block.probe_type) legacy.push(block.probe_type);
    if (block.probe_size) legacy.push(block.probe_size);
    if (lot) legacy.push(lot);
    return legacy.length > 0 ? legacy.join(" · ") : null;
  }, [block]);

  const entriesSorted = useMemo(
    () =>
      [...block.electrolysis_entries].sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [block.electrolysis_entries],
  );

  const title = areaTitle(block);

  // New-flow (structured-area) blocks render entries flat (readings-only),
  // because the card header already shows the area + machine/probe summary.
  // Legacy blocks without a primary_area keep the full per-entry render.
  const flat = Boolean(block.primary_area && block.primary_area.trim().length > 0);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      {editing ? (
        <BlockSetupForm
          sessionId={sessionId}
          clientId={clientId}
          previousBlock={null}
          block={block}
          firstEntry={entriesSorted[0] ?? null}
          suggestedProbeLot={suggestedProbeLot}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            {/* PR #268 (chart parts): name the recorded treatment area, with
                an explicit "Area not recorded" eyebrow for legacy blocks that
                have no structured area. */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                {title.placeholder ? "Area not recorded" : "Recorded area"}
              </span>
              <h3
                className={
                  title.placeholder
                    ? "text-base font-normal text-neutral-400 dark:text-neutral-500"
                    : "text-lg font-medium"
                }
              >
                {title.text}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Edit
            </button>
          </div>

          {paramsLine && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {paramsLine}
            </p>
          )}

          {probeLine && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Probe: {probeLine}
            </p>
          )}

          {/* PR #279 (migration 0095): numbing record. Only renders when set;
              legacy rows (numbing_status NULL = Not recorded) show nothing. */}
          {isNumbingStatus(block.numbing_status) && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {numbingStatusLabel(block.numbing_status)}
            </p>
          )}

          {/* PR #190 (migration 0082): structured client response.
              Lines render only when recorded; legacy blocks show
              nothing here. */}
          {(block.tolerance_rating != null ||
            block.reaction_type ||
            block.reaction_notes) && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {[
                block.tolerance_rating != null
                  ? `Tolerance: ${toleranceLabel(block.tolerance_rating)}`
                  : null,
                isReactionType(block.reaction_type)
                  ? reactionTypeLabel(block.reaction_type)
                  : null,
                block.reaction_notes,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {(block.caution_for_next_session || block.caution_note) && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Caution for next session
              {block.caution_note ? `: ${block.caution_note}` : ""}
            </p>
          )}

          {entriesSorted.length === 0 ? (
            <p className="text-xs text-neutral-500">No entries yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entriesSorted.map((e, idx) => {
                // Flatten: for structured-area (new-flow) blocks, the card
                // header already shows the area + machine/probe summary, so
                // render entries as readings-only and suppress the area when
                // it just repeats the header. Legacy blocks (no primary_area,
                // e.g. backfilled "Main") keep the full row so their distinct
                // per-entry areas/params still show.
                const entryArea =
                  e.areas && e.areas.length > 0 ? e.areas.join(" · ") : e.area;
                const hideArea =
                  flat && entryArea === block.primary_area;
                return (
                  <li
                    key={e.id}
                    className={
                      // Light divider only BETWEEN stacked passes; the single
                      // (first) pass sits flush in the card with no rule.
                      idx > 0
                        ? "border-t border-neutral-100 pt-3 dark:border-neutral-800"
                        : undefined
                    }
                  >
                    <ElectrolysisEntryRow
                      entry={e}
                      treatmentParams={params}
                      block={block}
                      variant={flat ? "readings" : "full"}
                      hideArea={hideArea}
                      label={
                        flat && entriesSorted.length > 1
                          ? `Pass ${idx + 1}`
                          : undefined
                      }
                      action={
                        <form action={deleteElectrolysisEntryAction}>
                          <input type="hidden" name="id" value={e.id} />
                          <input type="hidden" name="session_id" value={sessionId} />
                          <input type="hidden" name="client_id" value={clientId} />
                          <button
                            type="submit"
                            aria-label="Delete entry"
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                          >
                            ✕
                          </button>
                        </form>
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}

          {addingPass ? (
            <div className="flex flex-col gap-2">
              <SimplifiedEntryForm
                block={block}
                sessionId={sessionId}
                clientId={clientId}
                clientTagLabels={clientTagLabels}
              />
              <button
                type="button"
                onClick={() => setAddingPass(false)}
                className="self-start text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
              >
                Done
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingPass(true)}
              className="self-start rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              + Add another pass
            </button>
          )}
        </>
      )}
    </section>
  );
}
