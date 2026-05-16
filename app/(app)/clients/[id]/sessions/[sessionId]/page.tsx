import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getActiveProbeLots,
  getClientById,
  getCurrentPractitionerWithStudio,
  getRecentEntryForClient,
  getSessionForClient,
} from "@/lib/supabase/queries";
import { LogElectrolysisEntryForm } from "@/components/log-electrolysis-entry-form";
import { LogLaserEntryForm } from "@/components/log-laser-entry-form";
import type { ElectrolysisEntry, LaserEntry } from "@/lib/types/database";
import {
  addElectrolysisEntryAction,
  addLaserEntryAction,
  deleteElectrolysisEntryAction,
  deleteLaserEntryAction,
} from "./actions";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link
          href={`/clients/${id}`}
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← {clientData.client.name}
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-3xl font-semibold tracking-tight capitalize">
            {session.modality} session
          </h1>
          <p className="text-sm text-neutral-500">
            Started {formatDate(session.started_at)}
          </p>
        </div>
      </div>

      {session.modality === "electrolysis" ? (
        <LogElectrolysisEntryForm
          sessionId={session.id}
          clientId={id}
          probeLots={probeLots}
          lastEntry={lastEntryNotFromThisSession as ElectrolysisEntry | null}
          action={addElectrolysisEntryAction}
        />
      ) : (
        <LogLaserEntryForm
          sessionId={session.id}
          clientId={id}
          lastEntry={lastEntryNotFromThisSession as LaserEntry | null}
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
        <li
          key={e.id}
          className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950 md:flex-row md:items-start md:justify-between"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium">{e.area}</span>
              {e.probe_size && (
                <span className="text-xs text-neutral-500">
                  probe {e.probe_size}
                </span>
              )}
              {e.mode && (
                <span className="text-xs text-neutral-500">{e.mode}</span>
              )}
              {e.intensity != null && (
                <span className="text-xs text-neutral-500">
                  int {e.intensity}
                </span>
              )}
              {e.duration_seconds != null && (
                <span className="text-xs text-neutral-500">
                  {e.duration_seconds}s
                </span>
              )}
            </div>
            {e.comments && (
              <div className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
                {e.comments}
              </div>
            )}
          </div>
          <form action={deleteElectrolysisEntryAction}>
            <input type="hidden" name="id" value={e.id} />
            <input type="hidden" name="session_id" value={sessionId} />
            <input type="hidden" name="client_id" value={clientId} />
            <button
              type="submit"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Delete
            </button>
          </form>
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
      {sorted.map((e) => {
        const params = (e.equipment_params ?? {}) as Record<string, unknown>;
        return (
          <li
            key={e.id}
            className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950 md:flex-row md:items-start md:justify-between"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium">{e.zone}</span>
                {e.session_number != null && (
                  <span className="text-xs text-neutral-500">
                    #{e.session_number}
                  </span>
                )}
                {typeof params.fluence === "string" && params.fluence && (
                  <span className="text-xs text-neutral-500">
                    fluence {params.fluence}
                  </span>
                )}
                {typeof params.pulse_width === "string" && params.pulse_width && (
                  <span className="text-xs text-neutral-500">
                    pw {params.pulse_width}
                  </span>
                )}
                {typeof params.spot_size === "string" && params.spot_size && (
                  <span className="text-xs text-neutral-500">
                    spot {params.spot_size}
                  </span>
                )}
              </div>
              {e.observation_notes && (
                <div className="mt-1 text-sm text-neutral-700 dark:text-neutral-300">
                  {e.observation_notes}
                </div>
              )}
            </div>
            <form action={deleteLaserEntryAction}>
              <input type="hidden" name="id" value={e.id} />
              <input type="hidden" name="session_id" value={sessionId} />
              <input type="hidden" name="client_id" value={clientId} />
              <button
                type="submit"
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Delete
              </button>
            </form>
          </li>
        );
      })}
    </ul>
  );
}
