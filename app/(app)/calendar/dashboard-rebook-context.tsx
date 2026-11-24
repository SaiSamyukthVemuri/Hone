"use client";

import { createContext, useContext } from "react";
import { PendingLink } from "@/components/pending-link";
import { withDashboardRebook, type DashboardRebook } from "@/lib/calendar/dashboard-rebook";

export const DashboardRebookContext = createContext<DashboardRebook | null>(null);
export function useDashboardRebook() {
  return useContext(DashboardRebookContext);
}

export function DashboardRebookSummary({ rebook }: { rebook: DashboardRebook }) {
  return (
    <section aria-label="Rebooking" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div>
        <h2 className="font-semibold">Rebook {rebook.clientName}</h2>
        <p>Next appointment · {rebook.next === "unavailable" ? "Unavailable" : rebook.next?.label ?? "No upcoming appointment"}</p>
        {rebook.next && rebook.next !== "unavailable" && (
          <PendingLink href={withDashboardRebook(`/calendar?view=week&day=${rebook.next.day}`, rebook)} pendingLabel="Opening date…" className="text-xs underline">
            Show on calendar
          </PendingLink>
        )}
      </div>
      <PendingLink href={rebook.dashboardHref} pendingLabel="Returning…" className="rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700">Back to dashboard</PendingLink>
    </section>
  );
}
