"use client";

import { useState } from "react";
import { PendingLink } from "@/components/pending-link";
import type { OverviewSection } from "@/lib/settings/overview";

function words(text: string) {
  return text.toLowerCase().replace(/\bcolou?rs?\b/g, "color").replace(/[^a-z0-9]+/g, " ").trim();
}

export function SettingsDirectory({ sections }: { sections: OverviewSection[] }) {
  const [query, setQuery] = useState("");
  const terms = words(query).split(" ").filter(Boolean);
  const matches = sections.map(({ name, links }) => ({
    name,
    links: links.filter((link) => {
      const text = words([name, link.label, link.keywords].join(" "));
      return terms.every((term) => text.includes(term));
    }),
  })).filter((section) => section.links.length > 0);

  const resultCount = matches.reduce((count, section) => count + section.links.length, 0);

  return (
    <section aria-labelledby="settings-directory-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="settings-directory-title" className="text-lg font-semibold">Settings directory</h3>
        <input
          type="search"
          aria-label="Find a setting"
          placeholder="Find a setting…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-base sm:w-72 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </div>
      {terms.length > 0 && (
        <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">
          {matches.length ? `${resultCount} matching ${resultCount === 1 ? "setting" : "settings"}` : "No settings match your search."}
        </p>
      )}
      <div className="grid min-w-0 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {matches.map(({ name, links }) => (
          <section key={name} className="min-w-0 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
            <h4 className="mb-2 font-semibold">{name}</h4>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {links.map(({ label, href }) => (
                <li key={href}>
                  <PendingLink href={href} prefetch={false} className="flex min-h-11 items-center rounded px-1 py-2 text-sm text-neutral-700 hover:bg-neutral-50 hover:text-neutral-950 focus-visible:outline-2 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-white">
                    {label}
                  </PendingLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
