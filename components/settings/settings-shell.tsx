"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { PendingLink } from "@/components/pending-link";
import {
  SETTINGS_NAV_GROUP_LABEL,
  SETTINGS_NAV_GROUP_ORDER,
  activeSettingsItem,
  type SettingsNavItem,
} from "@/lib/settings/nav";
import { UnsavedChangesProvider } from "./unsaved-changes";

// The Settings shell (settings redesign, WS-B): back-to-app header, a left rail
// of expandable categories with indented subsections and an active marker, a
// breadcrumb, and a drawer for narrow screens. The rail's entries arrive already
// filtered for the signed-in role by the server layout; this component only
// presents them. It never decides who may see anything.

type Props = {
  items: ReadonlyArray<SettingsNavItem>;
  account: { name: string; roleLabel: string };
  children: ReactNode;
};

const ITEM_BASE =
  "block rounded-md px-3 py-2 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-100";
const ITEM_IDLE =
  "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";
const ITEM_ACTIVE =
  "bg-neutral-100 font-semibold text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100";

/** The section id nearest the top of the viewport, or the URL hash. */
function useActiveSection(ids: ReadonlyArray<string>, pathKey: string): string | null {
  const [active, setActive] = useState<string | null>(null);
  const idsKey = ids.join("|");
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace(/^#/, "");
      if (h && ids.includes(h)) setActive(h);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    let observer: IntersectionObserver | null = null;
    if (els.length > 0 && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        (entries) => {
          const top = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
          if (top) setActive(top.target.id);
        },
        { rootMargin: "-10% 0px -70% 0px" },
      );
      els.forEach((el) => observer!.observe(el));
    }
    return () => {
      window.removeEventListener("hashchange", fromHash);
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, pathKey]);
  return active;
}

