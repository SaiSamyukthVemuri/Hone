"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CONTROL_MIN_TOUCH, FOCUS_RING, cx } from "@/components/ui/control-base";
import { findClients, type FinderClient } from "@/lib/finance/statement-directory";
import { FINDER_INITIAL, onFinderInput, onFinderKey, type FinderKey, type FinderKeyState } from "@/lib/finance/statement-finder-keys";
import { FINDER_NO_MATCH, FINDER_PROMPT, clientStatementHref, clientsListHref, finderOptionLine } from "@/lib/finance/statement-screen";
import type { YearMonth } from "@/lib/finance/statement-period";

// Find a client: a combobox over the studio's clients (names only). Typing matches partial names in any order; ArrowUp/ArrowDown/Home/End move the
// highlight, Enter opens the highlighted client, Escape closes. A client with no visit in the month is listed and opens their FULL HISTORY. Every
// navigation is by the option's client id, never by name, so two clients with one name can never be mixed. The list is told apart by last visit date.
// This component reads nothing and writes nothing: the clients arrive from the server page; selecting only navigates.

/** WHAT CROSSES TO THE BROWSER, and nothing else: an id, the name as shown (the preferred name when set, never a legal name) and whether the client is archived. */
export type FinderOption = { id: string; displayName: string; archived: boolean };

export type FinderProps = {
  month: YearMonth;
  monthLabel: string;
  clients: readonly FinderOption[];
  /** Eligible visits in the selected month, by client id; absent means none. */
  /** NULL when the month's counts could not be read: the finder then states no count at all (never a zero). */
  monthVisits: Readonly<Record<string, number>> | null;
  /** Last visit dates (studio-local), only for clients that share a name; absent means the detail could not be read. */
  lastVisits: Readonly<Record<string, string | null>> | null;
};

export function ClientFinder({ month, monthLabel, clients, monthVisits, lastVisits }: FinderProps) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<FinderKeyState>(FINDER_INITIAL);
  const counts = useMemo(() => (monthVisits === null ? null : new Map(Object.entries(monthVisits))), [monthVisits]);
  // The matcher takes the shown name only; the options carry no stored or legal name to match against.
  const searchable = useMemo<FinderClient[]>(() => clients.map((c) => ({ id: c.id, name: c.displayName, preferredName: null, archived: c.archived })), [clients]);
  const outcome = useMemo(() => findClients(searchable, state.query, counts), [searchable, state.query, counts]);
  const options = outcome.results;

  const open = (index: number) => {
    const o = options[index];
    if (!o) return;
    router.push(clientStatementHref(o.clientId, month, o.monthVisitCount === 0 ? "history" : "month"));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const keys: FinderKey[] = ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape", "Tab"];
    if (!keys.includes(e.key as FinderKey)) return;
    const r = onFinderKey(state, e.key as FinderKey, options.length);
    if (r.preventDefault) e.preventDefault();
    setState(r.state);
    if (r.select !== null) open(r.select);
  };

  const expanded = state.open && outcome.state !== "prompt";
  return (
    <div className="relative max-w-md">
      <label htmlFor={`${listId}-input`} className="block text-sm font-medium text-fg">
        Find a client
      </label>
      <input
        id={`${listId}-input`}
        ref={inputRef}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && state.active !== null ? `${listId}-opt-${state.active}` : undefined}
        placeholder="Find a client…"
        value={state.query}
        onChange={(e) => setState(onFinderInput(e.target.value))}
        onKeyDown={onKeyDown}
        className={cx("mt-1 w-full rounded border border-line bg-surface px-3 py-2 text-sm text-fg", CONTROL_MIN_TOUCH, FOCUS_RING)}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {outcome.state === "results" ? `${options.length} ${options.length === 1 ? "client" : "clients"} found` : outcome.state === "none" ? FINDER_NO_MATCH : ""}
      </p>
      {expanded ? (
        <div id={listId} className="absolute z-10 mt-1 w-full rounded-lg border border-line bg-surface shadow-sm">
          {outcome.state === "none" ? (
            <div className="space-y-1 p-3 text-sm text-fg">
              <p>{FINDER_NO_MATCH}</p>
              <a href={clientsListHref(month)} className={cx("underline", FOCUS_RING)}>Open the Clients list for {monthLabel}</a>
            </div>
          ) : (
            <ul role="listbox" aria-label="Clients" className="max-h-80 overflow-auto py-1">
              {options.map((o, i) => (
                <li
                  key={o.clientId}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={state.active === i}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep focus in the input until navigation
                    open(i);
                  }}
                  onMouseEnter={() => setState((s) => ({ ...s, active: i }))}
                  className={cx("cursor-pointer px-3 py-2 text-sm text-fg", CONTROL_MIN_TOUCH, "flex-col items-start justify-center", state.active === i && "bg-surface-sunken")}
                >
                  <span className="font-medium">{o.displayName}{o.archived ? " (archived)" : ""}</span>
                  <span className="text-xs text-fg-muted">
                    {finderOptionLine({ monthLabel, monthVisitCount: o.monthVisitCount, sameNameAsAnother: o.sameNameAsAnother, lastVisit: lastVisits?.[o.clientId], lastVisitsLoaded: lastVisits !== null })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {outcome.state === "results" && outcome.truncated ? <p className="border-t border-line p-2 text-xs text-fg-muted">Showing the first matches. Type more of the name to narrow the list.</p> : null}
        </div>
      ) : (
        <p className="mt-1 text-xs text-fg-muted">{FINDER_PROMPT}</p>
      )}
    </div>
  );
}
