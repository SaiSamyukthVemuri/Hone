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
import { SessionPerformerLine } from "@/components/session-performer-line";
import { SessionPaymentPrepareCard } from "@/components/session-payment-prepare-card";
import { getSessionPaymentEligibility } from "@/lib/billing/session-payment-eligibility";
import { AftercareExplainedToggle } from "@/app/(app)/records/record-forms";
import { markAftercareExplainedAction } from "@/app/(app)/records/actions";
import { DoneChartingButton } from "./DoneChartingButton";
import { todayInTz } from "@/lib/booking/tz";
import { getAuthoritativeSessionPaymentAmount } from "@/lib/billing/authoritative-session-payment";
import {
  executeSessionPaymentChargeAction,
  prepareSessionPaymentChargeAction,
  refundPaymentChargeAttemptAction,
  sendPaymentChargeReceiptAction,
} from "./payment-actions";
import { getClientTags } from "@/lib/client-tags/queries";
import {
  getActiveTreatmentPlansForClient,
  getTreatmentPlanWithCount,
} from "@/lib/treatment-plans/queries";
import { getSessionNumberForClient } from "@/lib/treatment-time/queries";
import {
  getProbeLotInventory,
  getProbeLotSuggestions,
} from "@/lib/record-keeping/queries";
import { TreatmentPlanAttachment } from "@/components/treatment-plan-attachment";
import { TreatmentPlanBanner } from "@/components/treatment-plan-banner";
import type { LaserEntry } from "@/lib/types/database";
import { EditSessionStartedAt } from "./EditSessionStartedAt";
import { SessionEditHistory } from "./SessionEditHistory";
import { DeleteSessionForm } from "./DeleteSessionForm";
import { NextVisitNoteForm } from "./NextVisitNoteForm";
import { CopyPreviousAreasPanel } from "./CopyPreviousAreasPanel";
import { RemovePassButton } from "@/components/remove-pass-button";
import { SessionBlocksView } from "./session-blocks-view";
import {
  addLaserEntryAction,
  deleteLaserEntryAction,
  updateNextSessionNoteAction,
  updateSessionPerformerAction,
} from "./actions";
import { createClient } from "@/lib/supabase/server";
import {
  attachChartEntryToPlanAction,
  detachChartEntryFromPlanAction,
} from "../../treatment-plans-actions";
import {
  addClinicalNoteAction,
  reviseClinicalNoteAction,
} from "../../clinical-notes-actions";
import { buildClinicalNoteSections } from "@/lib/clinical-notes/section-data";
import { loadLastChartedTreatment } from "@/lib/sessions/last-treatment-loader";
import { buildPointOfCareMemory } from "@/lib/sessions/point-of-care-memory";
import { LastTreatmentMemoryCard } from "@/components/last-treatment-memory-card";
import {
  resolveFinishAppointmentState,
  chartingLabel,
  aftercareLabel,
  completionLabel,
  postcareLabel,
} from "@/lib/sessions/finish-appointment";
import { MarkAppointmentCompleteControl } from "@/components/appointment/mark-complete-control";
import { PostcareSection } from "@/components/appointment/postcare-section";
import { ClinicalNotesSection } from "@/components/clinical-notes-section";

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId } = await params;
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

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

  const audit = await getSessionAudit(session.id);
  const clientTags = await getClientTags(studio.id, id);

  // Migration 0126: dated consultation + skin/hair analysis clinical notes,
  // shown compact during charting (latest of each kind + inline add/revise;
  // history bounded + collapsed).
  const clinicalNoteSections = await buildClinicalNoteSections(id, {
    historyLimit: 10,
  });

  // PR #172. Session payment eligibility resolves whether the
  // practitioner can prepare a session_payment charge attempt
  // (test mode only; no Stripe call). The card renders blocked /
  // existing-attempt / ready states. Computed here so the page
  // can decide whether to render the card at all (it always
  // does in v1 -- the card is the surface where blocking
  // reasons become visible).
  const sessionPaymentEligibility = await getSessionPaymentEligibility({
    studioId: studio.id,
    sessionId: session.id,
  });

  // PR #200 (Chloe iPad retest): default the Session payment amount
  // from the booked service. Two narrow reads (appointment + service
  // join, then this client's custom pricing) feed the pure resolver;
  // custom pricing for the same service name wins over the menu
  // price, future-dated rows are ignored, and a service without a
  // price leaves the form on its existing manual behavior. Display
  // default ONLY: the field stays editable, the prepare action still
  // validates the submitted amount, and the executor still charges
  // the prepared row's stored amount.
  // F-PAY-001: ONE authoritative pricing decision, from the shared trusted
  // loader. The page no longer computes a "display default" of its own, and
  // there is no historical-session-price fallback.
  const pricedForPage = await getAuthoritativeSessionPaymentAmount({
    studioId: studio.id,
    sessionId: session.id,
    studioTimezone: studio.timezone,
  });
  const sessionPaymentAmount = pricedForPage.ok ? pricedForPage.result : null;
  // Populated from the SAME widened appointment read below; feeds the Finish
  // appointment workflow without a second read of the same row.
  let apptContext: {
    status: string | null;
    endsAt: string | null;
    postcareSentAt: string | null;
    postcareFailedAt: string | null;
    postcareClaimedAt: string | null;
    postcareSendAttempts: number;
    serviceName: string | null;
    serviceModality: string | null;
    startsAt: string | null;
    practitionerName: string | null;
  } | null = null;
  // THE appointment identity for this page: sessions.appointment_id. Taken
  // directly from the session row, NOT from the billing eligibility result —
  // the Finish workflow must not depend on billing-domain types, and lineage is
  // verified below against BOTH studio and client.
  const linkedAppointmentId = session.appointment_id ?? null;
  if (linkedAppointmentId) {
    const supabaseForDefault = await createClient();
    // BARE-TABLE embed, not a column hint. Migration 0151 replaced the
    // single-column appointments.service_id FK with a composite
    // (service_id, studio_id) FK, and PostgREST resolves an
    // `alias:<fk_column>(...)` hint only against a SINGLE-column FK. The old
    // column-hint form therefore returned PGRST200 ("Could not
    // find a relationship between 'appointments' and 'service_id'") on every
    // request, the error was discarded, and the booked-service default amount
    // was silently null on this page while quick checkout — which already used
    // the bare-table form — kept working. Same class of breakage migration 0094
    // caused and commit 8f0517e swept; 0151 was not swept.
    // ONE appointment context read. It already existed for the booked-service
    // payment default; it is WIDENED here to also supply the Finish appointment
    // workflow (status, end time, postcare send-state, practitioner, modality)
    // rather than issuing a second read of the same row. Still bounded,
    // studio-scoped and appointment-id-scoped, still read-only.
    const { data: apptRow, error: apptErr } = await supabaseForDefault
      .from("appointments")
      .select(
        "duration_minutes, status, starts_at, ends_at, postcare_email_sent_at, postcare_email_failed_at, postcare_email_claimed_at, postcare_email_send_attempts, service:services(name, price_cents, modality), practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name)",
      )
      .eq("id", linkedAppointmentId)
      .eq("studio_id", studio.id)
      // Lineage: the appointment must belong to THIS client too. A session
      // pointing at another client's appointment yields no row, so the Finish
      // workflow renders no completion or postcare controls for it.
      .eq("client_id", id)
      .maybeSingle();
    if (apptErr) {
      // Never throw: a failed default-amount read must not block charting. But
      // it must be OBSERVABLE — swallowing it is what let this regress for a
      // week. No client data in the log line.
      console.error(
        JSON.stringify({
          event: "session_payment_default_amount_read_failed",
          appointment_id: linkedAppointmentId,
          code: apptErr.code ?? null,
          message: apptErr.message ?? null,
        }),
      );
    }
    {
      const row = apptRow as Record<string, unknown> | null;
      const svc = row?.service;
      const svcOne = (Array.isArray(svc) ? svc[0] : svc) as
        | { name?: string | null; modality?: string | null }
        | null;
      const prac = row?.practitioner;
      const pracOne = (Array.isArray(prac) ? prac[0] : prac) as
        | { display_name?: string | null }
        | null;
      apptContext = row
        ? {
            status: (row.status as string | null) ?? null,
            endsAt: (row.ends_at as string | null) ?? null,
            postcareSentAt: (row.postcare_email_sent_at as string | null) ?? null,
            postcareFailedAt: (row.postcare_email_failed_at as string | null) ?? null,
            postcareClaimedAt: (row.postcare_email_claimed_at as string | null) ?? null,
            postcareSendAttempts:
              (row.postcare_email_send_attempts as number | null) ?? 0,
            serviceName: svcOne?.name ?? null,
            serviceModality: svcOne?.modality ?? null,
            startsAt: (row.starts_at as string | null) ?? null,
            practitionerName: pracOne?.display_name ?? null,
          }
        : null;
    }

    const svcEmbed = (apptRow as { service?: unknown } | null)?.service;
    const svcObj = (Array.isArray(svcEmbed) ? svcEmbed[0] : svcEmbed) as {
      name?: string | null;
      price_cents?: number | null;
    } | null;
  }

  // Electrolysis sessions render through the block-grouped view. We fetch
  // the with-blocks shape only when needed.
  const blockData =
    session.modality === "electrolysis"
      ? await getSessionWithBlocks(sessionId)
      : null;


  // FINISH APPOINTMENT workflow context, derived from what is already loaded:
  // the widened appointment read above, the session, the client, and the studio
  // (studio:studios(*) already carries every postcare column). NO new query.
  const finishAppt = apptContext;
  // LIVE charting for THIS session's modality. Electrolysis charts as settings
  // blocks; laser charts as laser_entries. Counting blocks alone made every
  // laser session read "No treatment charted yet" even when fully charted,
  // because blockData is only loaded for electrolysis.
  //
  // getSessionForClient already runs stripDeletedEntries(), so
  // session.laser_entries is live-only; the block list is filtered explicitly
  // here because getSessionWithBlocks returns soft-deleted rows too.
  const liveChartedCount =
    session.modality === "electrolysis"
      ? (blockData?.blocks ?? []).filter((b) => b.deleted_at == null).length
      : (session.laser_entries ?? []).filter((e) => e.deleted_at == null).length;

  const finishState = resolveFinishAppointmentState({
    chartedBlockCount: liveChartedCount,
    aftercareExplainedAt: session.aftercare_and_risks_explained_at ?? null,
    // Joined by sessions.appointment_id — NEVER by client id, because a client
    // can have several appointments and the wrong one would be completed.
    appointment: finishAppt
      ? {
          id: linkedAppointmentId as string,
          status: finishAppt.status ?? "",
          startsAt: finishAppt.startsAt,
          endsAt: finishAppt.endsAt,
        }
      : null,
    clientEmail: clientData.client.email ?? null,
    postcareConfigured:
      !!studio.postcare_aftercare_text &&
      studio.postcare_aftercare_text.trim().length > 0,
    isOwner: practitioner.role === "owner",
    postcareSentAt: finishAppt?.postcareSentAt ?? null,
    postcareFailedAt: finishAppt?.postcareFailedAt ?? null,
    postcareClaimedAt: finishAppt?.postcareClaimedAt ?? null,
    postcareSendAttempts: finishAppt?.postcareSendAttempts ?? 0,
    serviceModality: finishAppt?.serviceModality ?? null,
    // Injected clock: the presenter never reads one itself.
    nowMs: Date.now(),
  });

  // PR #279 (Chloe charting feedback): the latest current probe lot/batch from
  // Feature A (Chloe charting feedback): the most recent lot/batch used for
  // each probe (probe_key) in THIS studio, as a probe_key -> lot map. The
  // charting form auto-populates the lot field from the map for the probe the
  // practitioner selects (never auto-confirmed; studio-scoped). Electrolysis
  // only; read-only. Replaces the pre-Feature-A studio-wide sterile-item
  // suggestion on this field (which was not probe-specific).
  const probeLotSuggestions =
    session.modality === "electrolysis"
      ? await getProbeLotSuggestions(studio.id)
      : { byKey: {}, byLabel: {} };

  // Migration 0128 charting release: the studio's ACTIVE probe-lot inventory
  // (record_keeping_sterile_items probe rows) for the searchable lot selector.
  // Electrolysis only; studio-scoped. Manual entry always stays available.
  const probeLotInventory =
    session.modality === "electrolysis"
      ? await getProbeLotInventory(studio.id)
      : [];

  // Treatment plan attachment context: the active plans the practitioner
  // can attach to (excludes closed), plus the resolved attached plan + its
  // count if this session is already attached.
  const [activePlansForClient, attachedPlan] = await Promise.all([
    getActiveTreatmentPlansForClient(studio.id, id),
    session.treatment_plan_id
      ? getTreatmentPlanWithCount(studio.id, session.treatment_plan_id)
      : Promise.resolve(null),
  ]);

  // UI defaulting (NOT attachment): the new-treatment-area picker is seeded
  // from a plan's first structured area. Prefer the attached plan; if the
  // session isn't attached — auto-attach only fires at session creation, and
  // only when the client has exactly one active electrolysis plan
  // (app/(app)/clients/[id]/sessions/new/actions.ts) — fall back to the
  // client's single active plan's first area. This is a starting value
  // only: fully editable, never forced, and it does NOT attach the session,
  // change charting, or mutate any plan/saved data.
  //
  // Multi-area plans (migration 0051): use treatment_areas[0] when set so
  // the practitioner can still benefit from defaulting even when the plan
  // covers multiple areas. Falls back to primary_area for plans created
  // before the multi-area reframing (which still keeps primary_area in
  // sync with treatment_areas[0] via the action writers).
  function defaultAreaForPlan(plan: {
    treatment_areas: string[] | null;
    primary_area: string | null;
  } | null): string | null {
    if (!plan) return null;
    if (plan.treatment_areas && plan.treatment_areas.length > 0) {
      return plan.treatment_areas[0] ?? null;
    }
    return plan.primary_area ?? null;
  }
  const defaultPrimaryArea: string | null =
    defaultAreaForPlan(attachedPlan) ??
    (activePlansForClient.length === 1
      ? defaultAreaForPlan(activePlansForClient[0] ?? null)
      : null);

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
  // PR #190 (clinical memory). The note the practitioner left FOR
  // this visit while charting the previous one. Narrow select; only
  // rendered when a note exists, so historical clients see nothing.
  const supabaseForNote = await createClient();
  const { data: previousWithNote } = await supabaseForNote
    .from("sessions")
    .select("id, started_at, next_session_note")
    .eq("studio_id", studio.id)
    .eq("client_id", id)
    .is("deleted_at", null)
    .not("next_session_note", "is", null)
    .lt("started_at", session.started_at)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromLastVisit =
    previousWithNote?.next_session_note?.trim() || null;

  // POINT-OF-CARE TREATMENT MEMORY (Chloe). Everything she needs to reproduce
  // last time's treatment — areas + laterality, frequency, probe and lot, mode
  // and modality, the mode-valid readings, hairs, minutes, numbing, tolerance
  // and response — used to live on the client Overview tab or inside the
  // previous session's own chart, two or three navigations from the screen she
  // is standing at. It renders here instead.
  //
  // ONE net-new query: the candidate sessions and their live entries are
  // already in clientData (getClientById), so only the prior settings blocks
  // are fetched, batched over the whole candidate window.
  //
  // The candidate is the newest CHARTED session, not the newest session ROW —
  // tapping a modality on /sessions/new creates an empty session immediately,
  // and an abandoned one used to win every "previous session" lookup.
  const lastTreatment = await loadLastChartedTreatment({
    studioId: studio.id,
    sessions: clientData.sessions,
    before: session.started_at,
    excludeSessionId: session.id,
  });
  // Latest non-superseded entry per note kind, from the sections ALREADY
  // loaded above. No extra query, no note body in any log line.
  const noteHead = (kind: "consultation" | "skin_hair_analysis") => {
    const section = clinicalNoteSections.find((s) => s.kind === kind);
    const latest = section?.notes.find((n) => !n.is_superseded) ?? null;
    return latest
      ? {
          occurredAt: latest.occurred_at,
          body: latest.body,
          authorName: latest.author_name,
          total: section?.total ?? 1,
        }
      : null;
  };
  const pointOfCareMemory = lastTreatment
    ? buildPointOfCareMemory({
        session: {
          id: lastTreatment.session.id,
          started_at: lastTreatment.session.started_at,
          modality: lastTreatment.session.modality,
          next_session_note: lastTreatment.session.next_session_note ?? null,
        },
        blocks: lastTreatment.blocks,
        consultationNote: noteHead("consultation"),
        skinHairNote: noteHead("skin_hair_analysis"),
        // The "From last visit, for today" band below already carries this
        // exact text; the card omits it rather than repeating it.
        planAlreadyShown: fromLastVisit,
        supersededByEmptySession: lastTreatment.supersededByEmptySession,
        // Distinguishes a legacy entry-only electrolysis visit from a laser one
        // when the selected treatment carries no settings blocks.
        hasLiveElectrolysisEntries:
          (lastTreatment.session.electrolysis_entries ?? []).some(
            (e) => e.deleted_at == null,
          ),
      })
    : null;

  // Whole-session copy (0157): the ONE canonical authority for whether an
  // eligible previous session exists is whole_session_copy_source_descriptor —
  // the SAME function the commit RPC derives its source from. We gate the panel
  // on it (not a separate "latest previous session" query), so page gating and
  // commit can never disagree about which session is the source.
  const { data: copyDescriptor } = await supabaseForNote.rpc(
    "whole_session_copy_source_descriptor",
    { p_studio_id: studio.id, p_target_session_id: session.id },
  );
  const canCopyFromPrevious = Boolean(
    (copyDescriptor as { eligible?: boolean } | null)?.eligible,
  );

  const clientFirstName = clientData.client.name.split(/\s+/)[0] || clientData.client.name;
  // " · 1 laser session previously" / " · 3 laser sessions previously"
  const priorLaserClause =
    priorLaserCount > 0
      ? ` · ${priorLaserCount} laser session${priorLaserCount === 1 ? "" : "s"} previously`
      : "";

  // Signed/finalized clinical records are RETIRED (migration 0159): there is no
  // Finalize control, no signed-correction control, and no studio flag that can
  // bring them back. `isFinalized` survives for exactly one reason — production
  // retains ONE legacy finalized session from a controlled non-Willow test studio,
  // and it must stay visibly read-only and undeletable. Every ordinary session is
  // 'draft' and fully editable, and the database now refuses any new transition
  // into 'finalized'/'void'. See docs/decisions/clinical-finalization-retired.md.
  const isFinalized =
    session.record_status === "finalized" || session.record_status === "void";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link
          href={`/clients/${id}?tab=sessions`}
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
        {/* PR #199 (Chloe iPad retest): the inline line under the
            title is the ONLY performer surface. The separate
            "Performed by" card/dropdown is gone; this line carries a
            small Edit affordance backed by the same server action. */}
        <SessionPerformerLine
          sessionId={session.id}
          clientId={id}
          practitioners={clientData.practitioners}
          initialPerformerId={
            session.performed_by_practitioner_id ?? session.practitioner_id
          }
          updatePerformerAction={updateSessionPerformerAction}
        />
        {/* PR #194 (Chloe retest): when a treatment plan is attached,
            the green plan card already carries the visit-progress
            context, so the "Electrolysis session N for X" line is
            redundant and hides. Unattached sessions keep it: it is
            the only session-count context they have. */}
        {runningTotal && !attachedPlan && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {runningTotal.sessionNumber === 1
              ? `First electrolysis session for ${clientFirstName}${priorLaserClause}`
              : `Electrolysis session ${runningTotal.sessionNumber} for ${clientFirstName}${priorLaserClause}`}
          </p>
        )}
        {/* PR #199 (Chloe iPad retest): the Detach affordance renders
            INSIDE the treatment plan card via the banner's detachSlot,
            so the plan card owns all plan context and actions. When no
            plan is attached, the attachment widget keeps its spot
            under the title. */}
        {attachedPlan ? (
          <TreatmentPlanBanner
            plan={attachedPlan}
            detachSlot={
              <TreatmentPlanAttachment
                sessionId={session.id}
                clientId={id}
                attachedPlan={{
                  id: attachedPlan.id,
                  name: attachedPlan.name,
                  status: attachedPlan.status,
                }}
                activePlans={[]}
                attachAction={attachChartEntryToPlanAction}
                detachAction={detachChartEntryFromPlanAction}
              />
            }
          />
        ) : (
          <TreatmentPlanAttachment
            sessionId={session.id}
            clientId={id}
            attachedPlan={null}
            activePlans={activePlansForClient.map((p) => ({
              id: p.id,
              name: p.name,
            }))}
            attachAction={attachChartEntryToPlanAction}
            detachAction={detachChartEntryFromPlanAction}
          />
        )}
        <SessionEditHistory
          startedAtOriginal={session.started_at_original}
          audit={audit}
          practitioners={clientData.practitioners}
        />
      </div>

      {/* Retired capability, retained artifact. Signed/finalized records are no
          longer a Hone capability (migration 0159) and no new session can enter
          this state. A handful of records were finalized while the old system was
          being trialled; they stay preserved and read-only at the database. */}
      {isFinalized && (
        <section className="rounded-lg border border-stone-300 bg-stone-50 p-4 text-sm dark:border-stone-700 dark:bg-stone-900/40">
          <span className="inline-flex items-center rounded-full bg-stone-600 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-white">
            Archived record · read-only
          </span>
          <p className="mt-2 text-stone-800 dark:text-stone-200">
            This is an archived clinical record from an earlier trial of
            record finalization, which Hone no longer offers. The treatment
            recorded below is preserved exactly as it was; it cannot be edited or
            deleted. New sessions are ordinary editable records.
          </p>
        </section>
      )}

      {/* POINT-OF-CARE MEMORY: what happened last time, at the top of the
          clinical workflow and BEFORE any block entry, so Chloe never has to
          leave this screen to answer "what did we do, with what, and how did
          she react?". Read-only; it issues no write and owns no state. Renders
          nothing at all for a client with no prior charted treatment. */}
      {pointOfCareMemory && (
        <LastTreatmentMemoryCard
          clientId={id}
          memory={pointOfCareMemory}
          notesHref={`/clients/${id}?tab=consultation`}
        />
      )}

      {/* PR #190 (clinical memory): the plan written at the previous
          visit, surfaced where Chloe starts working. Renders only
          when a note exists. */}
      {fromLastVisit && (
        <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/40">
          <h2 className="text-xs font-medium uppercase tracking-wider text-blue-800 dark:text-blue-300">
            From last visit, for today
          </h2>
          <p className="mt-1.5 whitespace-pre-wrap text-blue-950 dark:text-blue-100">
            {fromLastVisit}
          </p>
        </section>
      )}

      {/* PR #199: the separate "Performed by" card is gone; the
          inline SessionPerformerLine under the title is the single
          performer surface. */}


      {/* Migration 0157: whole-session "Copy areas and settings" — editable
          draft-model replacement for the paused one-tap copy. The preview is
          EPHEMERAL (component memory only); nothing is written until the
          practitioner explicitly confirms. Shown only on an empty editable
          electrolysis chart when the canonical source descriptor reports an
          eligible previous session (same authority the commit RPC uses). */}
      {!isFinalized &&
        session.modality === "electrolysis" &&
        blockData &&
        blockData.blocks.length === 0 &&
        canCopyFromPrevious && (
          <CopyPreviousAreasPanel clientId={id} sessionId={session.id} />
        )}

      {/* Migration 0126: consultation + skin/hair analysis context during
          charting. Collapsible so it never crowds the charting flow; the
          latest of each kind shows at a glance and can be added/revised inline
          without leaving the session. */}
      <details className="group rounded-lg border border-neutral-200 dark:border-neutral-800">
        <summary className="flex min-h-[44px] cursor-pointer items-center justify-between px-5 py-3 text-lg font-medium">
          Consultation &amp; skin/hair analysis
          <span className="text-xs font-normal text-neutral-500 group-open:hidden">
            Tap to open
          </span>
        </summary>
        <div className="px-5 pb-5">
          <ClinicalNotesSection
            clientId={id}
            variant="compact"
            sections={clinicalNoteSections}
            addAction={addClinicalNoteAction}
            reviseAction={reviseClinicalNoteAction}
            profileHref={`/clients/${id}?tab=consultation`}
            printHref={`/clients/${id}/clinical-notes/print`}
          />
        </div>
      </details>

      {session.modality === "electrolysis" && blockData ? (
        <SessionBlocksView
          sessionId={session.id}
          clientId={id}
          blocks={blockData.blocks}
          orphanEntries={blockData.orphan_entries}
          clientTagLabels={clientTags.map((t) => t.label)}
          probeLotSuggestions={probeLotSuggestions}
          probeLotInventory={probeLotInventory}
          // UI defaulting only: seed a NEW treatment area from the attached
          // plan, or the client's single active plan when unattached (see
          // above). Never overrides practitioner choice or mutates data.
          defaultPrimaryArea={defaultPrimaryArea}
          // PR #203 (migration 0084): sticky machine frequency. The
          // practitioner's last-used value seeds NEW treatment-area
          // drafts; still editable per area, still saved per block.
          defaultMachineFrequency={practitioner.default_machine_frequency ?? null}
        />
      ) : (
        <>
          {!isFinalized && (
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

      {/* PR #190 (clinical memory): plan for the NEXT visit. Saved on
          sessions.next_session_note and shown as "From last visit"
          when the client returns. Optional; empty save clears it. */}
      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <div>
          <h2 className="text-lg font-medium">For next visit</h2>
          {/* PR #199: this is now the ONE place to write next-visit
              instructions; the per-area "For next visit / Caution for
              next session" inputs are gone from the charting form. */}
          <p className="text-sm text-neutral-500">
            Anything to remember, watch, or do differently next time. Shown to
            you when {clientFirstName} comes back.
          </p>
        </div>
        {isFinalized ? (
          <p className="whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-200">
            {session.next_session_note?.trim()
              ? session.next_session_note
              : "No next-visit note."}
          </p>
        ) : (
          <NextVisitNoteForm
            sessionId={session.id}
            clientId={id}
            initialNote={session.next_session_note ?? ""}
            action={updateNextSessionNoteAction}
          />
        )}
      </section>


      {/* FINISH APPOINTMENT (Chloe). She charts the visit, then the two
          consequential closing actions — marking the appointment completed and
          sending postcare — live on the calendar appointment page, a different
          surface. So they get forgotten, and payment (which is gated on
          completion) stays locked. This section brings the EXISTING trusted
          controls into one visible checklist: the shared completion control and
          the shared postcare section, not reimplementations.

          Everything above still saves as you go; nothing here is a new
          lifecycle system. */}
      <section
        data-testid="finish-appointment"
        className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
      >
        <div>
          <h2 className="text-lg font-medium">Finish appointment</h2>
          <p className="text-sm text-neutral-500">
            Review the visit, complete the appointment, and send postcare before
            leaving.
          </p>
        </div>

        {/* 1. TREATMENT CHART — informational. Deliberately NOT a block on
            completion: completion is already possible today with an empty
            chart, and silently introducing a clinical lock here would be a new
            restriction nobody asked for. */}
        <div className="flex flex-col gap-1 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Treatment chart
          </span>
          <span
            data-testid="finish-charting-status"
            className={
              finishState.charting === "charted"
                ? "text-sm text-neutral-700 dark:text-neutral-300"
                : "text-sm text-amber-800 dark:text-amber-300"
            }
          >
            {chartingLabel(finishState.charting)}
          </span>
        </div>

        {/* 2. RISKS & AFTERCARE EXPLAINED — the session stamp, distinct from
            the postcare email. "Explained" means she discussed it; "sent" means
            an email was handed to the provider. Never auto-stamped. */}
        <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Risks &amp; aftercare explained
          </span>
          <span
            data-testid="finish-aftercare-status"
            className="text-sm text-neutral-700 dark:text-neutral-300"
          >
            {aftercareLabel(finishState.aftercare)}
          </span>
          {/* The EXISTING toggle, always rendered for an editable session so
              both of its states survive: it shows "✓ Risks explained and
              aftercare provided" once marked, and can still be un-marked if she
              taps it by mistake. Gating it on "not marked" would have removed
              both, which is a behaviour change nobody asked for. */}
          {!isFinalized && (
            <AftercareExplainedToggle
              sessionId={session.id}
              explainedAt={session.aftercare_and_risks_explained_at ?? null}
              action={markAftercareExplainedAction}
            />
          )}
        </div>

        {/* 3. APPOINTMENT COMPLETED — only when a booked appointment is linked
            (by sessions.appointment_id, never by client). Uses THE shared
            completion control, so the end-time gate, the accessible
            confirmation, single-flight and the audit row are the same ones the
            calendar surface has always used. No-show is deliberately absent. */}
        <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Appointment completed
          </span>
          <span
            data-testid="finish-completion-status"
            className={
              finishState.completion.kind === "completed"
                ? "text-sm font-medium text-green-700 dark:text-green-400"
                : "text-sm text-neutral-700 dark:text-neutral-300"
            }
          >
            {completionLabel(finishState.completion)}
          </span>
          {/* Mounted for BOTH before_end and ready. The shared control owns the
              disabled state AND the timer that re-enables the button the moment
              ends_at passes — mounting it only when already "ready" meant the
              timer never ran, so the button could not appear without a manual
              refresh, while the copy claimed it would update on its own. The
              control renders its own authoritative helper text when not ended,
              so there is no second explanation and no second timer. */}
          {!isFinalized &&
            linkedAppointmentId &&
            (finishState.completion.kind === "ready" ||
              finishState.completion.kind === "before_start") && (
              <MarkAppointmentCompleteControl
                appointmentId={linkedAppointmentId}
                startsAt={finishState.completion.startsAt}
                notStartedHint="You can mark it completed once the appointment start time passes — this updates on its own."
                block
              />
            )}
        </div>

        {/* 4. POSTCARE EMAIL — THE shared section, identical to the calendar
            surface: same preview, same first-send claim, same consultation
            attestation, same failure honesty. Postcare stays an explicit manual
            action unless the studio's existing auto_on_complete setting sends
            it; nothing here auto-sends after completion. */}
        <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          {finishState.postcare.kind === "unlinked" ? (
            <>
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Postcare email
              </span>
              <span
                data-testid="finish-postcare-status"
                className="text-sm text-neutral-700 dark:text-neutral-300"
              >
                {postcareLabel(finishState.postcare)}
              </span>
            </>
          ) : (
            !isFinalized &&
            linkedAppointmentId && (
              <PostcareSection
                clientEmail={clientData.client.email ?? null}
                appointmentId={linkedAppointmentId}
                studioName={studio.name}
                studioEmail={
                  (studio.postcare_contact_email?.trim() ||
                    studio.owner_email) ?? null
                }
                studioTimezone={studio.timezone}
                aftercareText={studio.postcare_aftercare_text}
                warningSignsText={studio.postcare_warning_signs_text}
                productRecommendationsText={
                  studio.postcare_product_recommendations_text
                }
                reviewUrl={studio.postcare_review_url}
                reviewPromptText={studio.postcare_review_prompt_text}
                clientName={clientData.client.name}
                serviceName={apptContext?.serviceName ?? null}
                serviceModality={apptContext?.serviceModality ?? null}
                startsAt={apptContext?.startsAt ?? ""}
                practitionerName={apptContext?.practitionerName ?? null}
                postcareEmailSentAt={apptContext?.postcareSentAt ?? null}
                postcareEmailSendAttempts={
                  apptContext?.postcareSendAttempts ?? 0
                }
                postcareEmailClaimedAt={apptContext?.postcareClaimedAt ?? null}
                postcareEmailFailedAt={apptContext?.postcareFailedAt ?? null}
                isOwner={practitioner.role === "owner"}
              />
            )
          )}
        </div>

        {/* FINAL EXIT. The safe-exit semantics from DoneChartingButton move
            here intact: leaving without the aftercare stamp still requires the
            explicit warning, and "Continue without marking" still proceeds
            without writing anything. Nothing above navigates automatically —
            she must be able to SEE the updated statuses before leaving. */}
        <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3 sm:flex-row sm:items-center dark:border-neutral-800">
          {isFinalized ? (
            <Link
              href={`/clients/${id}?tab=sessions`}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Back to sessions
            </Link>
          ) : (
            <DoneChartingButton
              sessionId={session.id}
              doneHref={`/clients/${id}?tab=sessions`}
              aftercareExplained={
                session.aftercare_and_risks_explained_at != null
              }
              markAction={markAftercareExplainedAction}
              label="Done — back to client"
            />
          )}
        </div>
      </section>

      {/* MOVED, NOT CHANGED (Chloe's flow: chart → finish → pay). This block
          used to sit ABOVE the charting content, so payment was the first thing
          on the page and the completion it depends on was the last. It is
          relocated verbatim — same wrapper, same anchor, same component, same
          props, same actions — so the practitioner reaches it immediately after
          completing the appointment that unlocks it. */}
      {/* PR #181. id="session-payment" anchor so the calendar
          NextStepCard's "Go to billing" link deep-scrolls into the
          payment card. The wrapper is a noop visually; the anchor
          is the entire surface the practitioner is looking for. */}
      <div id="session-payment">
        <SessionPaymentPrepareCard
          sessionId={session.id}
          clientId={id}
          eligibility={sessionPaymentEligibility}
          amountResult={sessionPaymentAmount}
          // Trusted, server-derived owner flag — gates the owner-only Technical
          // payment details disclosure + the Refund button (server refund
          // authorization is unchanged; it is owner-only there too).
          isOwner={practitioner.role === "owner"}
          prepareAction={prepareSessionPaymentChargeAction}
          executeAction={executeSessionPaymentChargeAction}
          sendReceiptAction={sendPaymentChargeReceiptAction}
          refundAction={refundPaymentChargeAttemptAction}
        />
      </div>

      {/* An archived (legacy finalized) record cannot be soft-deleted — the DB
          guard from 0119 still enforces that — so the destructive control is
          withdrawn for it. Ordinary sessions keep it. */}
      {!isFinalized && (
        <div className="pt-6">
          <DeleteSessionForm sessionId={session.id} clientId={id} />
        </div>
      )}
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
              <RemovePassButton
                action={deleteLaserEntryAction}
                entryId={e.id}
                sessionId={sessionId}
                clientId={clientId}
                ariaLabel={sorted.length > 1 ? "Remove laser pass" : "Remove pass"}
              />
            }
          />
        </li>
      ))}
    </ul>
  );
}