export function SettingsShell({ items, account, children }: Props) {
  const pathname = usePathname() ?? "";
  const activeItem = activeSettingsItem(items, pathname);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(
    () => new Set(activeItem ? [activeItem.id] : []),
  );
  const menuButton = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLElement>(null);
  const railId = useId();

  const activeSection = useActiveSection(
    activeItem?.sections.map((s) => s.id) ?? [],
    pathname,
  );
  const activeSectionLabel =
    activeItem?.sections.find((s) => s.id === activeSection)?.label ?? null;

  // Opening the page's own category keeps it expanded as the route changes.
  useEffect(() => {
    if (!activeItem) return;
    setOpenIds((prev) => (prev.has(activeItem.id) ? prev : new Set(prev).add(activeItem.id)));
  }, [activeItem]);

  // A route change closes the drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Drawer: Escape closes, focus moves in on open and back to the button on close.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    rail.current?.querySelector<HTMLElement>("a, summary")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const groups = SETTINGS_NAV_GROUP_ORDER.map((group) => ({
    group,
    label: SETTINGS_NAV_GROUP_LABEL[group],
    entries: items.filter((i) => i.group === group),
  })).filter((g) => g.entries.length > 0);

  return (
    <UnsavedChangesProvider>
      <div className="flex flex-col gap-6">
        <header className="flex items-center gap-3">
          <PendingLink
            href="/dashboard"
            pendingLabel="Loading…"
            aria-label="Back to Hone"
            className="rounded-md p-2 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <span aria-hidden>←</span>
          </PendingLink>
          <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
          <button
            ref={menuButton}
            type="button"
            aria-expanded={drawerOpen}
            aria-controls={railId}
            aria-label="Settings menu"
            onClick={() => setDrawerOpen((v) => !v)}
            className="ml-auto rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium min-[700px]:hidden dark:border-neutral-700"
          >
            <span aria-hidden>☰</span> Menu
          </button>
        </header>

        <div className="min-[700px]:grid min-[700px]:grid-cols-[245px_minmax(0,1fr)] min-[700px]:gap-10">
          {drawerOpen && (
            <button
              type="button"
              aria-label="Close settings menu"
              tabIndex={-1}
              onClick={() => setDrawerOpen(false)}
              className="fixed inset-0 z-30 bg-black/40 min-[700px]:hidden"
            />
          )}
          <aside
            id={railId}
            ref={rail}
            aria-label="Settings navigation"
            className={`${
              drawerOpen
                ? "fixed inset-y-0 left-0 z-40 w-72 overflow-y-auto bg-white p-4 shadow-xl dark:bg-neutral-950"
                : "hidden"
            } min-[700px]:static min-[700px]:z-auto min-[700px]:block min-[700px]:w-auto min-[700px]:overflow-visible min-[700px]:bg-transparent min-[700px]:p-0 min-[700px]:shadow-none`}
          >
            <nav aria-label="Settings sections" className="flex flex-col gap-4">
              {groups.map(({ group, label, entries }) => (
                <div key={group} className="flex flex-col gap-1">
                  {label && (
                    <p className="px-3 pb-1 pt-2 text-[11px] font-semibold tracking-widest text-neutral-500 dark:text-neutral-400">
                      {label}
                    </p>
                  )}
                  {entries.map((entry) => {
                    const isActive = activeItem?.id === entry.id;
                    if (entry.sections.length === 0) {
                      return (
                        <PendingLink
                          key={entry.id}
                          href={entry.href}
                          pendingLabel="Loading settings…"
                          aria-current={isActive ? "page" : undefined}
                          className={`${ITEM_BASE} ${isActive ? ITEM_ACTIVE : ITEM_IDLE}`}
                        >
                          {entry.label}
                        </PendingLink>
                      );
                    }
                    const open = openIds.has(entry.id);
                    return (
                      <details
                        key={entry.id}
                        open={open}
                        onToggle={(e) => {
                          const next = (e.currentTarget as HTMLDetailsElement).open;
                          setOpenIds((prev) => {
                            const s = new Set(prev);
                            if (next) s.add(entry.id);
                            else s.delete(entry.id);
                            return s;
                          });
                        }}
                      >
                        <summary
                          className={`${ITEM_BASE} flex cursor-pointer list-none items-center justify-between [&::-webkit-details-marker]:hidden ${
                            isActive ? ITEM_ACTIVE : ITEM_IDLE
                          }`}
                        >
                          <span>{entry.label}</span>
                          <span aria-hidden className="text-neutral-500">
                            {open ? "⌄" : "›"}
                          </span>
                        </summary>
                        <ul className="ml-4 mt-1 flex flex-col border-l border-neutral-200 dark:border-neutral-800">
                          {entry.sections.map((section) => {
                            const sectionActive = isActive && activeSection === section.id;
                            return (
                              <li key={section.id}>
                                <PendingLink
                                  href={`${entry.href}#${section.id}`}
                                  pendingLabel="Loading settings…"
                                  aria-current={sectionActive ? "location" : undefined}
                                  className={`-ml-px block border-l-2 px-3 py-1.5 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-100 ${
                                    sectionActive
                                      ? "border-neutral-900 font-medium text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
                                      : "border-transparent text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
                                  }`}
                                >
                                  {section.label}
                                </PendingLink>
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    );
                  })}
                </div>
              ))}
            </nav>
            <div className="mt-6 border-t border-neutral-200 px-3 pt-4 text-sm dark:border-neutral-800">
              <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">{account.name}</p>
              <p className="text-neutral-500 dark:text-neutral-400">{account.roleLabel}</p>
            </div>
          </aside>

          <div className="min-w-0">
            {activeItem && (
              <nav aria-label="Breadcrumb" className="mb-6 text-xs text-neutral-500 dark:text-neutral-400">
                <ol className="flex flex-wrap items-center gap-1.5">
                  <li>Settings</li>
                  <li aria-hidden>/</li>
                  <li aria-current={activeSectionLabel ? undefined : "page"}>{activeItem.label}</li>
                  {activeSectionLabel && (
                    <>
                      <li aria-hidden>/</li>
                      <li aria-current="page">{activeSectionLabel}</li>
                    </>
                  )}
                </ol>
              </nav>
            )}
            {children}
          </div>
        </div>
      </div>
    </UnsavedChangesProvider>
  );
}
