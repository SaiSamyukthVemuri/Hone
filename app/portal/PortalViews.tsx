"use client";

import { useEffect, useLayoutEffect, useState, useRef, type MouseEvent, type ReactNode } from "react";
import styles from "./portal-home.module.css";

const VIEWS = ["overview", "appointments", "care", "records", "booking"] as const;
type View = typeof VIEWS[number];
type Panel = { label: string; body: ReactNode };
type Panels = Partial<Record<View, Panel>>;

function viewFor(value: unknown, panels: Panels): View {
  return VIEWS.find(view => value === view && panels[view]) ?? "overview";
}

export function PortalViews({ initialView, panels }: { initialView?: string | string[]; panels: Panels }) {
  const initial = viewFor(initialView, panels);
  const [view, setView] = useState(initial);
  // Preserve unsaved fields when a client switches between portal sections.
  const [visited, setVisited] = useState<Set<View>>(() => new Set([initial]));
  const target = useRef<string | null>(null);
  const [navigation, setNavigation] = useState(0);

  useEffect(() => {
    function syncLocation(moveFocus: boolean) {
      const url = new URL(window.location.href);
      const recordsAnchor = ["#forms-to-sign", "#portal-tasks", "#portal-payment", "#add-card"].includes(url.hash);
      const next = recordsAnchor ? "records" : viewFor(url.searchParams.get("view"), panels);
      setVisited(previous => previous.has(next) ? previous : new Set([...previous, next]));
      setView(next);
      if (moveFocus || recordsAnchor) {
        target.current = (recordsAnchor && url.hash.slice(1)) || `view-${next}`;
        setNavigation(previous => previous + 1);
      }
    }
    syncLocation(false);
    const onNavigate = () => syncLocation(true);
    window.addEventListener("popstate", onNavigate);
    window.addEventListener("hashchange", onNavigate);
    return () => {
      window.removeEventListener("popstate", onNavigate);
      window.removeEventListener("hashchange", onNavigate);
    };
  }, [panels]);

  useLayoutEffect(() => {
    const id = target.current;
    if (!id) return;
    target.current = null;
    const el = document.getElementById(id) ?? document.getElementById(`view-${view}`);
    if (el) {
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
    }
  }, [view, navigation]);

  function navigate(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-portal-nav]") : null;
    if (!link) return;
    const url = new URL(link.href);
    const next = viewFor(url.searchParams.get("view"), panels);
    event.preventDefault();
    if (window.location.href !== url.href) window.history.pushState(null, "", url);
    setVisited(previous => previous.has(next) ? previous : new Set([...previous, next]));
    setView(next);
    target.current = url.hash.slice(1) || `view-${next}`;
    setNavigation(previous => previous + 1);
  }

  return (
    <div onClick={navigate}>
      <nav aria-label="Client portal" className={styles.nav}>
        {VIEWS.map(key => panels[key] && (
          <a key={key} data-portal-nav href={key === "overview" ? "/portal" : `/portal?view=${key}`} aria-current={key === view ? "page" : undefined}>
            {panels[key].label}
          </a>
        ))}
      </nav>
      {VIEWS.map(key => {
        const panel = panels[key];
        if (!panel || (key !== view && (!visited.has(key) || (key !== "booking" && key !== "records")))) return null;
        return <div id={`view-${key}`} key={key} hidden={key !== view} tabIndex={-1} aria-label={panel.label}>{panel.body}</div>;
      })}
    </div>
  );
}
