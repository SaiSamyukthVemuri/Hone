"use client";

import { useRef, useState } from "react";
import { PendingLink } from "@/components/pending-link";
import { FOCUS_RING } from "@/components/ui/control-base";
import { fieldControlClass } from "@/components/ui/field";
import type { OverviewSection } from "@/lib/settings/overview";

function words(text: string) {
  return text.toLowerCase().replace(/\bcolou?rs?\b/g, "color").replace(/[^a-z0-9]+/g, " ").trim();
}

export function SettingsDirectory({ sections }: { sections: OverviewSection[] }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const terms = words(query).split(" ").filter(Boolean);
  const searching = terms.length > 0;
  function matches(text: string) {
    const normalized = words(text);
    return terms.every((term) => normalized.includes(term));
  }
  const visibleSections = searching ? sections.map(({ name, links }) => ({
    name,
    links: links.flatMap((link) => {
      if (matches(name) || matches(link.label)) return [link];
      const controls = link.controls?.filter((control) => matches([control.label, control.keywords, link.label, name].join(" ")));
      if (controls?.length) return controls;
      return matches([name, link.label, link.keywords].join(" ")) ? [link] : [];
    }),
  })).filter((section) => section.links.length > 0) : sections;
  const count = visibleSections.reduce((total, section) => total + section.links.length, 0);

  return (
    <section aria-label="Find a setting" className="space-y-6">
      <div className="relative">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" />
        </svg>
        <input
          ref={input}
          type="search"
          aria-label="Find a setting"
          placeholder="Find a setting…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={fieldControlClass({ className: "pl-10 pr-16 [&::-webkit-search-cancel-button]:hidden" })}
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); input.current?.focus(); }}
            className={`absolute inset-y-0 right-1 my-auto min-h-11 rounded-md px-3 text-sm font-medium text-fg hover:underline ${FOCUS_RING}`}>
            Clear
          </button>
        )}
      </div>
      <p role="status" className={searching ? "text-sm text-fg-muted" : "sr-only"}>
        {searching && (count ? `${count} matching ${count === 1 ? "setting" : "settings"}` : "No settings match your search.")}
      </p>
      {visibleSections.length > 0 && (
        <div className="divide-y divide-line border-y border-line">
          {visibleSections.map(({ name, links }) => (
            <section key={name} className="grid items-baseline gap-x-6 gap-y-1 py-3 sm:grid-cols-[minmax(10rem,1fr)_minmax(0,3fr)] sm:py-4">
              <h2 className="text-base font-semibold tracking-tight text-fg">{name}</h2>
              <ul className="-mx-2 flex flex-wrap gap-x-1 gap-y-0.5 sm:gap-x-2">
                {links.map(({ label, href }) => (
                  <li key={href}>
                    <PendingLink href={href} prefetch={false} className={`inline-flex min-h-11 items-center rounded-md px-2 text-sm text-fg underline decoration-line-strong underline-offset-4 hover:bg-surface-sunken hover:decoration-current pointer-fine:min-h-8 ${FOCUS_RING}`}>
                      {label}
                    </PendingLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
