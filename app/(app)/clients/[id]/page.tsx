import Link from "next/link";
import { notFound } from "next/navigation";
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
} from "@/lib/intake/queries";
import { computeFitzpatrickEstimate } from "@/lib/intake/fitzpatrick";
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
import { updateClientBirthdayAction } from "./birthday-actions";
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
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const activeTab: ProfileTab = isProfileTab(sp.tab) ? sp.tab : "overview";

  const { studio } = await getCurrentPractitionerWithStudio();
  const data = await getClientById(studio.id, id);

  if (!data) {
    notFound();
  }

  const { client, pricing, sessions, practitioners } = data;
  const lastSession = sessions[0];
  const olderSessions = sessions.slice(1);
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
  ]);
  const practitionerNames: Record<string, string> = Object.fromEntries(
    practitioners.map((p) => [p.id, p.display_name?.trim() || p.email]),
  );

  const lifetimeCents = sessions.reduce(
    (sum, s) => sum + (s.price_paid_cents ?? 0),
    0,
  );
  const sessionsWithPrice = sessions.filter(
    (s) => s.price_paid_cents != null,
  ).length;

  const lastPerformer = lastSession
    ? sessionPerformerName(lastSession, practitioners)
    : null;

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
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="text-3xl font-semibold tracking-tight">
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
              <Link
                href={`/clients/${client.id}/edit`}
                className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
              >
                Edit
              </Link>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
              {client.pronouns && <span>{client.pronouns}</span>}
              {client.phone && <span>· {client.phone}</span>}
              {client.email && <span>· {client.email}</span>}
            </div>
            {sessionsWithPrice > 0 && (
              <p className="mt-2 text-sm text-neutral-500">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">
                  {formatPrice(lifetimeCents)}
                </span>{" "}
                over {sessionsWithPrice}{" "}
                {sessionsWithPrice === 1 ? "session" : "sessions"}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <Link
              href={`/clients/${client.id}/sessions/new`}
              className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              + Log session
            </Link>
            {/* PR #157. Helper copy demoting this button to the
                "no appointment context" path now that the
                appointment timeline on the Sessions tab carries a
                per-row "Chart session" affordance that stamps the
                PR #156 appointment_id FK. The button stays so the
                practitioner can still log walk-ins / off-book
                sessions that have no booking attached. */}
            <p className="max-w-[16rem] text-right text-[11px] leading-snug text-neutral-500">
              For a session that is not tied to a booked appointment. Otherwise,
              chart from the appointment row in the Sessions tab.
            </p>
          </div>
        </div>
        <div className="mt-4">
          <BookAppointment
            clientId={client.id}
            services={services}
            defaultDate={today}
          />
        </div>
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
            removeAction={removeClientPinnedNoteAction}
          />

          {/* Secure portal messages (migration 0053). One-way
              practitioner → client only; the client reads + can
              acknowledge from /portal. Placed under pinned notes
              so the practitioner sees existing message review
              state alongside the rest of the every-visit
              priorities. */}
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
            const cardAuthTemplate = consentTemplatesAll.find(
              (t) =>
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
              />
            );
          })()}

          {/* Allergies/cautions are RED everywhere (see color convention
              in app/(app)/dashboard/page.tsx). Previously amber here,
              which collided with amber pinned notes and was inconsistent
              with the rose allergy banner on the appointment briefing.
              Allergies render above Birthday on the sidebar so the
              first thing the practitioner scans on the profile is
              clinical caution, not a birthday reminder. */}
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

          {/* Birthday card. Compact; renders an explicit "Birthday today"
              or "Birthday month" callout when relevant. Practitioner-only;
              never exposed to client/public surfaces. Placed below
              allergies so a clinical alert always wins the top scan
              position when one exists. */}
          <ClientBirthdayCard
            clientId={client.id}
            dateOfBirth={client.date_of_birth}
            studioToday={parseStudioToday(today)}
            accentColor={studio.birthday_reminder_color}
            action={updateClientBirthdayAction}
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
            <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
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

          {client.address && (
            <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
              <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
                Address
              </h2>
              <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-200">
                {client.address}
              </p>
            </section>
          )}

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
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-neutral-600">
                Intake started <FormattedDateTime iso={intake.started_at} />, not
                yet submitted.
              </p>
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
          {/* PR #157. Appointment timeline at the top of the Sessions
                tab. Surfaces upcoming + past + cancelled + no-show
                appointments grouped by practitioner urgency, with
                explicit Chart session / View session affordances per
                row using the PR #156 appointment_id FK. The legacy
                uncharted-past-visits section that sat further down
                has been removed; the new "Needs charting" group
                inside the timeline subsumes it without losing the
                same data. */}
          <ClientAppointmentTimeline
            clientId={client.id}
            rows={appointmentTimeline}
          />

          {/* Sessions tab (split out from the prior combined "Sessions
                & Treatment Plans" tab after Chloe's launch retest).
                Holds per-visit memory + progress totals. Treatment
                Plans is its own tab now.
                1. Last session; top of the tab. What the practitioner reaches
                for between visits. */}
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">Last session</h2>
            {lastSession ? (
              <div className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">
                      <FormattedDateTime iso={lastSession.started_at} />
                    </div>
                    <div className="text-xs text-neutral-500">
                      {lastSession.modality}
                      {lastPerformer && ` · ${lastPerformer}`}
                      {lastSession.price_paid_cents != null &&
                        ` · ${formatPrice(lastSession.price_paid_cents)} paid`}
                    </div>
                  </div>
                  <Link
                    href={`/clients/${client.id}/sessions/${lastSession.id}`}
                    className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
                  >
                    Open →
                  </Link>
                </div>
                <LastSessionEntries
                  modality={lastSession.modality}
                  electrolysisEntries={lastSession.electrolysis_entries}
                  laserEntries={lastSession.laser_entries}
                />
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
                No sessions logged yet for this client.
              </div>
            )}
          </section>

          {/* PR #157. The prior uncharted-past-visits section that
                lived here is now subsumed by the
                <ClientAppointmentTimeline /> at the top of this tab;
                its "Needs charting" group surfaces the same rows
                with the same Chart session affordance and link
                shape. Removing the duplicate keeps the Sessions tab
                calm per Chloe's clutter feedback. */}

          {/* 2. Treatment time totals + goal: progress-tracking,
                lower priority than immediate last-session memory.
                Lives with Sessions because it summarises session time
                over the course of treatment. */}
          <TreatmentTimeCard
            clientId={client.id}
            totals={treatmentTotals}
            breakdown={treatmentByArea}
            goal={treatmentGoal}
            upsertGoalAction={upsertTreatmentGoalAction}
          />

          {/* 3. Full timeline last. */}
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">All sessions</h2>
            <SessionTimeline
              clientId={client.id}
              sessions={olderSessions}
              practitioners={practitioners}
            />
          </section>
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
  if (modality === "electrolysis") {
    if (electrolysisEntries.length === 0) {
      return (
        <p className="mt-4 text-xs text-neutral-500">No entries logged.</p>
      );
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
    return <p className="mt-4 text-xs text-neutral-500">No entries logged.</p>;
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
