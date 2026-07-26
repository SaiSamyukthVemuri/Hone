import Link from "next/link";
import { publishableKeyOk } from "@/lib/payments/payment-status-presenter";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  buildLastSessionSummary,
  pickLastTreatment,
  pickPreClientWatchPlanSource,
  type ClinicalSummaryBlock,
  type LastSessionSummary,
} from "@/lib/sessions/clinical-summary";
import {
  AreaSummaries,
  FromLastVisitForToday,
  hasFromLastVisitContent,
} from "@/components/last-session-summary";
import { TreatmentIntelligenceCard } from "@/components/treatment-intelligence-card";
import { LastVisitCard } from "@/components/last-visit-card";
import { BeforeTodayCard } from "@/components/before-today-card";
import { buildBeforeToday } from "@/lib/sessions/before-today";
import { getImportedTreatmentMemoriesForClient } from "@/lib/imported-treatment-memory";
import { attachStructuredAreas } from "@/lib/supabase/queries";

// PR #259: display cap for imported treatment memory in Before Today — show
// the latest few so the briefing stays scannable; "Showing the latest N of M"
// surfaces when more exist. The helper still returns an honest totalFound.
const BEFORE_TODAY_IMPORTED_CAP = 5;
import {
  buildTreatmentIntelligence,
  type IntelligenceBlockInput,
} from "@/lib/sessions/treatment-intelligence";
import {
  getAppointmentsForClientProfile,
  getClientById,
  getCurrentPractitionerWithStudio,
  sessionPerformerName,
} from "@/lib/supabase/queries";
import { ClientAppointmentTimeline } from "@/components/client-appointment-timeline";
import { FITZPATRICK_TYPES } from "@/lib/constants";
import { SessionTimeline } from "@/components/session-timeline";
import {
  ElectrolysisEntryRow,
  LaserEntryRow,
} from "@/components/entry-row";
import { AddPricingForm } from "@/components/add-pricing-form";
import { ClientPinnedNotesCard } from "@/components/client-pinned-notes-card";
// ClientTagsCard import removed: Tags is hidden from the main profile
// per pilot feedback (Chloe prefers Pinned notes as the practitioner
// memory surface). Tag data and tag actions remain in the codebase
// for possible re-surfacing in an admin/advanced area later.
import { TreatmentPlansCard } from "@/components/treatment-plans-card";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { getActiveServices } from "@/lib/booking/queries";
import { todayInTz } from "@/lib/booking/tz";
import {
  getLatestIntakeForClient,
  getLatestSubmittedOrReviewedIntakeForClient,
  INTAKE_LINK_TTL_DAYS,
} from "@/lib/intake/queries";
import { computeFitzpatrickEstimate } from "@/lib/intake/fitzpatrick";
import { IntakeResendCard } from "./intake/IntakeResendCard";
import { PortalAccessCard } from "./PortalAccessCard";
import {
  getPortalAccessSummary,
  getRecentPortalAccessEvents,
} from "@/lib/portal/queries";
import { computePortalPendingTasks } from "@/lib/portal/pending-tasks";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import { computeIntakeLinkStatus } from "@/lib/intake/link-status";
// getClientTags import removed: tags no longer render on the main
// profile (see ClientTagsCard note above). Server actions for tags
// are unchanged and the data is preserved.
import { getPinnedNotesForClient } from "@/lib/client-pinned-notes/queries";
import { getTreatmentPlansForClient } from "@/lib/treatment-plans/queries";
import { getPortalMessagesForPractitionerView } from "@/lib/portal-messages/queries";
import { getPortalMessageRepliesForPractitionerView } from "@/lib/portal-messages/replies-queries";
import { PortalMessagesCard } from "@/components/portal-messages-card";
import {
  getConsentTemplatesForStudio,
  getLatestSignaturesForPractitionerView,
} from "@/lib/consent/queries";
import { ConsentSignaturesCard } from "@/components/consent-signatures-card";
import { getActiveCardForStudioClient } from "@/lib/payment-methods/queries";
import { PaymentMethodCard } from "@/components/payment-method-card";
import {
  archivePortalMessageAction,
  createPortalMessageAction,
  markPortalReplySeenAction,
} from "./portal-messages-actions";
import {
  getTotalTreatmentTime,
  getTreatmentTimeByArea,
  getTreatmentGoal,
} from "@/lib/treatment-time/queries";
import { TreatmentTimeCard } from "@/components/treatment-time-card";
import { upsertTreatmentGoalAction } from "./treatment-time-actions";
import { ProfileTabBar } from "@/components/profile-tab-bar";
import { isProfileTab, type ProfileTab } from "@/components/profile-tab";
import { sanitizeAppointmentReturnTo } from "@/lib/nav/appointment-return";
import { BookAppointment } from "./BookAppointment";
import {
  addClientPricingAction,
  deleteClientPricingAction,
} from "./actions";
// addClientTagAction / removeClientTagAction are still exported by
// actions.ts; not imported here because Tags no longer renders on
// the main profile. Keep them available for the future admin/tags
// surface.
import {
  addClientPinnedNoteAction,
  editClientPinnedNoteAction,
  removeClientPinnedNoteAction,
} from "./pinned-notes-actions";
import {
  closeTreatmentPlanAction,
  createTreatmentPlanAction,
  createTreatmentPlanStageAction,
  deleteTreatmentPlanStageAction,
  updateTreatmentPlanNotesAction,
  updateTreatmentPlanStageAction,
} from "./treatment-plans-actions";
import { updateClientPersonalNotesAction } from "./personal-notes-actions";
import { getClientPersonalNotes } from "@/lib/clients/personal-notes-queries";
import { ClientPersonalNotesEditor } from "@/components/client-personal-notes-editor";
import {
  addClinicalNoteAction,
  reviseClinicalNoteAction,
} from "./clinical-notes-actions";
import { buildClinicalNoteSections } from "@/lib/clinical-notes/section-data";
import { getClinicalNotesSummary } from "@/lib/clinical-notes/queries";
import { ClinicalNotesSection } from "@/components/clinical-notes-section";
import { ClinicalNotesSummary } from "@/components/clinical-notes-summary";
import { ClientBirthdayCard } from "@/components/client-birthday-card";

