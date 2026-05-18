"use client";

import { useMemo, useState, useTransition } from "react";
import type {
  ElectrolysisEntry,
  SessionBlock,
} from "@/lib/types/database";
import type {
  SessionBlockWithEntries,
  TreatmentParams,
} from "@/lib/supabase/queries";
import { ELECTROLYSIS_MODES } from "@/lib/constants";
import { ElectrolysisEntryRow } from "@/components/entry-row";
import { BlockSetupForm } from "./block-setup-form";
import { SimplifiedEntryForm } from "./simplified-entry-form";
import { updateSessionBlockAction } from "./block-actions";
import { deleteElectrolysisEntryAction } from "./actions";

// Renders the block-grouped view of a session. Treatment params are computed
// once per (entry, block) pair and passed to ElectrolysisEntryRow as props so
// the row itself does not call the resolver. The override badge is wired by
// passing the block alongside.
//
// Single-block sessions hide the block name entirely. Multi-block sessions
// render block_name if set, else "Treatment N" where N is sort_order.

type Props = {
  sessionId: string;
  clientId: string;
  blocks: SessionBlockWithEntries[];
  orphanEntries: ElectrolysisEntry[];
  clientTagLabels?: ReadonlyArray<string>;
};

export function SessionBlocksView({
  sessionId,
  clientId,
  blocks,
  orphanEntries,
  clientTagLabels = [],
}: Props) {
  const [setupOpen, setSetupOpen] = useState(false);
  const isMulti = blocks.length > 1;
  const previousBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;

  return (
    <div className="flex flex-col gap-6">
      {blocks.map((block) => (
        <BlockSection
          key={block.id}
          block={block}
          showName={isMulti}
          sessionId={sessionId}
          clientId={clientId}
          clientTagLabels={clientTagLabels}
        />
      ))}

      {orphanEntries.length > 0 && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-5 dark:border-amber-700 dark:bg-amber-950/30">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
            Unassigned entries
          </h3>
          <p className="mt-1 text-xs text-amber-900 dark:text-amber-100">
            These entries do not belong to a block. Edit each to assign it.
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

      {setupOpen ? (
        <BlockSetupForm
          sessionId={sessionId}
          clientId={clientId}
          previousBlock={previousBlock}
          onCancel={() => setSetupOpen(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setSetupOpen(true)}
          className="self-start rounded-md border border-dashed border-neutral-300 px-4 py-3 text-sm font-medium text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          + Start new block
        </button>
      )}
    </div>
  );
}

function BlockSection({
  block,
  showName,
  sessionId,
  clientId,
  clientTagLabels,
}: {
  block: SessionBlockWithEntries;
  showName: boolean;
  sessionId: string;
  clientId: string;
  clientTagLabels: ReadonlyArray<string>;
}) {
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
    if (block.apilus_modality) parts.push(block.apilus_modality);
    if (block.energy_level != null) parts.push(`EL ${block.energy_level}`);
    if (block.machine_frequency) parts.push(block.machine_frequency);
    if (block.probe_type) parts.push(block.probe_type);
    if (block.probe_size) parts.push(block.probe_size);
    return parts.join(" · ");
  }, [block]);

  const entriesSorted = useMemo(
    () =>
      [...block.electrolysis_entries].sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [block.electrolysis_entries],
  );

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      {showName && (
        <BlockHeader
          block={block}
          clientId={clientId}
          sessionId={sessionId}
        />
      )}
      {paramsLine && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {paramsLine}
        </p>
      )}

      {entriesSorted.length === 0 ? (
        <p className="text-xs text-neutral-500">No entries yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entriesSorted.map((e) => (
            <li key={e.id}>
              <ElectrolysisEntryRow
                entry={e}
                treatmentParams={params}
                block={block}
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
          ))}
        </ul>
      )}

      <SimplifiedEntryForm
        block={block}
        sessionId={sessionId}
        clientId={clientId}
        clientTagLabels={clientTagLabels}
      />
    </section>
  );
}

function BlockHeader({
  block,
  clientId,
  sessionId,
}: {
  block: SessionBlock;
  clientId: string;
  sessionId: string;
}) {
  const fallback = `Treatment ${block.sort_order}`;
  const displayName =
    block.block_name && block.block_name.trim().length > 0
      ? block.block_name
      : fallback;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.block_name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    const next = draft.trim();
    setError(null);
    startTransition(async () => {
      const res = await updateSessionBlockAction({
        clientId,
        sessionId,
        blockId: block.id,
        patch: { block_name: next.length === 0 ? null : next },
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEditing(false);
    });
  }

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(block.block_name ?? "");
              setError(null);
            }
          }}
          placeholder={fallback}
          maxLength={60}
          className="flex-1 min-w-[12rem] rounded-md border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setDraft(block.block_name ?? "");
            setError(null);
          }}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700"
        >
          Cancel
        </button>
        {error && <p className="w-full text-xs text-red-700">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h3 className="text-lg font-medium">{displayName}</h3>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        Edit name
      </button>
    </div>
  );
}
