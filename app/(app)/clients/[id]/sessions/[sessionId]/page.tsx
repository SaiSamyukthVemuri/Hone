import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getActiveProbeLots,
  getClientById,
  getCurrentPractitionerWithStudio,
  getLaserTreatmentCountsForClient,
  getRecentEntryForClient,
  getSessionAudit,
  getSessionForClient,
} from "@/lib/supabase/queries";
import { LogElectrolysisEntryForm } from "@/components/log-electrolysis-entry-form";
import { LogLaserEntryForm } from "@/components/log-laser-entry-form";
import { ElectrolysisEntryRow, LaserEntryRow } from "@/components/entry-row";
import { SessionInfoCard } from "@/components/session-info-card";
import type { ElectrolysisEntry, LaserEntry } from "@/lib/types/database";
import { sessionPerformerName } from "@/lib/supabase/queries";
import { EditSessionStartedAt } from "./EditSessionStartedAt";
import { SessionEditHistory } from "./SessionEditHistory";
import {
  addElectrolysisEntryAction,
  addLaserEntryAction,
  deleteElectrolysisEntryAction,
  deleteLaserEntryAction,
  updateSessionPerformerAction,
  updateSessionPriceAction,
} from "./actions";

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId } = await params;
  const { studio } = await getCurrentPractitionerWithStudio();

  const [clientData, session] = await Promise.all([
    getClientById(studio.id, id),
    getSessionForClient(studio.id, id, sessionId),
  ]);

  if (!clientData || !session) notFound();

  const lastEntry = await getRecentEntryForClient(
    studio.id,
    id,
    session.modality,
  );
  // Exclude entries from this same session so "copy from last" really means previous session.
  const sessionEntryIds = new Set([
    ...session.electrolysis_entries.map((e) => e.id),
    ...session.laser_entries.map((e) => e.id),
  ]);
  const lastEntryNotFromThisSession =
    lastEntry && !sessionEntryIds.has(lastEntry.id) ? lastEntry : null;

  const probeLots =
    session.modality === "electrolysis"
      ? await getActiveProbeLots(studio.id)
      : [];

  const treatmentCounts =
    session.modality === "laser"
      ? await getLaserTreatmentCountsForClient(studio.id, id)
      : {};

  const performerName = sessionPerformerName(session, clientData.practitioners);
  const audit = await getSessionAudit(session.id);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link
          href={`/clients/${id}`}
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← {clientData.client.name}
        </Link>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-3xl font-semibold tracking-tight capitalize">
            {session.modality} session
          </h1>
          <EditSessionStartedAt
            sessionId={session.id}
            clientId={id}
            startedAtIso={session.started_at}
          />
        </div>
        {performerName && (
          <p className="text-sm text-neutral-500">
            Performed by {performerName}
          </p>
        )}
        <SessionEditHistory
          startedAtOriginal={session.started_at_original}
          audit={audit}
          practitioners={clientData.practitioners}
        />
      </div>

      <SessionInfoCard
        sessionId={session.id}
        clientId={id}
        practitioners={clientData.practitioners}
        initialPerformerId={
          session.performed_by_practitioner_id ?? session.practitioner_id
        }
        initialPriceCents={session.price_paid_cents}
        updatePriceAction={updateSessionPriceAction}
        updatePerformerAction={updateSessionPerformerAction}
      />

      {session.modality === "electrolysis" ? (
        <LogElectrolysisEntryForm
          sessionId={session.id}
          clientId={id}
          probeLots={probeLots}
          lastEntry={lastEntryNotFromThisSession as ElectrolysisEntry | null}
          stickyDefaults={(() => {
            // Carry forward probe_type and machine_frequency from the latest
            // in-session entry. Migration 0011 moved these to the entry level.
            const sorted = [...session.electrolysis_entries].sort(
              (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime(),
            );
            const latest = sorted[0];
            return {
              probe_type: latest?.probe_type ?? "",
              machine_frequency: latest?.machine_frequency ?? "",
            };
          })()}
          action={addElectrolysisEntryAction}
        />
      ) : (
        <LogLaserEntryForm
          sessionId={session.id}
          clientId={id}
          lastEntry={lastEntryNotFromThisSession as LaserEntry | null}
          treatmentCounts={treatmentCounts}
          action={addLaserEntryAction}
        />
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Entries this session
          <span className="ml-2 text-sm font-normal text-neutral-500">
            {session.modality === "electrolysis"
              ? session.electrolysis_entries.length
              : session.laser_entries.length}
          </span>
        </h2>
        {session.modality === "electrolysis" ? (
          <ElectrolysisEntriesSection
            clientId={id}
            sessionId={session.id}
            entries={session.electrolysis_entries}
          />
        ) : (
          <LaserEntriesSection
            clientId={id}
            sessionId={session.id}
            entries={session.laser_entries}
          />
        )}
      </section>
    </div>
  );
}

function ElectrolysisEntriesSection({
  clientId,
  sessionId,
  entries,
}: {
  clientId: string;
  sessionId: string;
  entries: ElectrolysisEntry[];
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
        No entries yet.
      </div>
    );
  }
  const sorted = [...entries].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return (
    <ul className="flex flex-col gap-2">
      {sorted.map((e) => (
        <li key={e.id}>
          <ElectrolysisEntryRow
            entry={e}
            action={
              <form action={deleteElectrolysisEntryAction}>
                <input type="hidden" name="id" value={e.id} />
                <input type="hidden" name="session_id" value={sessionId} />
                <input type="hidden" name="client_id" value={clientId} />
                <button
                  type="submit"
                  aria-label="Delete entry"
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  ✕
                </button>
              </form>
            }
          />
        </li>
      ))}
    </ul>
  );
}

function LaserEntriesSection({
  clientId,
  sessionId,
  entries,
}: {
  clientId: string;
  sessionId: string;
  entries: LaserEntry[];
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
        No entries yet.
      </div>
    );
  }
  const sorted = [...entries].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return (
    <ul className="flex flex-col gap-2">
      {sorted.map((e) => (
        <li key={e.id}>
          <LaserEntryRow
            entry={e}
            action={
              <form action={deleteLaserEntryAction}>
                <input type="hidden" name="id" value={e.id} />
                <input type="hidden" name="session_id" value={sessionId} />
                <input type="hidden" name="client_id" value={clientId} />
                <button
                  type="submit"
                  aria-label="Delete entry"
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  ✕
                </button>
              </form>
            }
          />
        </li>
      ))}
    </ul>
  );
}
