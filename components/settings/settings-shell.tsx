"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { PendingLink } from "@/components/pending-link";
import {
  SETTINGS_NAV_GROUP_LABEL,
  SETTINGS_NAV_GROUP_ORDER,
  activeSettingsLocation,
  currentSettingsRailId,
  isRailLinkClick,
  type SettingsNavItem,
} from "@/lib/settings/nav";
import { focusIsNowhere, focusSettingsHeading, stayFocusTarget } from "./focus-heading";
import { HashRedirect } from "./hash-redirect";
import { UnsavedChangesProvider } from "./unsaved-changes";

// The Settings shell (settings redesign, WS-B): back-to-app header, a left rail
// of expandable categories with indented subsections and an active marker, a
// breadcrumb, and a drawer for narrow screens. The rail's entries arrive already
// filtered for the signed-in role by the server layout; this component only
// presents them. It never decides who may see anything.

type Props = {
  items: ReadonlyArray<SettingsNavItem>;
  /** Entries the role may open by URL but whose rail entry is hidden (waitlist). Listed, selected, only while on their route. */
  reachable?: ReadonlyArray<SettingsNavItem>;
  account: { name: string; roleLabel: string };
  children: ReactNode;
};

// ONE look for every ordinary rail item (links and group buttons alike): the
// same colour and weight. A group is told apart by its chevron, never by darker
// or bolder text. ONLY the current page takes ITEM_ACTIVE (a filled row plus an
// accent bar); hover is a lighter wash with no bar, so it never reads as
// selected, and an expanded group has no fill at all.
const ITEM_BASE =
  "relative block rounded-md px-3 py-2 text-sm font-normal transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-100";
const ITEM_IDLE =
  "text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-neutral-100";
const ITEM_ACTIVE =
  "bg-neutral-100 font-medium text-neutral-900 before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-neutral-900 dark:bg-neutral-800 dark:text-neutral-100 dark:before:bg-neutral-100";

