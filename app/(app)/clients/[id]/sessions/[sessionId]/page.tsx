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
import {
  resolveSessionPaymentDefault,
  type SessionPaymentDefaultAmount,
} from "@/lib/billing/session-payment-default-amount";
import { todayInTz } from "@/lib/booking/tz";
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
  let sessionPaymentDefault: SessionPaymentDefaultAmount | null = null;
  const paymentApptId = sessionPaymentEligibility.appointment?.id ?? null;
  if (paymentApptId) {
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
    const { data: apptRow, error: apptErr } = await supabaseForDefault
      .from("appointments")
      .select("duration_minutes, service:services(name, price_cents)")
      .eq("studio_id", studio.id)
      .eq("id", paymentApptId)
      .maybeSingle();
    if (apptErr) {
      // Never throw: a failed default-amount read must not block charting. But
      // it must be OBSERVABLE — swallowing it is what let this regress for a
      // week. No client data in the log line.
      console.error(
        JSON.stringify({
          event: "session_payment_default_amount_read_failed",
          appointment_id: paymentApptId,
          code: apptErr.code ?? null,
          message: apptErr.message ?? null,
        }),
      );
    }
    const svcEmbed = (apptRow as { service?: unknown } | null)?.service;
    const svcObj = (Array.isArray(svcEmbed) ? svcEmbed[0] : svcEmbed) as {
      name?: string | null;
      price_cents?: number | null;
    } | null;
    if (svcObj?.name) {
      const { data: pricingRows } = await supabaseForDefault
        .from("client_pricing")
        .select("service_name, price_cents, notes, effective_from")
        .eq("studio_id", studio.id)
        .eq("client_id", id);
      sessionPaymentDefault = resolveSessionPaymentDefault({
        service: {
          name: svcObj.name,
          price_cents: svcObj.price_cents ?? null,
        },
        appointmentDurationMinutes:
          (apptRow as { duration_minutes?: number | null } | null)
            ?.duration_minutes ?? null,
        customPricing: (pricingRows ?? []) as Array<{
          service_name: string;
          price_cents: number;
          notes: string | null;
          effective_from: string;
        }>,
        today: todayInTz(studio.timezone),
      });
    }
  }

  // Electrolysis sessions render through the block-grouped view. We fetch
  // the with-blocks shape only when needed.
  const blockData =
    session.modality === "electrolysis"
      ? await getSessionWithBlocks(sessionId)
      : null;

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

      {/* PR #181. id="session-payment" anchor so the calendar
          NextStepCard's "Go to billing" link deep-scrolls into the
          payment card. The wrapper is a noop visually; the anchor
          is the entire surface the practitioner is looking for. */}
      <div id="session-payment">
        <SessionPaymentPrepareCard
          sessionId={session.id}
          clientId={id}
          eligibility={sessionPaymentEligibility}
          defaultAmount={sessionPaymentDefault}
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

      {/* PR #235: the risks/aftercare stamp is markable right where
          charting happens, instead of only from the Records page.
          SAME toggle component and SAME server action as the Records
          procedure row (PR #205); no new write path. */}
      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <div>
          <h2 className="text-lg font-medium">Risks &amp; aftercare</h2>
          <p className="text-sm text-neutral-500">
            Recorded on the client procedure record for this session.
          </p>
        </div>
        {isFinalized ? (
          <p className="text-sm text-neutral-800 dark:text-neutral-200">
            {session.aftercare_and_risks_explained_at
              ? "Risks & aftercare explained (recorded on the procedure record)."
              : "Risks & aftercare were not marked as explained."}
          </p>
        ) : (
          <AftercareExplainedToggle
            sessionId={session.id}
            explainedAt={session.aftercare_and_risks_explained_at ?? null}
            action={markAftercareExplainedAction}
          />
        )}
      </section>

      {/* PR #238 (Chloe pilot): "How do I save and complete the
          session?" Everything on this page already saves per piece
          (each treatment area, the next-visit note, the risks &
          aftercare stamp), so there is nothing left to submit at the
          end; this section says that plainly and gives an obvious
          way OUT of charting. Links only: no new write path, no
          duplicate submit buttons, nothing sticky covering fields. */}
      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <div>
          <h2 className="text-lg font-medium">Finish up</h2>
          <p className="text-sm text-neutral-500">
            Everything above is already saved as you go: each treatment area,
            the next-visit note, and the risks &amp; aftercare stamp save with
            their own buttons. There is no separate session save.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* PR 1 (charting hardening): "Done charting" now shows a NON-BLOCKING
              aftercare prompt when the session has no aftercare stamp. It never
              blocks — "Continue without marking" always proceeds. When the stamp
              is present it behaves like the old plain link. */}
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
              aftercareExplained={session.aftercare_and_risks_explained_at != null}
              markAction={markAftercareExplainedAction}
            />
          )}
          {paymentApptId && (
            <Link
              href={`/calendar/${paymentApptId}`}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-900 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-100"
            >
              Review appointment &amp; billing
            </Link>
          )}
        </div>
      </section>

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
