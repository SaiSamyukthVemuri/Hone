import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  getCurrentPractitionerWithStudio,
  sessionPerformerName,
} from "@/lib/supabase/queries";
import { FITZPATRICK_TYPES } from "@/lib/constants";
import { SessionTimeline } from "@/components/session-timeline";
import {
  ElectrolysisEntryRow,
  LaserEntryRow,
} from "@/components/entry-row";
import { AddPricingForm } from "@/components/add-pricing-form";
import { ClientPinnedNotesCard } from "@/components/client-pinned-notes-card";
import { ClientTagsCard } from "@/components/client-tags-card";
import { TreatmentPlansCard } from "@/components/treatment-plans-card";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { getActiveServices } from "@/lib/booking/queries";
import { todayInTz } from "@/lib/booking/tz";
import {
  getLatestIntakeForClient,
  getLatestSubmittedOrReviewedIntakeForClient,
} from "@/lib/intake/queries";
import { computeFitzpatrickEstimate } from "@/lib/intake/fitzpatrick";
import { getClientTags } from "@/lib/client-tags/queries";
import { getPinnedNotesForClient } from "@/lib/client-pinned-notes/queries";
import { getTreatmentPlansForClient } from "@/lib/treatment-plans/queries";
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
  addClientTagAction,
  deleteClientPricingAction,
  removeClientTagAction,
} from "./actions";
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
  const tags = await getClientTags(studio.id, client.id);
  const pinnedNotes = await getPinnedNotesForClient(studio.id, client.id);
  const treatmentPlans = await getTreatmentPlansForClient(studio.id, client.id);
  const [treatmentTotals, treatmentByArea, treatmentGoal, personalNotes] =
    await Promise.all([
      getTotalTreatmentTime(studio.id, client.id),
      getTreatmentTimeByArea(studio.id, client.id),
      getTreatmentGoal(studio.id, client.id),
      // Phase: personal notes (migration 0035). Returns null when the
      // client has no row yet; the editor's defaultValues stay empty.
      getClientPersonalNotes(studio.id, client.id),
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
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/clients/${client.id}/sessions/new`}
              className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              + Log session
            </Link>
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

          <ClientTagsCard
            clientId={client.id}
            tags={tags}
            addAction={addClientTagAction}
            removeAction={removeClientTagAction}
          />

          {/* Details (non-clinical demographics). DOB lives here, not
              in Skin: Chloe pointed out DOB sitting under Skin was
              confusing because Skin is for Fitzpatrick / skin notes
              / clinical context. The Birthday card above handles the
              "today / this month" reminder UI; this row exposes the
              raw stored date for reference. */}
          <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
            <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
              Details
            </h2>
            <dl className="mt-3 flex flex-col gap-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-neutral-500">Date of birth</dt>
                <dd className="font-medium">
                  {client.date_of_birth ?? "Not set"}
                </dd>
              </div>
            </dl>
          </section>

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
