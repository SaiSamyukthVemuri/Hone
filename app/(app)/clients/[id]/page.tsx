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
import { getLatestIntakeForClient } from "@/lib/intake/queries";
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
} from "./treatment-plans-actions";

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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
  const tags = await getClientTags(studio.id, client.id);
  const pinnedNotes = await getPinnedNotesForClient(studio.id, client.id);
  const treatmentPlans = await getTreatmentPlansForClient(studio.id, client.id);
  const [treatmentTotals, treatmentByArea, treatmentGoal] = await Promise.all([
    getTotalTreatmentTime(studio.id, client.id),
    getTreatmentTimeByArea(studio.id, client.id),
    getTreatmentGoal(studio.id, client.id),
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

      <ClientPinnedNotesCard
        clientId={client.id}
        notes={pinnedNotes}
        addAction={addClientPinnedNoteAction}
        removeAction={removeClientPinnedNoteAction}
      />

      {client.allergies && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-5 dark:border-amber-700 dark:bg-amber-950/30">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
            Allergies
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-amber-900 dark:text-amber-100">
            {client.allergies}
          </p>
        </section>
      )}

      <ClientTagsCard
        clientId={client.id}
        tags={tags}
        addAction={addClientTagAction}
        removeAction={removeClientTagAction}
      />

      <section className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
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
        </div>

        <div className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Skin
          </h2>
          <dl className="mt-3 flex flex-col gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-500">Fitzpatrick</dt>
              <dd className="font-medium">
                {fitzpatrickLabel(client.fitzpatrick_type)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-500">Date of birth</dt>
              <dd className="font-medium">{client.date_of_birth ?? "Not set"}</dd>
            </div>
          </dl>
          {client.skin_notes && (
            <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">
              {client.skin_notes}
            </p>
          )}
        </div>
      </section>

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

      <TreatmentTimeCard
        clientId={client.id}
        totals={treatmentTotals}
        breakdown={treatmentByArea}
        goal={treatmentGoal}
        upsertGoalAction={upsertTreatmentGoalAction}
      />

      <TreatmentPlansCard
        clientId={client.id}
        plans={treatmentPlans}
        createAction={createTreatmentPlanAction}
        closeAction={closeTreatmentPlanAction}
        practitionerNames={practitionerNames}
      />

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
          <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-12 text-center dark:border-neutral-700 dark:bg-neutral-900">
            <p
              className="font-[var(--font-fraunces)] text-xl text-neutral-500 dark:text-neutral-400"
              style={{ letterSpacing: "-0.01em" }}
            >
              First session won&rsquo;t be long.
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">All sessions</h2>
        <SessionTimeline
          clientId={client.id}
          sessions={olderSessions}
          practitioners={practitioners}
        />
      </section>
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
