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
import { useSettingsScreen } from "./use-settings-screen";
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
// An EXPANDED group (the parent of the page being viewed) is quieter than the
// selected page: its text and chevron darken, and that is all. It never takes a
// fill, an accent bar, a heavier weight or aria-current, so it cannot be mistaken
// for the one selected page. A flat entry has no parent styling at all.
const ITEM_PARENT_OPEN =
  "text-neutral-900 hover:bg-neutral-50 dark:text-neutral-100 dark:hover:bg-neutral-900";
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
  const { screen, screenButton, mode, pending, toggle } = useSettingsScreen(drawerOpen);
  const expanded = mode !== "normal";
  const screenLabel = mode === "normal" ? "Full screen" : mode === "fullscreen" ? "Exit full screen" : "Exit expanded view";
  // The sticky title bar and rail sit directly under the app header. Its height
  // is not a constant (the nav row, a wrapped account name), so it is measured
  // and handed down as --settings-top; 4.5rem is the first-paint fallback.
  const [headerPx, setHeaderPx] = useState<number | null>(null);
  // The space BELOW the layout grid (main's bottom padding and the app footer). A
  // sticky rail may not be taller than the viewport minus its top offset minus
  // this tail, or sticky pushes it up out of view at the end of the page.
  const [tailPx, setTailPx] = useState<number | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const topVar: CSSProperties | undefined =
    expanded || (headerPx === null && tailPx === null)
      ? undefined
      : ({
          ...(headerPx === null ? {} : { "--settings-top": `${headerPx}px` }),
          ...(tailPx === null ? {} : { "--settings-tail": `${tailPx}px` }),
        } as CSSProperties);
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
    const measure = () => {
      setHeaderPx(Math.ceil(appHeader.getBoundingClientRect().height));
      const g = grid.current;
      if (g) {
        const below =
          document.documentElement.scrollHeight - (g.getBoundingClientRect().bottom + window.scrollY);
        setTailPx(Math.max(0, Math.ceil(below)));
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(appHeader);
    observer.observe(document.body);
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
      if (e.key === "Escape" && !document.querySelector('[aria-modal="true"], dialog[open]')) {
        e.stopPropagation();
        setDrawerOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    rail.current?.querySelector<HTMLElement>("nav a, nav button")?.focus();
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
      isDesktop: !expanded && window.matchMedia("(min-width: 781px)").matches,
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

  const screenControl = (
    <button
      ref={screenButton}
      type="button"
      aria-pressed={expanded}
      aria-label={screenLabel}
      aria-disabled={pending || undefined}
      title={screenLabel}
      onClick={toggle}
      className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border border-neutral-300 px-2 text-sm font-medium hover:bg-neutral-50 sm:px-3 dark:border-neutral-700 dark:hover:bg-neutral-900"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d={expanded ? "M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5" : "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"} />
      </svg>
      <span className="sr-only min-[500px]:not-sr-only">{screenLabel}</span>
    </button>
  );

  return (
    <div ref={screen} data-settings-screen="" data-settings-expanded={expanded}>
      <UnsavedChangesProvider onHold={rememberDrawer} onStay={stayOnPage}>
      <HashRedirect />
      {pathname === "/settings" ? (
        <div ref={content}>
          {expanded && <div className="float-right ml-3">{screenControl}</div>}
          {children}
        </div>
      ) : (
      <div ref={grid} className="flex flex-col gap-6 settings-wide:grid settings-wide:grid-cols-[clamp(185px,15.4vw,222px)_minmax(0,1fr)] settings-wide:grid-rows-[auto_minmax(0,1fr)] settings-wide:items-start settings-wide:gap-x-[clamp(1rem,1.8vw,2rem)] settings-wide:gap-y-4"
        style={topVar}>
        {/* Sticky so the menu is reachable without scrolling back to the top. */}
        <header className="sticky top-[var(--settings-top,4.5rem)] z-20 flex flex-wrap items-center gap-1 bg-white py-2 sm:gap-3 settings-wide:static settings-wide:col-start-2 settings-wide:row-start-1 settings-wide:mx-0 settings-wide:bg-transparent settings-wide:p-0 dark:bg-neutral-950">
          <PendingLink
            href="/dashboard"
            pendingLabel="Loading…"
            aria-label="Back to Hone"
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <span aria-hidden>←</span>
          </PendingLink>
          <h1 className="mr-auto text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
          {screenControl}
          <button
            ref={menuButton}
            type="button"
            aria-expanded={drawerOpen}
            aria-controls={railId}
            aria-label="Settings menu"
            onClick={() => setDrawerOpen((v) => !v)}
            className="min-h-11 rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium settings-wide:hidden dark:border-neutral-700"
          >
            <span aria-hidden>☰</span> Menu
          </button>
        </header>

          {drawerOpen && (
            <button
              type="button"
              aria-label="Close settings menu"
              tabIndex={-1}
              onClick={() => {
                setDrawerOpen(false);
                menuButton.current?.focus();
              }}
              className="fixed inset-x-0 bottom-0 top-[var(--settings-top,4.5rem)] z-30 bg-black/40 settings-wide:hidden"
            />
          )}
          <aside
            id={railId}
            ref={rail}
            aria-label="Settings navigation"
            className={`${
              drawerOpen
                ? "fixed bottom-0 left-0 top-[var(--settings-top,4.5rem)] z-40 w-72 overflow-y-auto overscroll-contain bg-white p-4 max-w-full pl-[max(1rem,env(safe-area-inset-left))] pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl dark:bg-neutral-950"
                : "hidden"
            } settings-wide:sticky settings-wide:top-[calc(var(--settings-top,4.5rem)+0.75rem)] settings-wide:z-auto settings-wide:col-start-1 settings-wide:row-span-2 settings-wide:row-start-1 settings-wide:block settings-wide:max-h-[calc(100vh_-_var(--settings-top,4.5rem)_-_var(--settings-tail,4.5rem)_-_1rem)] settings-wide:w-auto settings-wide:overflow-y-auto settings-wide:bg-transparent settings-wide:p-0 settings-wide:shadow-none`}
          >
            <button
              type="button"
              onClick={() => {
                setDrawerOpen(false);
                menuButton.current?.focus();
              }}
              className="mb-2 min-h-11 rounded-md px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 settings-wide:hidden dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              <span aria-hidden>✕</span> Close menu
            </button>
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
              <PendingLink
                href="/settings"
                pendingLabel="Opening settings overview…"
                aria-current={pathname === "/settings" ? "page" : undefined}
                data-rail-item="overview"
                data-rail-kind="flat"
                data-rail-state={pathname === "/settings" ? "selected" : "idle"}
                className={`${ITEM_BASE} ${pathname === "/settings" ? ITEM_ACTIVE : ITEM_IDLE}`}
              >
                Overview
              </PendingLink>
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
                    if (entry.children.length === 0) {
                      const isCurrent = currentId === entry.id;
                      return (
                        <PendingLink
                          key={entry.id}
                          href={entry.href}
                          pendingLabel="Loading settings…"
                          aria-current={isCurrent ? "page" : undefined}
                          data-rail-item={entry.id}
                          data-rail-kind="flat"
                          data-rail-state={isCurrent ? "selected" : "idle"}
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
                          data-rail-item={entry.id}
                          data-rail-kind="group"
                          data-rail-state={open ? "expanded" : "collapsed"}
                          className={`${ITEM_BASE} ${open ? ITEM_PARENT_OPEN : ITEM_IDLE} flex w-full items-center justify-between text-left`}
                        >
                          <span>{entry.label}</span>
                          <svg
                            aria-hidden
                            viewBox="0 0 16 16"
                            className={`h-4 w-4 shrink-0 transition-transform ${
                              open
                                ? "rotate-90 text-neutral-900 dark:text-neutral-100"
                                : "text-neutral-500 dark:text-neutral-400"
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
                                    data-rail-item={child.id}
                                    data-rail-kind="child"
                                    data-rail-state={childActive ? "selected" : "idle"}
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
              element after its heading block is pulled up 1.5rem, so every view has
              0.5rem between the heading block and its first content box. */}
          <div
            ref={content}
            className="min-w-0 settings-wide:col-start-2 settings-wide:row-start-2 [&>*>header[data-view-head]:first-child+*]:-mt-6"
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
                  <li><PendingLink href="/settings" pendingLabel="Opening settings overview…" className="hover:underline">Settings</PendingLink></li>
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
      )}
      </UnsavedChangesProvider>
    </div>
  );
}