// Parse the studio-local "YYYY-MM-DD" returned by todayInTz() into
// month/day numbers for the Birthday card's "today" / "this month"
// callouts.
function parseStudioToday(yyyymmdd: string): { month: number; day: number } {
  const parts = yyyymmdd.split("-");
  return {
    month: parseInt(parts[1] ?? "0", 10),
    day: parseInt(parts[2] ?? "0", 10),
  };
}

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fitzpatrickLabel(value: number | null): string {
  if (value == null) return "Not set";
  const match = FITZPATRICK_TYPES.find((f) => f.value === value);
  return match ? match.label : String(value);
}

function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  return `tel:${digits}`;
}

export default async function ClientCheatSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; create_plan?: string; returnTo?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const activeTab: ProfileTab = isProfileTab(sp.tab) ? sp.tab : "overview";
  // Deep-link from an appointment: open the EXISTING treatment-plan create form.
  // Only honoured on the treatment tab; it just opens the form (no auto-create).
  const autoOpenCreatePlan = sp.create_plan === "1" && activeTab === "treatment";
  // Validated internal "/calendar/<uuid>" back target, or null. Never external.
  const planReturnTo = sanitizeAppointmentReturnTo(sp.returnTo);

  const { studio, practitioner } = await getCurrentPractitionerWithStudio();
  const data = await getClientById(studio.id, id);

  if (!data) {
    notFound();
  }

  const { client, pricing, sessions, practitioners } = data;
  // PR Willow launch fixes: surface past appointments that the
  // practitioner has not charted yet under the Sessions tab. The
  // helper filters out appointments that already have a session
  // within +/-2h (heuristic dedup; sessions do not carry an
  // appointment_id today). Capped at 50 rows. Display-only; no
  // appointment status mutation.
  // PR #157. Replaces the prior `getPastConfirmedAppointmentsForClient`
  // call with the appointment timeline read that powers the new
  // <ClientAppointmentTimeline> on the Sessions tab. The new helper
  // returns the full appointment history (confirmed + completed +
  // cancelled + no_show) joined with the linked session via the
  // PR #156 appointment_id FK, and the component groups it into
  // Upcoming / Needs charting / Charted / Cancelled / No-show
  // sections. The legacy +/- 2 hour dedup helper remains in
  // lib/supabase/queries.ts as a reusable utility but is no longer
  // wired here; the explicit FK on the new read does the dedup
  // directly.
  const appointmentTimeline = await getAppointmentsForClientProfile(
    studio.id,
    client.id,
  );
  const services = await getActiveServices(studio.id);
  const today = todayInTz(studio.timezone);
  const intake = await getLatestIntakeForClient(studio.id, client.id);
  // Portal access: the studio-branded login URL (no token) + read-only access
  // hints (last link sent / last sign-in) from existing tables.
  const portalAccess = await getPortalAccessSummary(studio.id, client.id);
  const portalLoginUrl = studio.slug
    ? `${getRequiredAppOrigin()}/portal/login?studio=${encodeURIComponent(studio.slug)}`
    : `${getRequiredAppOrigin()}/portal/login`;
  // Self-reported Fitzpatrick on the profile is derived from the
  // latest submitted/reviewed intake only. A newer in_progress
  // reissue (no answers yet) intentionally does NOT clear the prior
  // estimate; we keep showing the most recent submitted reading.
  // Practitioner-confirmed Fitzpatrick lives in client.fitzpatrick_type
  // and is the canonical clinical value; it is never overwritten by
  // this derived display.
  const submittedIntake = await getLatestSubmittedOrReviewedIntakeForClient(
    studio.id,
    client.id,
  );
  const selfReportedFitzpatrick = submittedIntake
    ? computeFitzpatrickEstimate(
        (submittedIntake.responses ?? {}) as Record<string, unknown>,
      )
    : null;
  // tags read removed: Tags no longer renders on the main profile.
  const pinnedNotes = await getPinnedNotesForClient(studio.id, client.id);
  const treatmentPlans = await getTreatmentPlansForClient(studio.id, client.id);
  const [
    treatmentTotals,
    treatmentByArea,
    treatmentGoal,
    personalNotes,
    portalMessages,
    portalMessageReplies,
    consentTemplatesAll,
    consentLatestSignatures,
    activeCard,
    importedMemory,
  ] = await Promise.all([
    getTotalTreatmentTime(studio.id, client.id),
    getTreatmentTimeByArea(studio.id, client.id),
    getTreatmentGoal(studio.id, client.id),
    // Phase: personal notes (migration 0035). Returns null when the
    // client has no row yet; the editor's defaultValues stay empty.
    getClientPersonalNotes(studio.id, client.id),
    // Migration 0053: secure portal messages for this client.
    // Practitioner-side view includes notification + reviewed
    // state. Empty array when the client has none.
    getPortalMessagesForPractitionerView(studio.id, client.id),
    // PR #129 (migration 0054): client replies to the messages
    // above. Same studio+client scope; render inline under each
    // parent message. Empty array when the client has not replied.
    getPortalMessageRepliesForPractitionerView(studio.id, client.id),
    // PR #134 (migration 0057): consent / e-sign foundation.
    // Active templates (per-studio) + latest signature per template
    // (per-client). Same studio scope; rendered as a read-only
    // status card on the profile.
    getConsentTemplatesForStudio(studio.id),
    getLatestSignaturesForPractitionerView(studio.id, client.id),
    // PR #135 (migration 0058): card-on-file Phase 1. Active card
    // metadata only; Stripe identifiers stay off the wire. Rendered
    // by the new PaymentMethodCard below ConsentSignaturesCard.
    getActiveCardForStudioClient(studio.id, client.id),
    // PR #259: read-only imported treatment memory (paper/Jane/spreadsheet
    // history from Quick Import) for the Before Today briefing. RLS-backed,
    // studio+client-scoped, voided rows excluded, newest-first, capped for
    // display. Surfaced as a labelled "Imported treatment memory" section in
    // BeforeTodayCard — never mixed with live charted history.
    getImportedTreatmentMemoriesForClient(studio.id, client.id, {
      limit: BEFORE_TODAY_IMPORTED_CAP,
    }),
  ]);
  const practitionerNames: Record<string, string> = Object.fromEntries(
    practitioners.map((p) => [p.id, p.display_name?.trim() || p.email]),
  );

  // Portal Access PR 3: outstanding portal tasks (from already-loaded data, no
  // new queries) + recent portal access events (fail-soft: [] pre-migration).
  const portalPendingTasks = computePortalPendingTasks({
    intakeStatus: intake?.status ?? null,
    activeConsentTemplates: consentTemplatesAll,
    latestSignatures: consentLatestSignatures,
    portalMessages,
  });
  const portalAccessEvents = await getRecentPortalAccessEvents(
    studio.id,
    client.id,
    5,
  );

  // Migration 0126: dated consultation + skin/hair analysis clinical notes.
  // Loaded only when the Consultation tab is active so other tabs pay no cost.
  const clinicalNoteSections =
    activeTab === "consultation"
      ? await buildClinicalNoteSections(client.id, { historyLimit: 25 })
      : null;
  // Read-only latest-of-each-kind summary for the overview appointment-prep
  // briefing. Two light reads; only on the default overview tab.
  const clinicalNotesSummary =
    activeTab === "overview"
      ? await getClinicalNotesSummary(client.id)
      : null;

  const lifetimeCents = sessions.reduce(
    (sum, s) => sum + (s.price_paid_cents ?? 0),
    0,
  );
  const sessionsWithPrice = sessions.filter(
    (s) => s.price_paid_cents != null,
  ).length;

  // PR #199 (Chloe iPad retest): "Last session" used to be sessions[0]
  // even when that session had no treatment details, so the card Chloe
  // checks before starting a client could read as empty
  // while a useful charted treatment sat one row below. The card is now
  // "Last treatment": one narrow blocks read across the recent
  // sessions, and the newest session that actually has treatment areas
  // (or, for laser/legacy sessions, raw entries) wins. An uncharted
  // newer session still appears under Needs charting; it just can't
  // blank out the summary.
  const recentSessions = sessions.slice(0, 25);
  let lastTreatment: (typeof sessions)[number] | null = null;
  let lastTreatmentSummary: LastSessionSummary | null = null;
  let lastTreatmentBlocks: ClinicalSummaryBlock[] = [];
  // PR #203: pre-client Watch/Plan context for the card's footer band
  // (may come from a different session than lastTreatment).
  let preClientWatchPlan: LastSessionSummary | null = null;
  if (recentSessions.length > 0) {
    const supabaseForSummary = await createClient();
    const { data: recentBlocks } = await supabaseForSummary
      .from("session_blocks")
      .select(
        "id, session_id, sort_order, block_name, primary_area, side, custom_area_detail, mode, apilus_modality, energy_level, minutes_performed, probe_label, probe_lot_number, tolerance_rating, reaction_type, reaction_notes, caution_for_next_session, caution_note, electrolysis_entries(observation_chips, deleted_at)",
      )
      .eq("studio_id", studio.id)
      .in(
        "session_id",
        recentSessions.map((s) => s.id),
      )
      .is("deleted_at", null)
      .order("sort_order", { ascending: true });
    // Migration 0128: attach structured areas so the Last treatment / Watch-plan
    // summaries render EVERY treated area + laterality, not just primary_area.
    const summaryBlockRows = (recentBlocks ?? []) as Array<
      ClinicalSummaryBlock & {
        id: string;
        session_id: string;
        electrolysis_entries?:
          | Array<{ observation_chips: unknown; deleted_at: string | null }>
          | null;
      }
    >;
    await attachStructuredAreas(summaryBlockRows, studio.id);
    const blocksBySession = new Map<string, ClinicalSummaryBlock[]>();
    for (const block of summaryBlockRows) {
      const sessionId = block.session_id;
      const list = blocksBySession.get(sessionId) ?? [];
      // Charting unification: carry live entries' observation_chips so the
      // reaction line reads the unified representation.
      list.push({
        ...block,
        observation_chips_list: (block.electrolysis_entries ?? [])
          .filter((e) => e.deleted_at == null)
          .map((e) => e.observation_chips),
      });
      blocksBySession.set(sessionId, list);
    }
    lastTreatment = pickLastTreatment(recentSessions, blocksBySession);
    if (lastTreatment) {
      lastTreatmentBlocks = blocksBySession.get(lastTreatment.id) ?? [];
      lastTreatmentSummary = buildLastSessionSummary({
        blocks: lastTreatmentBlocks,
        nextSessionNote:
          (lastTreatment as { next_session_note?: string | null })
            .next_session_note ?? null,
      });
    }
    // PR #203: the Watch/Plan band uses the same pre-client context
    // the charting page shows; the newest session carrying any
    // watch/plan content, even if a newer charted session has none of
    // its own. Same blocks read; no extra query.
    const watchPlanSource = pickPreClientWatchPlanSource(
      recentSessions as Array<
        (typeof sessions)[number] & { next_session_note?: string | null }
      >,
      blocksBySession,
    );
    if (watchPlanSource) {
      preClientWatchPlan = buildLastSessionSummary({
        blocks: blocksBySession.get(watchPlanSource.id) ?? [],
        nextSessionNote: watchPlanSource.next_session_note ?? null,
      });
    }
  }

  const lastTreatmentPerformer = lastTreatment
    ? sessionPerformerName(lastTreatment, practitioners)
    : null;

  // Overview "Last visit" card — derived from the SINGLE last session
  // that is already loaded above (no new query, no new summary). Total
  // minutes sums the last session's own blocks; the aftercare stamp
  // (0085) and "is this the very latest session" flag are read from the
  // same last-treatment row.
  const lastTreatmentTotalMinutes = lastTreatmentBlocks.reduce(
    (sum, b) => sum + (b.minutes_performed ?? 0),
    0,
  );
  const lastTreatmentAftercareAt = lastTreatment
    ? ((lastTreatment as { aftercare_and_risks_explained_at?: string | null })
        .aftercare_and_risks_explained_at ?? null)
    : null;

  // PR #210: Treatment Intelligence. One read across ALL the client's
  // sessions (cap 200) with per-entry hairs; the pure builder turns
  // recorded history into the Overview summary. Read-only; recorded-
  // history language only; "Not recorded" for gaps.
  let treatmentIntelligence = buildTreatmentIntelligence({
    sessionsNewestFirst: sessions,
    blocks: [],
  });
  if (sessions.length > 0) {
    const supabaseForIntel = await createClient();
    const { data: intelBlocks } = await supabaseForIntel
      .from("session_blocks")
      .select(
        "id, session_id, primary_area, side, block_name, mode, apilus_modality, energy_level, machine_frequency, probe_label, minutes_performed, tolerance_rating, reaction_type, caution_for_next_session, caution_note, electrolysis_entries(hairs_treated, observation_chips, deleted_at)",
      )
      .eq("studio_id", studio.id)
      .in(
        "session_id",
        sessions.slice(0, 200).map((sess) => sess.id),
      )
      .is("deleted_at", null);
    // Migration 0128: attach structured areas so the Treatment intelligence card
    // credits EVERY treated area (a Cheeks + Sideburns block appears under both),
    // not only the legacy primary_area.
    const intelBlockRows = (intelBlocks ?? []) as Array<
      Omit<IntelligenceBlockInput, "entry_hairs" | "observation_chips_list"> & {
        id: string;
        electrolysis_entries:
          | Array<{
              hairs_treated: number | null;
              observation_chips: unknown;
              deleted_at: string | null;
            }>
          | null;
      }
    >;
    await attachStructuredAreas(intelBlockRows, studio.id);
    treatmentIntelligence = buildTreatmentIntelligence({
      sessionsNewestFirst: sessions,
      blocks: intelBlockRows.map((b) => ({
        ...b,
        // Migration 0114: voided passes don't contribute hairs to intelligence.
        entry_hairs: (b.electrolysis_entries ?? [])
          .filter((e) => !e.deleted_at)
          .map((e) => e.hairs_treated),
        // Charting unification: the block's live entries' observation_chips feed
        // the unified reaction summaries.
        observation_chips_list: (b.electrolysis_entries ?? [])
          .filter((e) => !e.deleted_at)
          .map((e) => e.observation_chips),
      })),
    });
  }

  // PR #211: "Before today" pre-treatment briefing, assembled from
  // data this page already loads (last charted treatment, pre-client
  // watch/plan, treatment intelligence, client record fields).
  // Read-only; recorded-history wording only.
  const beforeToday = buildBeforeToday({
    lastTreatment: lastTreatment
      ? {
          startedAt: lastTreatment.started_at,
          modality: lastTreatment.modality,
          areaNames: lastTreatmentSummary?.areas.map((a) => a.name) ?? [],
          aftercareExplainedAt:
            (lastTreatment as { aftercare_and_risks_explained_at?: string | null })
              .aftercare_and_risks_explained_at ?? null,
          blockLots: lastTreatmentBlocks.map(
            (b) =>
              (b as { probe_lot_number?: string | null }).probe_lot_number ??
              null,
          ),
          blockMinutes: lastTreatmentBlocks.map(
            (b) => b.minutes_performed ?? null,
          ),
          blockReactionNotes: lastTreatmentBlocks.map(
            (b) => b.reaction_notes ?? null,
          ),
        }
      : null,
    watchPlan: preClientWatchPlan,
    intelligence: treatmentIntelligence,
    client: {
      dateOfBirth: client.date_of_birth,
      phone: client.phone,
      address: client.address,
    },
  });

  const hasEmergencyContact =
    !!client.emergency_contact_name || !!client.emergency_contact_phone;

  return (
    <div className="flex flex-col gap-10">
      <section>
        <Link
          href="/clients"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Clients
        </Link>
        {/* PR #233: compact mobile-first header. The name no longer
            shares a baseline row with Edit (it crowded and wrapped at
            phone widths); contacts stack on phones; the action row
            puts Log session and Book appointment side by side with a
            single short helper line instead of a floating oversized
            button plus a detached booking block. Identical actions,
            identical business logic. */}
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="break-words text-2xl font-semibold tracking-tight md:text-3xl">
                {client.name}
              </h1>
              {/* PR Willow launch fixes: when the client is archived
                  (migration 0050), show a calm badge so a practitioner
                  who navigated here from a deep link or a historical
                  appointment knows the row is hidden from active lists
                  and can unarchive from the Edit page. */}
              {client.archived_at && (
                <span className="rounded-full bg-neutral-200 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                  Archived
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-col gap-y-0.5 text-sm text-neutral-500 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
              {client.pronouns && <span>{client.pronouns}</span>}
              {client.phone && <span>{client.phone}</span>}
              {client.email && <span className="break-all">{client.email}</span>}
            </div>
            {sessionsWithPrice > 0 && (
              <p className="mt-1.5 text-xs text-neutral-500 sm:text-sm">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">
                  {formatPrice(lifetimeCents)}
                </span>{" "}
                over {sessionsWithPrice}{" "}
                {sessionsWithPrice === 1 ? "session" : "sessions"}
              </p>
            )}
          </div>
          <Link
            href={`/clients/${client.id}/edit`}
            className="shrink-0 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Edit
          </Link>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Link
            href={`/clients/${client.id}/sessions/new`}
            className="rounded-md bg-neutral-900 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            + Log session
          </Link>
          {/* Collapsed: a compact "+ Book appointment" button paired
              with Log session. Expanded: the booking card grows into
              the remaining row width (full-width on phones). */}
          <div className="min-w-0 flex-1">
            <BookAppointment
              clientId={client.id}
              services={services}
              defaultDate={today}
              timezone={studio.timezone}
              isOwner={practitioner.role === "owner"}
              practitionerCapacityEnabled={studio.practitioner_capacity_enabled === true}
              currentPractitionerId={practitioner.id}
              currentPractitionerName={practitioner.display_name}
            />
          </div>
        </div>
        {/* PR #157 helper, shortened for phones: the per-row "Chart
            session" affordance on the Sessions tab remains the booked-
            appointment path; this button is for walk-ins. */}
        <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
          Log session is for walk-ins without a booked appointment; otherwise
          chart from the appointment row in Sessions.
        </p>
      </section>

      <ProfileTabBar active={activeTab} />

      {activeTab === "overview" && (
        <>
          {/* Every-visit priorities: pinned notes first, then anything
              that could change how today's treatment is delivered. */}
          <ClientPinnedNotesCard
            clientId={client.id}
            notes={pinnedNotes}
            addAction={addClientPinnedNoteAction}
            editAction={editClientPinnedNoteAction}
            removeAction={removeClientPinnedNoteAction}
          />

          {/* PR #194 (Chloe retest): allergies live at the TOP of
              Overview, directly under pinned notes. Messages and
              billing kept pushing this down; clinical safety wins
              the first scan. RED per the color convention. */}
          {client.allergies && (
            <section className="rounded-lg border border-rose-300 bg-rose-50 p-5 dark:border-rose-700 dark:bg-rose-950/30">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-300">
                Allergies
              </h2>
              <p className="mt-2 whitespace-pre-wrap text-sm text-rose-900 dark:text-rose-100">
                {client.allergies}
              </p>
            </section>
          )}

          {/* Skin is its own card now (was previously grid-paired with
              Pricing). Skin context + Fitzpatrick belong with clinical
              caution; billing rates belong in their own footer card.
              Fitzpatrick is intentionally rendered as two separate
              rows so the practitioner-confirmed clinical value
              (client.fitzpatrick_type) is never visually conflated
              with the client's self-reported intake estimate. */}
          <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
            <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
              Skin
            </h2>
            <dl className="mt-3 flex flex-col gap-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-neutral-500">
                  Fitzpatrick · practitioner confirmed
                </dt>
                <dd className="font-medium">
                  {fitzpatrickLabel(client.fitzpatrick_type)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-neutral-500">
                  Fitzpatrick · self-reported intake
                </dt>
                <dd className="font-medium text-neutral-700 dark:text-neutral-300">
                  {selfReportedFitzpatrick
                    ? `Type ${selfReportedFitzpatrick.type}, score ${selfReportedFitzpatrick.score}/40`
                    : "Not completed"}
                </dd>
              </div>
            </dl>
            {selfReportedFitzpatrick && (
              <p className="mt-2 text-xs text-neutral-500">
                Self-reported intake estimate. Not a clinical
                assessment; the practitioner-confirmed value above is
                the canonical record.
              </p>
            )}
            {client.skin_notes && (
              <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">
                {client.skin_notes}
              </p>
            )}
          </section>

          {/* Chloe: "on the client overview I want to clearly see what
              we did last time." A scannable, RETROSPECTIVE recap of the
              single last completed session, high on Overview (after the
              safety-first pinned notes / allergies / skin). Pure reuse
              of the already-loaded last-treatment data + the shared
              buildLastSessionSummary render helpers — no new query, no
              new clinical model, no AI, clinical-first (no price). The
              forward-looking BeforeToday prep card is separate and
              unchanged; the Sessions-tab "Last treatment" card (fuller,
              with price) also stays. */}
          <LastVisitCard
            clientId={client.id}
            sessionId={lastTreatment?.id ?? null}
            startedAt={lastTreatment?.started_at ?? null}
            modality={lastTreatment?.modality ?? null}
            performerName={lastTreatmentPerformer}
            aftercareExplainedAt={lastTreatmentAftercareAt}
            totalMinutes={lastTreatmentTotalMinutes}
            isLatestSession={lastTreatment?.id === sessions[0]?.id}
            summary={lastTreatmentSummary}
          />

          {/* PR #197 (Chloe round 3): portal messages moved to the
              dedicated Messages tab; Overview stays clinical-first. */}

          {/* Client portal access (Send/Copy portal link). Reuses the existing
              secure magic-link issuance; studio-scoped + rate-limited. */}
          <PortalAccessCard
            clientId={client.id}
            portalLoginUrl={portalLoginUrl}
            clientHasEmail={!!client.email && client.email.length > 0}
            lastLinkSentAt={portalAccess.lastLinkSentAt}
            lastSeenAt={portalAccess.lastSeenAt}
            pendingTasks={portalPendingTasks}
            recentEvents={portalAccessEvents}
          />

          {/* PR #134. Consent / e-sign per-template signed status for
              this client. Renders active templates only; archived
              and draft templates do not appear here. View-only in
              v1; the practitioner authoring surface lives in
              Settings &rarr; Consent forms. */}
          <ConsentSignaturesCard
            clientName={client.name}
            activeTemplates={consentTemplatesAll
              .filter((t) => t.status === "active")
              .map((t) => ({
                id: t.id,
                title: t.title,
                form_type: t.form_type,
                version: t.version,
              }))}
            latestSignatures={consentLatestSignatures}
          />

          {/* PR #135. Card-on-file Phase 1 read-only status card.
              Practitioner sees brand / last4 / exp + the
              authorization signed-at timestamp when available.
              v1 has no Charge / Replace / Remove affordances; card
              management lives in the portal. */}
          {/* PR #158. Resolve card-authorization state from data the
              page has already loaded (consentTemplatesAll +
              consentLatestSignatures) so the practitioner card can
              render one of four explanatory branches without a new
              query: active card, no template configured, template
              exists but unsigned, or signed but no card yet. The IIFE
              keeps the derivation co-located with the prop site so a
              future refactor moving this block does not split the
              two halves of the same decision. */}
          {(() => {
            // PR #170. Practitioner-side card_authorization state must
            // match what the portal sees: the LIVE template
            // (is_live=true AND status='active') and its current
            // version. Before PR #170 this find used only
            // status='active', which after PR #167 became inconsistent
            // with the portal query that also requires is_live=true.
            // The fix is small: add the is_live filter so a draft /
            // not-live card_authorization template never surfaces here
            // as "ready," and compare the matching signature's
            // template_version to the live template's current version
            // so an out-of-date signature flips the new prop.
            const cardAuthTemplate = consentTemplatesAll.find(
              (t) =>
                t.is_live === true &&
                t.status === "active" &&
                t.form_type === "card_authorization",
            );
            const cardAuthorizationTemplateExists = cardAuthTemplate != null;
            const matchingSignature = cardAuthTemplate
              ? consentLatestSignatures.find(
                  (s) => s.template_id === cardAuthTemplate.id,
                )
              : null;
            const cardAuthorizationSigned = matchingSignature != null;
            const cardAuthorizationOutOfDate =
              cardAuthTemplate != null &&
              matchingSignature != null &&
              matchingSignature.template_version !== cardAuthTemplate.version;
            const authorizationSignedAt = matchingSignature
              ? matchingSignature.signed_at
              : null;
            return (
              <PaymentMethodCard
                clientName={client.name}
                activeCard={activeCard}
                authorizationSignedAt={authorizationSignedAt}
                cardAuthorizationTemplateExists={
                  cardAuthorizationTemplateExists
                }
                cardAuthorizationSigned={cardAuthorizationSigned}
                cardAuthorizationOutOfDate={cardAuthorizationOutOfDate}
                cardSetupBlockedByEnvironment={!publishableKeyOk()}
              />
            );
          })()}

          {/* PR #194: allergies moved to the top of Overview (under
              pinned notes); see the block above the Messages
              collapsible. */}

          {/* PR #198 (Chloe iPad retest): one "Client info" card holding
              birthday, emergency contact, and address, with an Edit
              link to the existing edit page. */}
          <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
                Client info
              </h2>
              <Link
                href={`/clients/${client.id}/edit`}
                className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
              >
                Edit
              </Link>
            </div>
          {/* Birthday row (PR #199: plain row, no nested box, no
              helper text; edited via the card's single Edit link).
              Renders an explicit "Birthday today" or "Birthday month"
              callout when relevant. Practitioner-only; never exposed
              to client/public surfaces. */}
          <ClientBirthdayCard
            dateOfBirth={client.date_of_birth}
            studioToday={parseStudioToday(today)}
            accentColor={studio.birthday_reminder_color}
          />

          {/* Tags removed from the main profile per pilot feedback.
              Chloe asked repeatedly for pinned notes over tags as the
              practitioner-memory surface, so ClientTagsCard is no
              longer rendered in Overview. The underlying tag data
              and the addClientTagAction / removeClientTagAction
              server actions are intentionally preserved (no
              migration, no destructive change); they can be
              re-surfaced behind an admin/advanced area later if
              anyone asks. */}

          {/* "Details" section removed. Its only field was the raw
              Date of birth row, which is already covered by the
              ClientBirthdayCard above (it shows the date and renders
              an explicit "Birthday today / this month" callout when
              relevant). Removing the second surface keeps the
              pre-appointment scan focused. The raw date_of_birth is
              also available on the Edit client page if a practitioner
              ever needs to change it. */}

          {hasEmergencyContact && (
            <section>
              <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
                Emergency contact
              </h2>
              <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                {client.emergency_contact_name && (
                  <span className="font-medium">
                    {client.emergency_contact_name}
                  </span>
                )}
                {client.emergency_contact_name &&
                  client.emergency_contact_phone && (
                    <span className="text-neutral-400">·</span>
                  )}
                {client.emergency_contact_phone && (
                  <a
                    href={telHref(client.emergency_contact_phone)}
                    className="text-neutral-700 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-700 dark:text-neutral-300 dark:decoration-neutral-700"
                  >
                    {client.emergency_contact_phone}
                  </a>
                )}
              </p>
            </section>
          )}

          {/* PR #197: Skin moved up under Allergies (rendered above). */}

          {client.address && (
            <section>
              <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
                Address
              </h2>
              <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-200">
                {client.address}
              </p>
            </section>
          )}
          </section>

          {/* PR #211: "Before today" pre-treatment briefing; below
              Client info, above Treatment Intelligence. */}
          <BeforeTodayCard
            briefing={beforeToday}
            importedMemory={importedMemory}
          />

          {/* Migration 0126: at-a-glance latest consultation + skin/hair
              analysis for appointment prep. Read-only; links to the
              Consultation tab for full dated history + add/revise. */}
          {clinicalNotesSummary && (
            <ClinicalNotesSummary
              clientId={client.id}
              consultation={clinicalNotesSummary.consultation}
              skinHair={clinicalNotesSummary.skin_hair_analysis}
            />
          )}

          {/* PR #210: Treatment Intelligence; recorded-history summary
              (areas, minutes, hairs, latest setup, reactions, watch/
              plan). Below Client info, above Pricing. */}
          <TreatmentIntelligenceCard intelligence={treatmentIntelligence} />

          {/* Pricing moved to the end of Overview — it's billing, not
              clinical caution. Same fields, same actions (unchanged),
              same delete button; only the surrounding section markup
              changed. */}
          <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
            <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
              Pricing
            </h2>
            {pricing.length === 0 ? (
              <p className="text-sm text-neutral-500">
                No custom pricing. Studio defaults apply.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
                {pricing.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-start justify-between gap-3 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{p.service_name}</span>
                        <span className="tabular-nums">
                          {formatPrice(p.price_cents)}
                        </span>
                      </div>
                      {p.notes && (
                        <div className="text-xs text-neutral-500">{p.notes}</div>
                      )}
                    </div>
                    <form action={deleteClientPricingAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="client_id" value={client.id} />
                      <button
                        type="submit"
                        aria-label={`Delete ${p.service_name} pricing`}
                        className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
                      >
                        ✕
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
              <AddPricingForm
                clientId={client.id}
                action={addClientPricingAction}
              />
            </div>
          </section>
        </>
      )}

      {activeTab === "consultation" && clinicalNoteSections && (
        <ClinicalNotesSection
          clientId={client.id}
          variant="full"
          sections={clinicalNoteSections}
          addAction={addClinicalNoteAction}
          reviseAction={reviseClinicalNoteAction}
          printHref={`/clients/${client.id}/clinical-notes/print`}
        />
      )}

      {activeTab === "personal" && (
        <ClientPersonalNotesEditor
          clientId={client.id}
          initial={{
            personal_notes: personalNotes?.personal_notes ?? "",
            private_warnings: personalNotes?.private_warnings ?? "",
          }}
          action={updateClientPersonalNotesAction}
        />
      )}

      {activeTab === "messages" && (
        <>
          {/* PR #197: dedicated Messages tab (moved off Overview at
              Chloe's request). Same card, same actions. */}
          <PortalMessagesCard
            clientId={client.id}
            clientName={client.name}
            clientHasEmail={!!client.email && client.email.length > 0}
            clientIsArchived={client.archived_at != null}
            messages={portalMessages}
            replies={portalMessageReplies}
            createAction={createPortalMessageAction}
            archiveAction={archivePortalMessageAction}
            markReplySeenAction={markPortalReplySeenAction}
            practitionerNames={practitionerNames}
          />
        </>
      )}

      {activeTab === "health" && (
        <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
              Health intake
            </h2>
            {intake?.status === "reviewed" && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                Reviewed
              </span>
            )}
            {intake?.status === "submitted" && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                Awaiting review
              </span>
            )}
          </div>
          {!intake && (
            <p className="mt-2 text-sm text-neutral-500">
              No intake on file. A link is sent automatically with each booking
              confirmation.
            </p>
          )}
          {intake?.status === "in_progress" && (
            <div className="mt-2 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-neutral-600">
                  Intake started <FormattedDateTime iso={intake.started_at} />,
                  not yet submitted.
                </p>
                <Link
                  href={`/clients/${client.id}/intake`}
                  className="text-sm font-medium text-neutral-700 hover:underline dark:text-neutral-300"
                >
                  View intake →
                </Link>
              </div>
              {/* PR #293 follow-up: surface the Resend intake link CTA on the
                  Health & Forms tab practitioners actually use (this overview
                  card), not only the dedicated /intake page. Reuses the
                  existing IntakeResendCard + its existing backend actions. */}
              <IntakeResendCard
                clientId={client.id}
                intakeId={intake.id}
                clientHasEmail={!!client.email}
                linkMaybeExpired={
                  Date.now() - new Date(intake.started_at).getTime() >
                  INTAKE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000
                }
                status={computeIntakeLinkStatus(intake, Date.now())}
              />
            </div>
          )}
          {intake?.status === "submitted" && intake.submitted_at && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-neutral-600">
                Submitted <FormattedDateTime iso={intake.submitted_at} />
              </p>
              <Link
                href={`/clients/${client.id}/intake`}
                className="text-sm font-medium text-neutral-700 hover:underline dark:text-neutral-300"
              >
                View intake →
              </Link>
            </div>
          )}
          {intake?.status === "reviewed" && intake.reviewed_at && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-neutral-600">
                Reviewed <FormattedDateTime iso={intake.reviewed_at} />
              </p>
              <Link
                href={`/clients/${client.id}/intake`}
                className="text-sm font-medium text-neutral-700 hover:underline dark:text-neutral-300"
              >
                View intake →
              </Link>
            </div>
          )}
        </section>
      )}

      {activeTab === "sessions" && (
        <>
          {/* PR #191 (Chloe smoke feedback): the Sessions tab order is
                hers, verbatim:
                  1. Total electrolysis treatment time
                  2. Last session memory
                  3. Appointments (Needs charting first, then Upcoming;
                     order set inside ClientAppointmentTimeline)
                  4. Session history
                Treatment time moved above appointments at her request. */}
          <TreatmentTimeCard
            clientId={client.id}
            totals={treatmentTotals}
            breakdown={treatmentByArea}
            goal={treatmentGoal}
            upsertGoalAction={upsertTreatmentGoalAction}
          />

          {/* 2. Last treatment; what the practitioner reaches for
                between visits. PR #199: the most recent CHARTED
                treatment, never an empty newer session. */}
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">Last treatment</h2>
            {lastTreatment ? (
              <div className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">
                      <FormattedDateTime iso={lastTreatment.started_at} />
                    </div>
                    <div className="text-xs text-neutral-500">
                      {lastTreatment.modality}
                      {lastTreatmentPerformer && ` · ${lastTreatmentPerformer}`}
                      {lastTreatment.price_paid_cents != null &&
                        ` · Session price ${formatPrice(lastTreatment.price_paid_cents)}`}
                    </div>
                    {/* A newer uncharted session exists; say so quietly
                        instead of letting it blank out this card. It
                        still shows under Needs charting below. */}
                    {lastTreatment.id !== sessions[0]?.id && (
                      <p className="mt-1 text-xs text-neutral-500">
                        Most recent charted treatment. A newer session has no
                        treatment details yet.
                      </p>
                    )}
                  </div>
                  <Link
                    href={`/clients/${client.id}/sessions/${lastTreatment.id}`}
                    className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
                  >
                    Open →
                  </Link>
                </div>
                {/* The same per-area summary the charting screen
                    shows. Charted laser/legacy sessions without
                    treatment areas fall back to their raw entries
                    list; a charted session always has one or the
                    other. */}
                {lastTreatmentSummary &&
                lastTreatmentSummary.areas.length > 0 ? (
                  <div className="mt-3">
                    <AreaSummaries summary={lastTreatmentSummary} />
                  </div>
                ) : (
                  <LastSessionEntries
                    modality={lastTreatment.modality}
                    electrolysisEntries={lastTreatment.electrolysis_entries}
                    laserEntries={lastTreatment.laser_entries}
                  />
                )}
                {/* PR #200 (Chloe iPad retest): the Watch/Plan box is
                    the card's flush footer band (attached variant +
                    full-bleed margins), so the pre-client warning
                    reads as PART of the Last treatment context, not a
                    floating sibling. PR #203: the band's CONTENT is
                    the pre-client context (the newest session with
                    any watch/plan, same as the charting page), so a
                    newer charted session without notes no longer
                    hides still-relevant guidance. Omitted cleanly
                    when there is nothing to say anywhere; this is the
                    ONLY From-last-visit render on the Sessions tab. */}
                {preClientWatchPlan &&
                  hasFromLastVisitContent(preClientWatchPlan) && (
                    <div className="-mx-5 -mb-5 mt-4">
                      <FromLastVisitForToday
                        summary={preClientWatchPlan}
                        attached
                      />
                    </div>
                  )}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
                No charted treatments yet.
              </div>
            )}
          </section>

          {/* 3. Appointment timeline (PR #157): Needs charting first,
                then Upcoming, then charted/cancelled/no-show. The
                group order lives in ClientAppointmentTimeline. */}
          <ClientAppointmentTimeline
            clientId={client.id}
            rows={appointmentTimeline}
          />

          {/* PR #197 (Chloe round 3): "Charted" and "Session history"
              were the same thing; the appointment timeline's History
              group is now the single history surface. Walk-in /
              legacy sessions with no linked appointment would vanish
              from History, so they keep a small collapsible of their
              own, rendered only when any exist. */}
          {(() => {
            const walkIns = sessions.filter(
              (sess) => !!sess && sess.appointment_id == null,
            );
            if (walkIns.length === 0) return null;
            return (
              <details className="flex flex-col gap-3">
                <summary className="cursor-pointer [&::-webkit-details-marker]:hidden">
                  <h2 className="inline text-lg font-medium">
                    <span className="mr-1 text-sm text-neutral-400">▸</span>
                    Sessions without an appointment
                    <span className="ml-2 text-sm font-normal text-neutral-500">
                      ({walkIns.length})
                    </span>
                  </h2>
                </summary>
                <div className="mt-3">
                  <SessionTimeline
                    clientId={client.id}
                    sessions={walkIns}
                    practitioners={practitioners}
                  />
                </div>
              </details>
            );
          })()}
        </>
      )}

      {activeTab === "treatment" && (
        <TreatmentPlansCard
          clientId={client.id}
          plans={treatmentPlans}
          createAction={createTreatmentPlanAction}
          closeAction={closeTreatmentPlanAction}
          updateNotesAction={updateTreatmentPlanNotesAction}
          createStageAction={createTreatmentPlanStageAction}
          updateStageAction={updateTreatmentPlanStageAction}
          deleteStageAction={deleteTreatmentPlanStageAction}
          practitionerNames={practitionerNames}
          autoOpenCreate={autoOpenCreatePlan}
          returnTo={planReturnTo}
        />
      )}
    </div>
  );
}

function LastSessionEntries({
  modality,
  electrolysisEntries,
  laserEntries,
}: {
  modality: "electrolysis" | "laser";
  electrolysisEntries: import("@/lib/types/database").ElectrolysisEntry[];
  laserEntries: import("@/lib/types/database").LaserEntry[];
}) {
  // PR #199: the empty fallbacks are gone. This component only renders
  // for the Last treatment card, and a session only qualifies as the
  // last treatment when it has areas or entries, so the old
  // database-flavored empty line is unreachable.
  if (modality === "electrolysis") {
    if (electrolysisEntries.length === 0) {
      return null;
    }
    const sorted = [...electrolysisEntries].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    return (
      <ul className="mt-4 flex flex-col gap-2">
        {sorted.map((e) => (
          <li key={e.id}>
            <ElectrolysisEntryRow entry={e} />
          </li>
        ))}
      </ul>
    );
  }
  if (laserEntries.length === 0) {
    return null;
  }
  const sorted = [...laserEntries].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  return (
    <ul className="mt-4 flex flex-col gap-2">
      {sorted.map((e) => (
        <li key={e.id}>
          <LaserEntryRow entry={e} />
        </li>
      ))}
    </ul>
  );
}
