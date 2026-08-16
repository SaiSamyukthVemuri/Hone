"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import {
  filterProbeLotOptions,
  isCurrentStock,
  probeLotOptionLabel,
  PROBE_LOT_LABEL_DELIMITER,
  type ProbeLotOption,
} from "@/lib/record-keeping/probe-lot-inventory";

// Searchable inventory-backed probe-lot selector for the charting form
// (Chloe item #9, migration 0155). Backed by the studio's
// record_keeping_sterile_items probe inventory for the SELECTED probe.
//
// Contract:
//   * MANUAL ENTRY is always available and a typed value is never silently
//     replaced: typing calls onManualChange and clears any inventory link.
//   * Selecting a row calls onSelectInventory(option), the durable link is the
//     inventory row `id`, never the lot number. Selected identity + React keys
//     use the id, so two rows sharing a lot number stay distinct.
//   * The dropdown lists ACTIVE (non-expired) lots by default; typing searches
//     the FULL set so an expired historical lot is still findable, flagged
//     "Expired" (never auto-filled, never sorted ahead of active).
//   * Studio isolation + probe_key filtering are enforced upstream (options are
//     already studio-scoped and probe-specific); this component only renders.
type Props = {
  value: string; // the displayed lot NUMBER (manual text or a linked lot's number)
  selectedInventoryItemId: string | null; // the linked inventory id (null = manual)
  options: ReadonlyArray<ProbeLotOption>; // options for the selected probe (active + expired)
  onSelectInventory: (option: ProbeLotOption) => void;
  onManualChange: (value: string) => void;
  inventoryHref: string;
  placeholder?: string;
  inputId?: string;
};

export function ProbeLotSelect({
  value,
  selectedInventoryItemId,
  options,
  onSelectInventory,
  onManualChange,
  inventoryHref,
  placeholder = "e.g. 460941",
  inputId,
}: Props) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  // Migration 0182: the shortlist is CURRENT STOCK, which now means neither
  // expired NOR discarded. Shared predicate so this cannot drift from the
  // server-side selectors.
  const active = useMemo(() => options.filter(isCurrentStock), [options]);
  const hasActiveInventory = active.length > 0;
  const isManual = selectedInventoryItemId == null && value.trim() !== "";

  // Empty input → the current-stock shortlist; typed input → search the full set
  // (so an expired or since-discarded historical lot remains FINDABLE, which is
  // what keeps retrospective charting of a treatment performed before the
  // discard possible) filtered by the query.
  const results = useMemo(() => {
    const q = value.trim();
    const base = q ? options : active;
    return filterProbeLotOptions(base, q).slice(0, 50);
  }, [value, options, active]);

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          data-testid="probe-lot-input"
          value={value}
          onChange={(e) => {
            // Typing is ALWAYS a manual edit; never auto-replaced, and it breaks
            // any inventory link.
            onManualChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          maxLength={120}
          className="w-full min-h-[2.75rem] max-w-[20rem] rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        {open && (
          <ul
            id={listId}
            role="listbox"
            data-testid="probe-lot-options"
            className="absolute z-20 mt-1 max-h-72 w-full max-w-[20rem] overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          >
            {results.length === 0 ? (
              <li className="px-3 py-2 text-sm text-neutral-500">
                {hasActiveInventory
                  ? "No probe lots match. Keep typing to enter it manually."
                  : "No active inventory lot for this probe. Type the lot/batch manually, or add it to your inventory."}
              </li>
            ) : (
              results.map((o) => (
                <li
                  key={o.id}
                  role="option"
                  aria-selected={selectedInventoryItemId === o.id}
                >
                  <button
                    type="button"
                    data-testid={`probe-lot-option-${o.id}`}
                    // onMouseDown (not onClick) so the selection fires before the
                    // input's onBlur closes the list.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelectInventory(o);
                      setOpen(false);
                    }}
                    className="flex w-full min-h-[2.75rem] flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {o.lotNumber}
                      {o.isExpired && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                          Expired
                        </span>
                      )}
                      {/* 0182: shown alongside Expired, not instead of it —
                          both facts are true and both matter when deciding
                          whether to record this lot for a past treatment. */}
                      {o.isDiscarded && (
                        <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                          Discarded
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {probeLotOptionLabel(o)
                        .replace(`${o.lotNumber}${PROBE_LOT_LABEL_DELIMITER}`, "")
                        .replace(`${o.lotNumber} · `, "")}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        {selectedInventoryItemId != null && (
          <span
            data-testid="probe-lot-linked"
            className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
          >
            Inventory linked
          </span>
        )}
        {isManual && (
          <span
            data-testid="probe-lot-manual"
            className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          >
            Manual entry, not linked to inventory
          </span>
        )}
        <Link
          href={inventoryHref}
          className="underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Manage probe inventory
        </Link>
      </div>
    </div>
  );
}
