"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import {
  activeProbeLotOptions,
  filterProbeLotOptions,
  probeLotOptionLabel,
  type ProbeLotOption,
} from "@/lib/record-keeping/probe-lot-inventory";

// Searchable ACTIVE probe-lot selector for the charting form (migration 0128
// release). Backed by the studio's record_keeping_sterile_items probe inventory.
//
// Contract:
//   * The text input IS the saved value — MANUAL ENTRY is always available and a
//     typed value is never silently replaced. Selecting a lot fills the input.
//   * The dropdown lists ACTIVE (non-expired) lots by default; typing searches
//     the FULL set (lot / description / manufacturer) so an expired historical
//     lot is still findable, and shows it flagged "Expired".
//   * Empty state ("No active probe lots found") + an authorized link to the
//     inventory when there are no active lots.
//   * Studio isolation is enforced upstream (the options are already
//     studio-scoped by the server query); this component only renders them.
type Props = {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<ProbeLotOption>;
  inventoryHref: string;
  placeholder?: string;
  inputId?: string;
};

export function ProbeLotSelect({
  value,
  onChange,
  options,
  inventoryHref,
  placeholder = "e.g. 460941",
  inputId,
}: Props) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const active = useMemo(() => activeProbeLotOptions(options), [options]);
  const hasActiveInventory = active.length > 0;

  // Empty input → the active shortlist; typed input → search the full set (so an
  // expired historical lot remains findable) filtered by the query.
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
            // Typing is ALWAYS a manual edit; never auto-replaced.
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Delay close so a tap on an option registers first (iPad-friendly).
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
                  : "No active probe lots found. Type the lot/batch manually, or add it to your inventory."}
              </li>
            ) : (
              results.map((o) => (
                <li key={`${o.lotNumber}-${o.expiryDate ?? "none"}`} role="option" aria-selected={o.lotNumber === value}>
                  <button
                    type="button"
                    data-testid={`probe-lot-option-${o.lotNumber}`}
                    // onMouseDown (not onClick) so the selection fires before the
                    // input's onBlur closes the list.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChange(o.lotNumber);
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
                    </span>
                    <span className="text-xs text-neutral-500">
                      {probeLotOptionLabel(o).replace(`${o.lotNumber} — `, "").replace(`${o.lotNumber} · `, "")}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        {!hasActiveInventory && (
          <span data-testid="probe-lot-empty">No active probe lots found.</span>
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
