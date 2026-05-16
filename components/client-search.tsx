"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Client } from "@/lib/types/database";

type Props = {
  clients: Client[];
  placeholder?: string;
  emptyLabel?: string;
};

export function ClientSearch({
  clients,
  placeholder = "Find client",
  emptyLabel = "No clients match.",
}: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => {
      return (
        c.name.toLowerCase().includes(q) ||
        (c.email?.toLowerCase().includes(q) ?? false) ||
        (c.phone?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [clients, query]);

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
      {filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">{emptyLabel}</p>
      ) : (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {filtered.map((c) => (
            <li key={c.id}>
              <Link
                href={`/clients/${c.id}`}
                className="flex items-center justify-between gap-3 px-4 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{c.name}</div>
                  <div className="truncate text-xs text-neutral-500">
                    {[c.pronouns, c.phone, c.email].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
                <span className="text-sm text-neutral-400">›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
