"use client";

import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { PendingLink } from "@/components/pending-link";
import { CONTROL_MIN_TOUCH, cx } from "@/components/ui/control-base";
import type { OverviewSection } from "@/lib/settings/overview";
import { focusIsNowhere, focusSettingsHeading } from "./focus-heading";
import { HashRedirect } from "./hash-redirect";
import { UnsavedChangesProvider } from "./unsaved-changes";
import { SettingsDirectory } from "./settings-directory";
import { SettingIcon } from "./setting-icon";

type Props = {
  showSetupReturn?: boolean;
  sections: OverviewSection[];
  reachable?: { label: string; href: string }[];
  studioName: string;
  roleLabel: string;
  children: ReactNode;
};

const navItem = "flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-surface-sunken focus-visible:outline-2";
const selected = "border-l-2 border-fg bg-surface-sunken font-medium";
const shellControl = cx(CONTROL_MIN_TOUCH, "min-w-[44px] pointer-fine:min-h-10");

export function SettingsShell({ sections, reachable = [], studioName, roleLabel, showSetupReturn = false, children }: Props) {
  const pathname = usePathname() ?? "";
  const query = useSearchParams()?.toString() ?? "";
  const reachableHere = reachable.find(link => pathname === link.href || pathname.startsWith(link.href + "/"));
  const grid = useRef<HTMLDivElement>(null);
  const isOverview = pathname === "/settings";
  const dialogId = useId();
  const popup = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const [panel, setPanel] = useState<"menu" | "search">("search");
  const [hash, setHash] = useState("");
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const heldPopup = useRef(false);

  // Search fragments win over the route's ordinary tab when both are available.
  const section = sections.find(group => group.links.some(link => link.href === pathname + hash)) ??
    sections.find(group => group.links.some(link => link.href === pathname || pathname.startsWith(link.href + "/")));
  const current = section?.links.find(link => link.href === pathname + hash) ??
    section?.links.find(link => link.href === pathname || pathname.startsWith(link.href + "/"));

  useEffect(() => {
    const root = grid.current;
    const header = document.querySelector("header");
    if (!root || !header) return;
    function measure() {
      if (!root || !header) return;
      root.style.setProperty("--settings-top", Math.ceil(header.getBoundingClientRect().height) + "px");
      const tail = document.documentElement.scrollHeight - (root.getBoundingClientRect().bottom + window.scrollY);
      root.style.setProperty("--settings-tail", Math.max(0, Math.ceil(tail)) + "px");
    }
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  function openPanel(view: "menu" | "search") {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(view);
    setOpen(true);
    popup.current?.showModal();
  }

  useEffect(() => {
    if (open && panel === "search") popup.current?.querySelector("input")?.focus();
  }, [open, panel]);

  useEffect(() => {
    const update = () => {
      setHash(window.location.hash);
      if (popup.current?.open) popup.current.close();
    };
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, [pathname, query]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      if ((event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true]")) ||
          document.querySelector('dialog[open],[aria-modal=true]')) return;
      event.preventDefault();
      openPanel("search");
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);

  // A route change closes the drawer and moves keyboard focus to the new view's
  // heading, WITHOUT scrolling (the view opens at its top) and never into a
  // field. Not on first load: that would steal focus from the page.
  useEffect(() => {
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

  function followLink(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor?.closest("nav,dialog")) return;
    if (anchor.pathname === pathname && anchor.search === window.location.search) {
      if (popup.current?.open) popup.current.close();
      setHash(anchor.hash);
      if (!anchor.hash) {
        requestAnimationFrame(() => focusSettingsHeading(content.current, document.activeElement));
      }
    }
  }

  function categoryLinks(location: "sidebar" | "menu") {
    return (
      <nav aria-label="Settings categories" className="space-y-0.5">
        <PendingLink pendingLabel="Loading settings…" href="/settings" aria-current={isOverview ? "page" : undefined} className={navItem + (isOverview ? " " + selected : "")}>
          <span className="flex items-center gap-2.5"><SettingIcon name="Settings overview" />Settings overview</span>
        </PendingLink>
        {["Studio settings", "Personal settings"].map(scope => {
          const groups = sections.filter(group => (scope === "Personal settings") === (group.name === "My profile"));
          return groups.length ? <div key={scope} role="group" aria-labelledby={dialogId + location + scope.replace(" ", "-")}>
            <p id={dialogId + location + scope.replace(" ", "-")} className="px-2.5 pt-4 pb-1.5 text-xs font-semibold tracking-wide text-fg-muted">{scope}</p>
            {groups.map(group => <PendingLink pendingLabel="Loading settings…" key={group.name} href={group.links[0].href}
              aria-current={section === group ? "location" : undefined}
              className={navItem + (section === group ? " " + selected : "")}>
              <span className="flex items-center gap-2.5"><SettingIcon name={group.name} />{group.name}</span>
            </PendingLink>)}
          </div> : null;
        })}
        {reachableHere && <PendingLink pendingLabel="Loading settings…" href={reachableHere.href} aria-current="page" className={navItem + " " + selected}>{reachableHere.label}</PendingLink>}
      </nav>
    );
  }

  return (
    <div ref={grid} data-settings-screen="" onClickCapture={followLink} className="grid min-w-0 gap-5 min-[911px]:grid-cols-[12rem_minmax(0,1fr)] min-[911px]:gap-6">
      <UnsavedChangesProvider onHold={() => {
        heldPopup.current = Boolean(popup.current?.open);
        if (heldPopup.current) popup.current?.close();
      }} onStay={anchor => {
        const target = heldPopup.current ? opener.current : anchor;
        requestAnimationFrame(() => target?.focus({ preventScroll: true }));
      }}>
        <HashRedirect />
        <aside aria-label="Settings navigation" className="hidden min-w-0 self-start border-r border-line pr-3 min-[911px]:sticky min-[911px]:top-[calc(var(--settings-top,4.5rem)_+_.75rem)] min-[911px]:block min-[911px]:max-h-[calc(100dvh_-_var(--settings-top,4.5rem)_-_var(--settings-tail,4.5rem)_-_1rem)] min-[911px]:overflow-y-auto">
          <div className="mb-4 flex items-center gap-3 border-b border-line pb-4">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-fg font-semibold text-white">{studioName.trim().slice(0,1)}</span>
            <div className="min-w-0"><p className="break-words text-sm font-semibold">{studioName}</p><p className="text-xs text-fg-muted">{roleLabel} workspace</p></div>
          </div>
          {categoryLinks("sidebar")}
        </aside>
        <div ref={content} className="min-w-0 space-y-4 [&>*>header[data-view-head]:first-child+*]:-mt-6">
          {!isOverview && <h1 className="sr-only">Settings</h1>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              <PendingLink pendingLabel="Loading settings…" href="/settings" className="hover:underline">Settings</PendingLink>
              <span aria-hidden>/</span><span>{isOverview ? "Studio workspace" : section?.name ?? reachableHere?.label ?? "Settings"}</span>
            </nav>
            <div className="flex flex-wrap gap-2">
              <button type="button" aria-label="Settings menu" aria-haspopup="dialog" aria-controls={dialogId} aria-expanded={open && panel === "menu"} onClick={() => openPanel("menu")} className={cx(shellControl, "rounded-md border border-line-strong px-3 text-sm min-[911px]:hidden")}>Settings menu</button>
              <button type="button" aria-haspopup="dialog" aria-controls={dialogId} aria-expanded={open && panel === "search"} onClick={() => openPanel("search")} className={cx(shellControl, "gap-2 rounded-md border border-line-strong px-3 text-sm hover:bg-surface-sunken")}>
                <SettingIcon name="Search" /> Find a setting <kbd aria-hidden className="hidden text-fg-muted sm:block">/</kbd>
              </button>
            </div>
          </div>
          {section && !isOverview && <nav aria-label="Settings sections" className="flex flex-wrap gap-x-1 border-b border-line">
            {section.links.map(link => <PendingLink pendingLabel="Loading settings…" key={link.href} href={link.href}
              aria-current={link === current ? "page" : undefined}
              className={cx(shellControl, "rounded-t-md border-b-2 px-2.5 text-sm hover:bg-surface-sunken",
                link === current ? "border-fg bg-surface-sunken font-medium" : "border-transparent text-fg-muted")}>
              {link.label}
            </PendingLink>)}
          </nav>}
          {showSetupReturn && (
            <PendingLink href="/dashboard?setup=resume" prefetch={false} className="mb-4 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4">
              Return to studio setup
            </PendingLink>
          )}
          {children}
        </div>
        <dialog id={dialogId} ref={popup} aria-label={panel === "search" ? "Find a setting" : "Settings menu"} onClose={() => setOpen(false)}
          className="fixed inset-0 m-auto max-h-[80dvh] w-[min(32rem,calc(100%_-_2rem))] overflow-y-auto rounded-xl border border-line bg-surface p-5 text-fg shadow-xl backdrop:bg-black/30">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{panel === "search" ? "Find a setting" : "Settings menu"}</h2>
            <button type="button" onClick={() => popup.current?.close()} className={cx(shellControl, "rounded-md px-2 text-sm hover:bg-surface-sunken")}>Close</button>
          </div>
          {open && <div>
            {panel === "menu" ? categoryLinks("menu") : <SettingsDirectory sections={sections}/>}
          </div>}
        </dialog>
      </UnsavedChangesProvider>
    </div>
  );
}