export function SettingsShell({ items: railItems, reachable = [], account, children }: Props) {
  const pathname = usePathname() ?? "";
  // A reachable entry joins the rail only while its own route is open, so that
  // page has exactly one current item and its breadcrumb; it is never listed
  // otherwise.
  const reachableHere = reachable.filter(
    (r) => pathname === r.href || pathname.startsWith(`${r.href}/`),
  );
  const items = [...railItems, ...reachableHere];
  const location = activeSettingsLocation(items, pathname);
  const activeItem = location?.item ?? null;
  const currentId = currentSettingsRailId(items, pathname);
  const activeChild = location?.child ?? null;
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The sticky title bar and rail sit directly under the app header. Its height
  // is not a constant (the nav row, a wrapped account name), so it is measured
  // and handed down as --settings-top; 4.5rem is the first-paint fallback.
  const [headerPx, setHeaderPx] = useState<number | null>(null);
  const topVar: CSSProperties | undefined =
    headerPx === null ? undefined : ({ "--settings-top": `${headerPx}px` } as CSSProperties);
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
    // The app header is the first <header> in the document.
    const appHeader = document.querySelector<HTMLElement>("header");
    if (!appHeader) return;
    const measure = () => setHeaderPx(Math.ceil(appHeader.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(appHeader);
    return () => observer.disconnect();
  }, []);

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

  // "Stay" on the unsaved-changes dialog. Whether the drawer was open is read
  // when the dialog appears (a held click from page content leaves it shut). Only
  // an open drawer is closed, and focus goes back to the Menu button because the
  // rail link that held it is about to be hidden; otherwise focus returns to the
  // held anchor, wherever it was.
  const drawerOpenRef = useRef(false);
  drawerOpenRef.current = drawerOpen;
  const drawerWasOpen = useRef(false);
  const rememberDrawer = () => {
    drawerWasOpen.current = drawerOpenRef.current;
  };
  const stayOnPage = (anchor: HTMLAnchorElement | null) => {
    const target = stayFocusTarget({
      drawerWasOpen: drawerWasOpen.current,
      isDesktop: window.matchMedia("(min-width: 700px)").matches,
    });
    if (target === "menu") setDrawerOpen(false);
    // Two frames: the dialog restores focus to its trigger first.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        if (target === "menu") menuButton.current?.focus();
        else if (anchor?.isConnected) anchor.focus({ preventScroll: true });
      }),
    );
  };

  const groups = SETTINGS_NAV_GROUP_ORDER.map((group) => ({
    group,
    entries: items.filter((i) => i.group === group),
  })).filter((g) => g.entries.length > 0);

  return (
    <UnsavedChangesProvider onHold={rememberDrawer} onStay={stayOnPage}>
      <HashRedirect />
      {/* Desktop: ONE grid. The rail takes the whole left column from the first row,
          so it starts directly under the app header (not under the Settings title
          row) and fits the viewport with no window scroll; the title row and the
          view sit in the right column. */}
      <div className="flex flex-col gap-6 min-[700px]:grid min-[700px]:grid-cols-[245px_minmax(0,1fr)] min-[700px]:grid-rows-[auto_minmax(0,1fr)] min-[700px]:items-start min-[700px]:gap-x-10 min-[700px]:gap-y-4"
        style={topVar}>
        {/* Sticky so the menu is reachable without scrolling back to the top. */}
        <header className="sticky top-[var(--settings-top,4.5rem)] z-20 -mx-4 flex items-center gap-3 bg-white px-4 py-2 min-[700px]:static min-[700px]:col-start-2 min-[700px]:row-start-1 min-[700px]:mx-0 min-[700px]:bg-transparent min-[700px]:p-0 dark:bg-neutral-950">
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
            } min-[700px]:sticky min-[700px]:top-[calc(var(--settings-top,4.5rem)+0.75rem)] min-[700px]:z-auto min-[700px]:col-start-1 min-[700px]:row-span-2 min-[700px]:row-start-1 min-[700px]:block min-[700px]:max-h-[calc(100vh_-_var(--settings-top,4.5rem)_-_4rem)] min-[700px]:w-auto min-[700px]:overflow-y-auto min-[700px]:bg-transparent min-[700px]:p-0 min-[700px]:shadow-none`}
          >
            <nav
              aria-label="Settings sections"
              className="flex flex-col gap-1"
              onClick={(e) => {
                const target = e.target as Element | null;
                if (!isRailLinkClick(target)) return;
                setDrawerOpen(false);
                // Choosing the view already open changes no pathname, so the
                // route effect never runs: move focus to its heading here, or it
                // falls to <body> when the drawer hides.
                const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
                if (anchor && anchor.pathname === pathname) {
                  focusSettingsHeading(content.current, document.activeElement);
                }
              }}
            >
              {groups.map(({ group, entries }, groupIndex) => (
                <div
                  key={group}
                  role="group"
                  aria-labelledby={SETTINGS_NAV_GROUP_LABEL[group] ? `${railId}-cat-${group}` : undefined}
                  className={`flex flex-col gap-1 ${
                    groupIndex > 0
                      ? "mt-2 border-t border-neutral-200 pt-3 dark:border-neutral-800"
                      : ""
                  }`}
                >
                  {SETTINGS_NAV_GROUP_LABEL[group] && (
                    // A category heading, not a control: small caps, muted, no
                    // hover, not focusable.
                    <p
                      id={`${railId}-cat-${group}`}
                      className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400"
                    >
                      {SETTINGS_NAV_GROUP_LABEL[group]}
                    </p>
                  )}
                  {entries.map((entry) => {
                    const isActive = activeItem?.id === entry.id;
                    if (entry.children.length === 0) {
                      const isCurrent = currentId === entry.id;
                      return (
                        <PendingLink
                          key={entry.id}
                          href={entry.href}
                          pendingLabel="Loading settings…"
                          aria-current={isCurrent ? "page" : undefined}
                          className={`${ITEM_BASE} ${isCurrent ? ITEM_ACTIVE : ITEM_IDLE}`}
                        >
                          {entry.label}
                        </PendingLink>
                      );
                    }
                    const open = openId === entry.id;
                    const listId = `${railId}-${entry.id}`;
                    return (
                      <div key={entry.id}>
                        {/* A group is a disclosure button with a chevron. Its text is
                            the same colour and weight as every other item and it
                            never takes the selected look, open or not. */}
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={listId}
                          onClick={() => setOpenId(open ? null : entry.id)}
                          className={`${ITEM_BASE} ${ITEM_IDLE} flex w-full items-center justify-between text-left`}
                        >
                          <span>{entry.label}</span>
                          <svg
                            aria-hidden
                            viewBox="0 0 16 16"
                            className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform dark:text-neutral-400 ${
                              open ? "rotate-90" : ""
                            }`}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M6 3.5 10.5 8 6 12.5" />
                          </svg>
                        </button>
                        {open && (
                          <ul
                            id={listId}
                            className="ml-3 mt-1 flex flex-col gap-0.5 border-l border-neutral-200 pl-2 dark:border-neutral-800"
                          >
                            {entry.children.map((child) => {
                              const childActive = currentId === child.id;
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

          {/* ONE heading-to-content rhythm: a view's root stacks at gap-8 (2rem) and the
              element after its heading block is pulled up 1rem, so every view has
              1rem between the heading block and its first content. */}
          <div
            ref={content}
            className="min-w-0 min-[700px]:col-start-2 min-[700px]:row-start-2 [&>*>header[data-view-head]:first-child+*]:-mt-4"
          >
            {!activeItem && (
              // A route that is not in this role's rail (an owner-only page opened
              // by a practitioner): nothing is current, because nothing here is
              // theirs to select, and the page itself states the refusal.
              <nav
                aria-label="Breadcrumb"
                className="mb-4 text-xs text-neutral-500 dark:text-neutral-400"
              >
                <ol className="flex flex-wrap items-center gap-1.5">
                  <li aria-current="page">Settings</li>
                </ol>
              </nav>
            )}
            {activeItem && (
              <nav
                aria-label="Breadcrumb"
                className="mb-4 text-xs text-neutral-500 dark:text-neutral-400"
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
    </UnsavedChangesProvider>
  );
}
