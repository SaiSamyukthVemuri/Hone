"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Client } from "@/lib/types/database";

type Props = {
  clients: Client[];
  /** Hide these client IDs from results (used to skip clients already on today's roster). */
  excludeIds?: ReadonlyArray<string>;
  /** When true, render an empty state until the query meets minChars. Default false (shows every client). */
  searchOnly?: boolean;
  minChars?: number;
  placeholder?: string;
  emptyLabel?: string;
  promptLabel?: string;
};

export function ClientSearch({
  clients,
  excludeIds,
  searchOnly = false,
  minChars = 2,
  placeholder = "Find client",
  emptyLabel = "No clients match.",
  promptLabel = "Type to search clients.",
}: Props) {
  const [query, setQuery] = useState("");

  // Defensive: skip any non-string / empty entries so a malformed array
  // can't accidentally exclude everything.
  const excludeSet = useMemo(() => {
    const set = new Set<string>();
    for (const id of excludeIds ?? []) {
      if (typeof id === "string" && id.length > 0) set.add(id);
    }
    return set;
  }, [excludeIds]);

  const trimmedQuery = query.trim();
  const queryLower = trimmedQuery.toLowerCase();
  const minimumMet = queryLower.length >= minChars;

  function nameMatches(c: Client): boolean {
    return (
      (c.name ?? "").toLowerCase().includes(queryLower) ||
      (c.email ?? "").toLowerCase().includes(queryLower) ||
      (c.phone ?? "").toLowerCase().includes(queryLower)
    );
  }

  // visible: the clients shown in the list right now.
  // suppressedByExclude: clients that would have matched the query but were
  // filtered out because they're already in today's roster. Used to surface
  // a hint so the user doesn't think the search is broken.
  const { visible, suppressedByExclude } = useMemo(() => {
    if (searchOnly && !minimumMet) {
      return { visible: [] as Client[], suppressedByExclude: 0 };
    }

    if (!minimumMet) {
      return {
        visible: clients.filter((c) => !excludeSet.has(c.id)),
        suppressedByExclude: 0,
      };
    }

    const matches = clients.filter(nameMatches);
    const inExclude = matches.filter((c) => excludeSet.has(c.id)).length;
    const shown = matches.filter((c) => !excludeSet.has(c.id));
    return { visible: shown, suppressedByExclude: inExclude };
    // queryLower is derived from `query`; including only the inputs the memo really depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, excludeSet, queryLower, minimumMet, searchOnly]);

  const showPrompt = searchOnly && !minimumMet;
  const showEmpty = !showPrompt && visible.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-3 text-base outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        autoComplete="off"
        autoCapitalize="none"
      />
      {showPrompt && (
        <p className="py-6 text-center text-sm text-neutral-500">
          {promptLabel}
        </p>
      )}
      {showEmpty && (
        <p className="py-6 text-center text-sm text-neutral-500">
          {emptyLabel}
          {suppressedByExclude > 0 && (
            <>
              {" "}
              {suppressedByExclude}{" "}
              {suppressedByExclude === 1 ? "match is" : "matches are"} already
              on today&rsquo;s roster.
            </>
          )}
        </p>
      )}
      {!showPrompt && visible.length > 0 && (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {visible.map((c) => (
            <ClientResultRow key={c.id} client={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

// Renders one client row. Contact info is read strictly from the client's own
// columns; never from any other record (studio, practitioner, etc.).
function ClientResultRow({ client }: { client: Client }) {
  const bits: string[] = [];
  if (client.pronouns) bits.push(client.pronouns);
  if (client.phone) bits.push(client.phone);
  if (client.email) bits.push(client.email);

  return (
    <li>
      <Link
        href={`/clients/${client.id}`}
        className="flex items-center justify-between gap-3 px-4 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-900"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{client.name}</div>
          {bits.length > 0 && (
            <div className="truncate text-xs text-neutral-500">
              {bits.join(" · ")}
            </div>
          )}
        </div>
        <span className="text-sm text-neutral-400">›</span>
      </Link>
    </li>
  );
}
