"use client";

import { useEffect, useState, type ReactNode } from "react";
import { WaitlistNavLink } from "@/components/waitlist/waitlist-nav-link";
import { useInviteOutcomePending } from "@/components/waitlist/invite-pending-context";
import { WAITLIST_PATH, WAITLIST_SEARCH_PATH } from "@/lib/waitlist/paths";
import { workspaceView, type WorkspaceView } from "@/lib/waitlist/workspace-view";
import styles from "./workspace-queue.module.css";

const tabs = [
  { id: "waiting", label: "Waiting", href: WAITLIST_PATH },
  { id: "invited", label: "Invited", href: WAITLIST_PATH + "?section=invited" },
  { id: "responses", label: "Responses", href: WAITLIST_PATH + "?tab=responses" },
  { id: "history", label: "History", href: WAITLIST_PATH + "?tab=history" },
] as const;

export function WorkspaceQueue({ initialView, waiting, invited, responses, responseLabel, searchMin, searchMax, children }: {
  initialView: WorkspaceView;
  waiting: number;
  invited: number;
  responses: string | null;
  responseLabel: string;
  searchMin: number;
  searchMax: number;
  children?: ReactNode;
}) {
  const counts = { waiting, invited, responses, history: null };
  const pending = useInviteOutcomePending();
  const [view, setView] = useState(initialView);

  // Bookmarks and previously delivered messages may contain only a fragment.
  // The server cannot see it; reveal the target group before scrolling to it.
  useEffect(() => {
    let frame = 0;
    function revealAnchor() {
      cancelAnimationFrame(frame);
      const id = window.location.hash.slice(1);
      const target = document.getElementById(id);
      const section = target?.closest<HTMLElement>("[data-workspace-section]")?.dataset.workspaceSection;
      if (id === "follow-up") setView("responses");
      else if (id.startsWith("entry-") && section) setView(workspaceView({ section }));
      else setView(initialView);
      if (target && (id === "follow-up" || id.startsWith("entry-"))) {
        frame = requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
      }
    }
    revealAnchor();
    window.addEventListener("hashchange", revealAnchor);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", revealAnchor);
    };
  }, [initialView]);

  return (
    <div className={styles.workspace + " flex min-w-0 flex-col gap-4"} data-view={view}>
      <nav aria-label="Waitlist views" className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-neutral-50 p-1 sm:grid-cols-4 dark:bg-neutral-900">
        {tabs.map(({ id, label, href }) => {
          const count = counts[id];
          return (
            <WaitlistNavLink
              key={id}
              href={href}
              aria-current={view === id ? "page" : undefined}
              className={"flex min-h-11 items-center justify-center gap-2 rounded-lg px-2 text-sm font-medium " +
                (view === id ? "bg-surface text-fg shadow-sm ring-1 ring-line" : "text-fg-muted hover:text-fg")}
            >
              {label}
              {count !== null && (
                <span title={id === "responses" ? responseLabel : undefined} className="rounded-md bg-neutral-100 px-1.5 text-xs tabular-nums dark:bg-neutral-800">
                  {count}{id === "responses" && <span className="sr-only"> {responseLabel}</span>}
                </span>
              )}
            </WaitlistNavLink>
          );
        })}
      </nav>
      <form action={WAITLIST_SEARCH_PATH} role="search" aria-label="Search the waitlist by name" className="flex w-full max-w-lg gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search the waitlist by name</span>
          <input name="q" type="search" required minLength={searchMin} maxLength={searchMax} disabled={pending}
            placeholder="Search waitlist by name" className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm" />
        </label>
        <button type="submit" disabled={pending} className="min-h-11 rounded-lg border border-line px-4 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:hover:bg-neutral-900">Search</button>
      </form>
      {children}
    </div>
  );
}
