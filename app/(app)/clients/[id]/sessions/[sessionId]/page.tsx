import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  getCurrentPractitionerWithStudio,
  getLaserTreatmentCountsForClient,
  getPriorLaserSessionCount,
  getRecentEntryForClient,
  getSessionAudit,
  getSessionForClient,
  getSessionWithBlocks,
} from "@/lib/supabase/queries";
import { LogLaserEntryForm } from "@/components/log-laser-entry-form";
import { LaserEntryRow } from "@/components/entry-row";
import { SessionInfoCard } from "@/components/session-info-card";
import { getClientTags } from "@/lib/client-tags/queries";
import {
  getActiveTreatmentPlansForClient,
  getTreatmentPlanWithCount,
} from "@/lib/treatment-plans/queries";
import { getSessionNumberForClient } from "@/lib/treatment-time/queries";
import { TreatmentPlanAttachment } from "@/components/treatment-plan-attachment";
import { TreatmentPlanBanner } from "@/components/treatment-plan-banner";
import type { LaserEntry } from "@/lib/types/database";
import { sessionPerformerName } from "@/lib/supabase/queries";
import { EditSessionStartedAt } from "./EditSessionStartedAt";
import { SessionEditHistory } from "./SessionEditHistory";
import { DeleteSessionForm } from "./DeleteSessionForm";
import { SessionBlocksView } from "./session-blocks-view";
import {
  addLaserEntryAction,
  deleteLaserEntryAction,
  updateSessionPerformerAction,
  updateSessionPriceAction,
} from "./actions";
import {
  attachChartEntryToPlanAction,
  detachChartEntryFromPlanAction,
} from "../../treatment-plans-actions";

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
  const sessionEntryIds = new Set([
    ...session.electrolysis_entries.map((e) => e.id),
    ...session.laser_entries.map((e) => e.id),
  ]);
  const lastEntryNotFromThisSession =
    lastEntry && !sessionEntryIds.has(lastEntry.id) ? lastEntry : null;

  const treatmentCounts =
    session.modality === "laser"
      ? await getLaserTreatmentCountsForClient(studio.id, id)
      : {};

  const performerName = sessionPerformerName(session, clientData.practitioners);
  const audit = await getSessionAudit(session.id);
  const clientTags = await getClientTags(studio.id, id);

  // Electrolysis sessions render through the block-grouped view. We fetch
  // the with-blocks shape only when needed.
  const blockData =
    session.modality === "electrolysis"
      ? await getSessionWithBlocks(sessionId)
      : null;

  // Treatment plan attachment context: the active plans the practitioner
  // can attach to (excludes closed), plus the resolved attached plan + its
  // count if this session is already attached.
  const [activePlansForClient, attachedPlan] = await Promise.all([
    getActiveTreatmentPlansForClient(studio.id, id),
    session.treatment_plan_id
      ? getTreatmentPlanWithCount(studio.id, session.treatment_plan_id)
      : Promise.resolve(null),
  ]);

  // Running total: only shown for electrolysis sessions (the modality the
  // treatment-time system tracks). Laser sessions skip the line.
  const runningTotal =
    session.modality === "electrolysis"
      ? await getSessionNumberForClient(studio.id, id, session.id)
      : null;
  // Modality context: how many laser sessions the client had before this
  // electrolysis session. Read-only count; never counts the current
  // session. Only fetched for electrolysis sessions.
  const priorLaserCount =
    session.modality === "electrolysis"
      ? await getPriorLaserSessionCount(studio.id, id, session.started_at)
      : 0;
  const clientFirstName = clientData.client.name.split(/\s+/)[0] || clientData.client.name;
  // " · 1 laser session previously" / " · 3 laser sessions previously"
  const priorLaserClause =
    priorLaserCount > 0
      ? ` · ${priorLaserCount} laser session${priorLaserCount === 1 ? "" : "s"} previously`
      : "";

  return (
    <div className="flex flex-col gap-8">
      {attachedPlan && <TreatmentPlanBanner plan={attachedPlan} />}

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
        {runningTotal && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {runningTotal.sessionNumber === 1
              ? `First electrolysis session for ${clientFirstName}${priorLaserClause}`
              : `Electrolysis session ${runningTotal.sessionNumber} for ${clientFirstName}${priorLaserClause}`}
          </p>
        )}
        <SessionEditHistory
          startedAtOriginal={session.started_at_original}
          audit={audit}
          practitioners={clientData.practitioners}
        />
        <TreatmentPlanAttachment
          sessionId={session.id}
          clientId={id}
          attachedPlan={
            attachedPlan
              ? {
                  id: attachedPlan.id,
                  name: attachedPlan.name,
                  status: attachedPlan.status,
                }
              : null
          }
          activePlans={activePlansForClient.map((p) => ({
            id: p.id,
            name: p.name,
          }))}
          attachAction={attachChartEntryToPlanAction}
          detachAction={detachChartEntryFromPlanAction}
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

      {session.modality === "electrolysis" && blockData ? (
        <SessionBlocksView
          sessionId={session.id}
          clientId={id}
          blocks={blockData.blocks}
          orphanEntries={blockData.orphan_entries}
          clientTagLabels={clientTags.map((t) => t.label)}
        />
      ) : (
        <>
          <LogLaserEntryForm
            sessionId={session.id}
            clientId={id}
            lastEntry={lastEntryNotFromThisSession as LaserEntry | null}
            treatmentCounts={treatmentCounts}
            action={addLaserEntryAction}
          />
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">
              Entries this session
              <span className="ml-2 text-sm font-normal text-neutral-500">
                {session.laser_entries.length}
              </span>
            </h2>
            <LaserEntriesSection
              clientId={id}
              sessionId={session.id}
              entries={session.laser_entries}
            />
          </section>
        </>
      )}

      <div className="pt-6">
        <DeleteSessionForm sessionId={session.id} clientId={id} />
      </div>
    </div>
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
