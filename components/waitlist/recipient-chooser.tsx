"use client";

import { useEffect, useReducer } from "react";
import {
  DEFAULT_PAGE_SIZE,
  chooserReducer,
  filterCandidates,
  initialChooserState,
  pageOf,
  selectedAmong,
  selectedIds,
  type Candidate,
} from "@/lib/waitlist/recipient-chooser";
import { buttonClasses } from "@/components/ui/button";

// The over-invite recipient chooser: search, a bounded page, and a selection that survives both. Presentational: it reads nothing, calls no command
// and is placed on no page yet. Every selected id is posted as a hidden `entryId` input, so the form carries the whole selection (all pages, any
// number) while only one page of checkboxes is ever rendered. Nobody is selected by default, and nothing here caps the selection.
// The buttons are type="button" and Enter in the search box does not submit, so browsing never sends invitations.

export function RecipientChooser({
  candidates,
  pageSize = DEFAULT_PAGE_SIZE,
  initialSelected = [],
  onSelectionChange,
}: {
  candidates: readonly Candidate[];
  pageSize?: number;
  initialSelected?: readonly string[];
  /** Reports the size of the whole selection (all pages), so a line elsewhere can follow what is actually chosen. */
  onSelectionChange?: (count: number) => void;
}) {
  const [state, dispatch] = useReducer(chooserReducer, initialSelected, initialChooserState);
  const selectedCount = state.selected.size;
  useEffect(() => {
    onSelectionChange?.(selectedCount);
  }, [selectedCount, onSelectionChange]);
  const filtered = filterCandidates(candidates, state.query);
  const view = pageOf(filtered, state.page, pageSize);
  const pageIds = view.items.map((c) => c.entryId);
  const matching = filtered.length;
  const selectedMatching = selectedAmong(filtered, state.selected);
  // The shared secondary button's hover and pressed fills also paint on a DISABLED button (its disabled style only dims it), and Previous / Next are disabled at the ends:
  // a disabled control must not react, so the resting fill is restored for them.
  const btn = buttonClasses({ variant: "secondary", className: "disabled:hover:bg-surface disabled:active:bg-surface" });
  return (
    <fieldset className="flex flex-col gap-2 text-sm" data-testid="recipient-chooser">
      <legend className="font-medium">Choose who to invite</legend>
      <input
        type="search"
        autoComplete="off"
        aria-label="Search by name"
        placeholder="Search by name"
        value={state.query}
        onChange={(e) => dispatch({ type: "query", query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        className="min-h-11 rounded-md border px-2"
      />
      <p role="status" data-testid="chooser-count">
        {state.selected.size} selected in all
        {state.query.trim() ? `, ${selectedMatching} of ${matching} matching this search` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => dispatch({ type: "selectIds", entryIds: pageIds })}>
          Select this page
        </button>
        <button type="button" className={btn} onClick={() => dispatch({ type: "deselectIds", entryIds: pageIds })}>
          Clear this page
        </button>
        <button type="button" className={btn} onClick={() => dispatch({ type: "selectIds", entryIds: filtered.map((c) => c.entryId) })}>
          {`Select all ${matching} ${state.query.trim() ? "matching" : "listed"}`}
        </button>
        <button type="button" className={btn} onClick={() => dispatch({ type: "clear" })}>
          Clear everything
        </button>
      </div>
      {matching === 0 ? (
        <p data-testid="chooser-empty">No one matches that search.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {view.items.map((c) => (
            <li key={c.entryId}>
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" checked={state.selected.has(c.entryId)} onChange={() => dispatch({ type: "toggle", entryId: c.entryId })} />
                <span className="break-words">{c.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <nav aria-label="Recipient pages" className="flex items-center gap-2">
        <button type="button" className={btn} disabled={view.page === 0} onClick={() => dispatch({ type: "page", page: view.page - 1 })}>
          Previous
        </button>
        <span data-testid="chooser-range">
          {view.from}–{view.to} of {view.total}
        </span>
        <button type="button" className={btn} disabled={view.page >= view.pageCount - 1} onClick={() => dispatch({ type: "page", page: view.page + 1 })}>
          Next
        </button>
      </nav>
      {selectedIds(state.selected).map((id) => (
        <input key={id} type="hidden" name="entryId" value={id} />
      ))}
    </fieldset>
  );
}
