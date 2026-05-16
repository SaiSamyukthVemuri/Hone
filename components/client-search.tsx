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

  const excludeSet = useMemo(
    () => new Set(excludeIds ?? []),
    [excludeIds],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const minimumMet = q.length >= minChars;

    if (searchOnly && !minimumMet) return [];

    const base = clients.filter((c) => !excludeSet.has(c.id));
    if (!minimumMet) return base;

    return base.filter((c) => {
      return (
        c.name.toLowerCase().includes(q) ||
        (c.email?.toLowerCase().includes(q) ?? false) ||
        (c.phone?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [clients, excludeSet, query, searchOnly, minChars]);

  const showPrompt =
    searchOnly && query.trim().length < minChars;

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-3 text-base outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        autoComplete="off"
      />
      {showPrompt ? (
        <p className="py-6 text-center text-sm text-neutral-500">
          {promptLabel}
        </p>
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">{emptyLabel}</p>
      ) : (
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
