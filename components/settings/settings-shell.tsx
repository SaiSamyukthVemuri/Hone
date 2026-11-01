"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { PendingLink } from "@/components/pending-link";
import {
  SETTINGS_NAV_GROUP_ORDER,
  activeSettingsLocation,
  isRailLinkClick,
  type SettingsNavItem,
} from "@/lib/settings/nav";
import { focusIsNowhere, focusSettingsHeading } from "./focus-heading";
import { HashRedirect } from "./hash-redirect";
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

export function SettingsShell({ items, account, children }: Props) {
  const pathname = usePathname() ?? "";
  const location = activeSettingsLocation(items, pathname);
  const activeItem = location?.item ?? null;
  const activeChild = location?.child ?? null;
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Exactly one group is open (R2): opening another closes the previous. Opening
  // is only a disclosure; it navigates nowhere and unmounts nothing, so it can
  // never discard unsaved edits (a link click out of the page is what the
  // unsaved-changes guard intercepts). Navigating re-opens the active group.
  const [openId, setOpenId] = useState<string | null>(activeItem?.id ?? null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const railId = useId();
  const mounted = useRef(false);

  useEffect(() => {
    setOpenId(activeItem?.id ?? null);
  }, [activeItem?.id, activeChild?.id]);

  // A route change closes the drawer and moves keyboard focus to the new view's
  // heading, WITHOUT scrolling (the view opens at its top) and never into a
  // field. Not on first load: that would steal focus from the page.
  useEffect(() => {
    setDrawerOpen(false);
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const root = content.current;
    focusSettingsHeading(root, document.activeElement);
    // The new view's heading can mount after this effect, and the closing
    // drawer drops focus on <body>. Retry as the view mounts, only while focus
    // is nowhere, and stop after a bounded wait.
    if (!root) return;
    const retry = () => {
      if (
        focusIsNowhere(
          document.activeElement,
          document.body,
          document.documentElement,
        )
      ) {
        focusSettingsHeading(root, document.activeElement);
      }
    };
    const observer = new MutationObserver(retry);
    observer.observe(root, { childList: true, subtree: true });
    const frame = window.requestAnimationFrame(retry);
    const stop = window.setTimeout(() => observer.disconnect(), 3000);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(stop);
    };
  }, [pathname]);

  // A keyboard activation or a browser hash navigation can change the URL
  // without a pathname change: close the drawer on that too.
  useEffect(() => {
    const close = () => setDrawerOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);

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
    rail.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const groups = SETTINGS_NAV_GROUP_ORDER.map((group) => ({
    group,
    entries: items.filter((i) => i.group === group),
  })).filter((g) => g.entries.length > 0);

  return (
    <UnsavedChangesProvider>
      <HashRedirect />
      <div className="flex flex-col gap-6">
        {/* Sticky so the menu is reachable without scrolling back to the top. */}
        <header className="sticky top-14 z-20 -mx-4 flex items-center gap-3 bg-white px-4 py-2 min-[700px]:static min-[700px]:mx-0 min-[700px]:bg-transparent min-[700px]:p-0 dark:bg-neutral-950">
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

        <div className="min-[700px]:grid min-[700px]:grid-cols-[245px_minmax(0,1fr)] min-[700px]:items-start min-[700px]:gap-10">
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
            } min-[700px]:sticky min-[700px]:top-20 min-[700px]:z-auto min-[700px]:block min-[700px]:max-h-[calc(100vh-6rem)] min-[700px]:w-auto min-[700px]:overflow-y-auto min-[700px]:bg-transparent min-[700px]:p-0 min-[700px]:shadow-none`}
          >
            <nav
              aria-label="Settings sections"
              className="flex flex-col gap-1"
              onClick={(e) => {
                if (isRailLinkClick(e.target as Element | null))
                  setDrawerOpen(false);
              }}
            >
              {groups.map(({ group, entries }, groupIndex) => (
                <div
                  key={group}
                  className={`flex flex-col gap-1 ${
                    groupIndex > 0
                      ? "mt-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
                      : ""
                  }`}
                >
                  {entries.map((entry) => {
                    const isActive = activeItem?.id === entry.id;
                    if (entry.children.length === 0) {
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
                    const open = openId === entry.id;
                    const listId = `${railId}-${entry.id}`;
                    return (
                      <div key={entry.id}>
                        {/* A group heading is a disclosure button, not a link:
                            heading weight and a chevron set it apart from the
                            plain links beneath it. */}
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={listId}
                          onClick={() => setOpenId(open ? null : entry.id)}
                          className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-semibold tracking-tight text-neutral-900 transition hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:outline-neutral-100 ${
                            isActive ? "bg-neutral-50 dark:bg-neutral-900" : ""
                          }`}
                        >
                          <span>{entry.label}</span>
                          <span aria-hidden className="text-neutral-500">
                            {open ? "⌄" : "›"}
                          </span>
                        </button>
                        {open && (
                          <ul
                            id={listId}
                            className="ml-3 mt-1 flex flex-col gap-0.5 border-l border-neutral-200 pl-2 dark:border-neutral-800"
                          >
                            {entry.children.map((child) => {
                              const childActive = isActive && activeChild?.id === child.id;
                              return (
                                <li key={child.id}>
                                  <PendingLink
                                    href={child.href}
                                    pendingLabel="Loading settings…"
                                    aria-current={childActive ? "page" : undefined}
                                    className={`${ITEM_BASE} ${childActive ? ITEM_ACTIVE : ITEM_IDLE}`}
                                  >
                                    {child.label}
                                  </PendingLink>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </nav>
            <div className="mt-6 border-t border-neutral-200 px-3 pt-4 text-sm dark:border-neutral-800">
              <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">
                {account.name}
              </p>
              <p className="text-neutral-500 dark:text-neutral-400">
                {account.roleLabel}
              </p>
            </div>
          </aside>

          <div ref={content} className="min-w-0">
            {activeItem && (
              <nav
                aria-label="Breadcrumb"
                className="mb-6 text-xs text-neutral-500 dark:text-neutral-400"
              >
                <ol className="flex flex-wrap items-center gap-1.5">
                  <li>Settings</li>
                  <li aria-hidden>/</li>
                  <li aria-current={activeChild ? undefined : "page"}>
                    {activeItem.label}
                  </li>
                  {activeChild && (
                    <>
                      <li aria-hidden>/</li>
                      <li aria-current="page">{activeChild.label}</li>
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
