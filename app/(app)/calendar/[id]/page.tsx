import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getPinnedNotesForClient } from "@/lib/client-pinned-notes/queries";
import { getClientTags } from "@/lib/client-tags/queries";
import { getLatestIntakeForClient } from "@/lib/intake/queries";
import { getTreatmentPlansForClient } from "@/lib/treatment-plans/queries";
import { FITZPATRICK_TYPES } from "@/lib/constants";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PinnedNotesReadonly } from "@/components/pinned-notes-readonly";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import { AppointmentLifecycleActions } from "../AppointmentLifecycleActions";
import { PractitionerCancelForm } from "../PractitionerCancelForm";
import { PostcareSendButton } from "../PostcareSendButton";
import { buildPostcareEmail } from "@/lib/email/templates/postcare";
import {
  appointmentDisplayStatus,
  type AppointmentDisplayStatus,
} from "../appointment-display-status";
import type {
  Appointment,
  Client,
  ClientIntakeForm,
  ClientTag,
  Practitioner,
  Service,
  Session,
  TreatmentPlan,
} from "@/lib/types/database";

type ClientBriefing = Pick<
  Client,
  | "id"
  | "name"
  | "email"
  | "phone"
  | "pronouns"
  | "allergies"
  | "fitzpatrick_type"
  | "skin_notes"
>;

type Joined = Appointment & {
  client: ClientBriefing | null;
  service: Pick<
    Service,
    "id" | "name" | "default_duration_minutes" | "modality"
  > | null;
  practitioner: Pick<Practitioner, "id" | "display_name" | "color"> | null;
};

function fitzpatrickLabel(value: number | null): string | null {
  if (value == null) return null;
  const match = FITZPATRICK_TYPES.find((f) => f.value === value);
  return match ? match.label : `Type ${value}`;
}

export default async function AppointmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "*, client:clients(id, name, email, phone, pronouns, allergies, fitzpatrick_type, skin_notes), service:services(id, name, default_duration_minutes, modality), practitioner:practitioners(id, display_name, color)",
    )
    .eq("id", id)
    .eq("studio_id", studio.id)
    .maybeSingle<Joined>();
  if (error) throw new Error(error.message);
  if (!data) notFound();

  const isCancelled = data.status === "cancelled";
  // P0-1 + P0-3: typed alias so the lifecycle component sees an exhaustive
  // status union and not the raw `string` from the database row type.
  const typedStatus = data.status as
    | "confirmed"
    | "completed"
    | "cancelled"
    | "no_show";

  // Workflow fix 3 (preserved): cancel surface only for confirmed +
  // future. Past/in-progress confirmed appointments expose Mark
  // complete / Mark no-show only.
  const startsAtMs = new Date(data.starts_at).getTime();
  const isCancelable =
    typedStatus === "confirmed"
    && Number.isFinite(startsAtMs)
    && startsAtMs > Date.now();

  // Display-derived status (DB row unchanged). A past confirmed appointment
  // reads as "Done"; the stored status stays confirmed so Mark no-show stays
  // available. Computed at render time; no timer.
  const displayStatus = appointmentDisplayStatus(data.status, data.ends_at);

  // Briefing reads — every additional fetch below is read-only,
  // scoped to the authenticated practitioner's studio via RLS, and
  // already used elsewhere in the app. No new RPCs, no mutations.
  let pinnedNotes: Awaited<ReturnType<typeof getPinnedNotesForClient>> = [];
  let tags: ClientTag[] = [];
  let intake: ClientIntakeForm | null = null;
  let treatmentPlans: Awaited<
    ReturnType<typeof getTreatmentPlansForClient>
  > = [];
  let lastSession: Pick<
    Session,
    "id" | "started_at" | "modality" | "session_notes"
  > | null = null;

  if (data.client) {
    const clientId = data.client.id;
    const [pinnedRes, tagsRes, intakeRes, plansRes, lastSessionRes] =
      await Promise.all([
        getPinnedNotesForClient(studio.id, clientId),
        getClientTags(studio.id, clientId),
        getLatestIntakeForClient(studio.id, clientId),
        getTreatmentPlansForClient(studio.id, clientId),
        // Most recent non-deleted session that began before this
        // appointment. Used as a one-line "what happened last time"
        // hint above the per-visit chart. Narrow column set; no
        // entries, no audit, no notes leakage beyond the existing
        // owner-only view.
        supabase
          .from("sessions")
          .select("id, started_at, modality, session_notes")
          .eq("studio_id", studio.id)
          .eq("client_id", clientId)
          .is("deleted_at", null)
          .lt("started_at", data.starts_at)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    pinnedNotes = pinnedRes;
    tags = tagsRes;
    intake = intakeRes;
    treatmentPlans = plansRes;
    if (lastSessionRes.error) {
      throw new Error(
        `Failed to load last session: ${lastSessionRes.error.message}`,
      );
    }
    lastSession = (lastSessionRes.data ?? null) as
      | Pick<Session, "id" | "started_at" | "modality" | "session_notes">
      | null;
  }

  const activePlans = treatmentPlans.filter((p) => p.status === "active");
  const fitzpatrick = fitzpatrickLabel(data.client?.fitzpatrick_type ?? null);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/calendar"
        className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        ← Calendar
      </Link>

      <StatusHeader
        serviceName={data.service?.name ?? "Appointment"}
        startsAt={data.starts_at}
        durationMinutes={data.duration_minutes}
        practitioner={data.practitioner}
        displayStatus={displayStatus}
      />

      <PinnedNotesReadonly notes={pinnedNotes} />

      {data.client?.allergies && (
        <section
          className="rounded-lg border-l-4 border-rose-400 bg-rose-50 px-5 py-4 dark:border-rose-500 dark:bg-rose-950/30"
          aria-label="Allergies"
        >
          <h2 className="text-xs font-semibold uppercase tracking-wider text-rose-900 dark:text-rose-200">
            Allergies
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-rose-950 dark:text-rose-100">
            {data.client.allergies}
          </p>
        </section>
      )}

      <ClientBriefingCard
        client={data.client}
        tags={tags}
        intake={intake}
        fitzpatrick={fitzpatrick}
      />

      <LastSessionCard session={lastSession} />

      <TreatmentPlanCard plans={activePlans} />

      {typedStatus === "confirmed" && (
        <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Outcome
          </h2>
          <p className="text-xs text-neutral-500">
            {displayStatus === "done"
              ? "This appointment's time has passed, so it shows as Done. Its status stays confirmed, so mark no-show if the client did not arrive."
              : "Mark no-show only if the client did not arrive (available after the end time)."}
          </p>
          <AppointmentLifecycleActions
            appointmentId={id}
            status={typedStatus}
            endsAt={data.ends_at}
          />
        </section>
      )}

      {/* Postcare email (PR audit + spec). Manual, owner-driven, NOT a
          completion event. Gate is intentionally narrow per spec: the
          service must not be a consultation and the client must have an
          email on file. Status is NOT a gate so this never depends on
          display-derived "done"; the practitioner decides when to
          send. Hidden entirely when gates fail; an empty postcare-
          aftercare-text in studio settings produces an inline error at
          send time rather than hiding the button (so the practitioner
          discovers the missing setup intentionally). */}
      {data.service?.modality !== "consultation" && data.client?.email && (
        <PostcareSection
          appointmentId={id}
          studioName={studio.name}
          studioEmail={studio.owner_email}
          studioTimezone={studio.timezone}
          aftercareText={studio.postcare_aftercare_text}
          warningSignsText={studio.postcare_warning_signs_text}
          productRecommendationsText={
            studio.postcare_product_recommendations_text
          }
          reviewUrl={studio.postcare_review_url}
          clientName={data.client.name}
          serviceName={data.service?.name ?? null}
          startsAt={data.starts_at}
          practitionerName={data.practitioner?.display_name ?? null}
          postcareEmailSentAt={data.postcare_email_sent_at}
          postcareEmailSendAttempts={data.postcare_email_send_attempts}
        />
      )}

      {typedStatus === "completed" && (
        <section className="rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          Completed
        </section>
      )}

      {typedStatus === "no_show" && (
        <section className="rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          No-show
        </section>
      )}

      {isCancelled ? (
        <section className="rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          Cancelled
          {data.cancelled_by ? ` by ${data.cancelled_by}` : ""}
          {data.cancelled_at && (
            <>
              {" "}
              · <FormattedDateTime iso={data.cancelled_at} />
            </>
          )}
          {data.cancellation_reason && (
            <p className="mt-2 text-neutral-600 dark:text-neutral-400">
              {data.cancellation_reason}
            </p>
          )}
        </section>
      ) : isCancelable ? (
        // Workflow fix 3 (preserved): Cancel surface is shown ONLY when
        // the appointment is `confirmed` AND `starts_at > now()`. For
        // started/past confirmed appointments the lifecycle outcome
        // section above (Mark complete / Mark no-show) is the only
        // legitimate path.
        <PractitionerCancelForm appointmentId={id} />
      ) : null}

      {data.notes && (
        <section className="rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Appointment notes
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
            {data.notes}
          </p>
        </section>
      )}

      <details className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wider text-neutral-500">
          Email activity
        </summary>
        <div className="mt-3 flex flex-col gap-1.5">
          <EmailRow
            label="Confirmation"
            iso={data.confirmation_sent_at}
            attempts={data.confirmation_send_attempts}
          />
          <EmailRow
            label="24-hour reminder"
            iso={data.reminder_24h_sent_at}
            attempts={data.reminder_24h_send_attempts}
          />
          <EmailRow
            label="2-hour reminder"
            iso={data.reminder_2h_sent_at}
            attempts={data.reminder_2h_send_attempts}
          />
          {data.no_show_email_sent_at && (
            <EmailRow
              label="No-show follow-up"
              iso={data.no_show_email_sent_at}
              attempts={data.no_show_email_send_attempts}
            />
          )}
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status header — pulls the status pill out of the body copy so it's the
// first thing a practitioner reads.
// ---------------------------------------------------------------------------
function StatusHeader({
  serviceName,
  startsAt,
  durationMinutes,
  practitioner,
  displayStatus,
}: {
  serviceName: string;
  startsAt: string;
  durationMinutes: number;
  practitioner: Pick<Practitioner, "id" | "display_name" | "color"> | null;
  displayStatus: AppointmentDisplayStatus;
}) {
  return (
    <header className="flex flex-col gap-2">
      <StatusPill status={displayStatus} />
      <h1 className="text-3xl font-semibold tracking-tight">{serviceName}</h1>
      <p className="text-sm text-neutral-500">
        <FormattedDateTime iso={startsAt} /> · {durationMinutes} min
      </p>
      <PractitionerLine practitioner={practitioner} />
    </header>
  );
}

function StatusPill({ status }: { status: AppointmentDisplayStatus }) {
  const variant: Record<
    AppointmentDisplayStatus,
    { label: string; classes: string }
  > = {
    upcoming: {
      label: "Confirmed",
      classes:
        "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
    },
    // Display-derived: a past confirmed appointment. Distinct from DB
    // "Completed" (neutral) so the two never read as the same thing.
    done: {
      label: "Done",
      classes:
        "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
    },
    completed: {
      label: "Completed",
      classes:
        "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    },
    cancelled: {
      label: "Cancelled",
      classes:
        "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    },
    no_show: {
      label: "No-show",
      classes:
        "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    },
  };
  const v = variant[status];
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${v.classes}`}
    >
      {v.label}
    </span>
  );
}

function PractitionerLine({
  practitioner,
}: {
  practitioner: Pick<Practitioner, "id" | "display_name" | "color"> | null;
}) {
  const name = practitioner?.display_name?.trim();
  if (!practitioner || !name) {
    return (
      <p className="text-sm text-neutral-400 dark:text-neutral-500">
        Unassigned
      </p>
    );
  }
  const color = resolvePractitionerColor(practitioner.color);
  return (
    <p className="flex items-center gap-2 text-sm">
      <span
        aria-hidden
        className={`inline-block h-2.5 w-2.5 rounded-full ${color.bg}`}
      />
      <span className="font-medium text-neutral-800 dark:text-neutral-200">
        {name}
      </span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Client briefing — name + contact + pronouns + tags + skin + intake status
// in one calm card.
// ---------------------------------------------------------------------------
function ClientBriefingCard({
  client,
  tags,
  intake,
  fitzpatrick,
}: {
  client: ClientBriefing | null;
  tags: ClientTag[];
  intake: ClientIntakeForm | null;
  fitzpatrick: string | null;
}) {
  if (!client) {
    return (
      <section className="rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Client
        </h2>
        <p className="mt-2 text-neutral-500">Client deleted.</p>
      </section>
    );
  }
  const contact = [client.email, client.phone].filter(Boolean).join(" · ");
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Client
      </h2>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          href={`/clients/${client.id}`}
          className="text-base font-medium hover:underline"
        >
          {client.name}
        </Link>
        {client.pronouns && (
          <span className="text-sm text-neutral-500">{client.pronouns}</span>
        )}
      </div>
      {contact && (
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {contact}
        </p>
      )}
      {tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              {t.label}
            </span>
          ))}
        </div>
      )}
      {(fitzpatrick || client.skin_notes) && (
        <div className="mt-3 flex flex-col gap-1 text-sm">
          {fitzpatrick && (
            <p className="text-neutral-700 dark:text-neutral-300">
              <span className="text-neutral-500">Fitzpatrick:</span>{" "}
              {fitzpatrick}
            </p>
          )}
          {client.skin_notes && (
            <p className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
              <span className="text-neutral-500">Skin notes:</span>{" "}
              {client.skin_notes}
            </p>
          )}
        </div>
      )}
      <IntakeStatusLine intake={intake} clientId={client.id} />
    </section>
  );
}

function IntakeStatusLine({
  intake,
  clientId,
}: {
  intake: ClientIntakeForm | null;
  clientId: string;
}) {
  // Intake color convention (see app/(app)/dashboard/page.tsx):
  //   reviewed → green/calm (good state)
  //   everything else (no form, in progress, awaiting review) → amber,
  //   because each is a "needs attention before this appointment" state
  //   Chloe said was too easy to miss when rendered as quiet grey.
  if (!intake) {
    return (
      <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-400">
        Intake: no form on file.
      </p>
    );
  }
  if (intake.status === "reviewed") {
    return (
      <p className="mt-3 text-xs">
        <span className="text-neutral-500">Intake:</span>{" "}
        <span className="font-medium text-emerald-700 dark:text-emerald-400">
          Reviewed
        </span>{" "}
        ·{" "}
        <Link
          href={`/clients/${clientId}/intake`}
          className="text-neutral-700 hover:underline dark:text-neutral-300"
        >
          View
        </Link>
      </p>
    );
  }
  if (intake.status === "submitted") {
    return (
      <p className="mt-3 text-xs">
        <span className="text-neutral-500">Intake:</span>{" "}
        <span className="font-medium text-amber-700 dark:text-amber-400">
          Awaiting review
        </span>{" "}
        ·{" "}
        <Link
          href={`/clients/${clientId}/intake`}
          className="text-neutral-700 hover:underline dark:text-neutral-300"
        >
          Review
        </Link>
      </p>
    );
  }
  if (intake.status === "in_progress") {
    return (
      <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-400">
        Intake: started, not yet submitted.
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Last session memory — one calm row pointing at the previous visit.
// ---------------------------------------------------------------------------
function LastSessionCard({
  session,
}: {
  session: Pick<
    Session,
    "id" | "started_at" | "modality" | "session_notes"
  > | null;
}) {
  if (!session) {
    return (
      <section className="rounded-lg border border-dashed border-neutral-300 p-5 text-sm text-neutral-500 dark:border-neutral-700">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Last session
        </h2>
        <p className="mt-2">No previous session logged for this client.</p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Last session
      </h2>
      <p className="mt-2 text-sm">
        <span className="font-medium">
          <FormattedDateTime iso={session.started_at} />
        </span>
        <span className="text-neutral-500"> · {session.modality}</span>
      </p>
      {session.session_notes && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">
          {session.session_notes}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Treatment plan — active plans only on the briefing surface. Closed plans
// stay on the client profile.
// ---------------------------------------------------------------------------
function TreatmentPlanCard({
  plans,
}: {
  plans: ReadonlyArray<TreatmentPlan & { attached_count: number }>;
}) {
  if (plans.length === 0) {
    return (
      <section className="rounded-lg border border-dashed border-neutral-300 p-5 text-sm text-neutral-500 dark:border-neutral-700">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Treatment plan
        </h2>
        <p className="mt-2">No active treatment plan yet.</p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Treatment plan
      </h2>
      <ul className="mt-2 flex flex-col gap-2 text-sm">
        {plans.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-baseline justify-between gap-3"
          >
            <span className="font-medium">{p.name}</span>
            <span className="text-xs text-neutral-500">
              {p.attached_count}{" "}
              {p.attached_count === 1 ? "session" : "sessions"}
              {p.suggested_visit_count > 0 && ` of ~${p.suggested_visit_count}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Three-state row:
//   * sent_at set         → "Sent <time>"
//   * sent_at null, attempts > 0 → "Failed after N attempt(s)"
//   * sent_at null, attempts = 0 → "Not sent"
// Pure read-only from the appointment row. Attempt counts come from the
// existing reminder_*_send_attempts / confirmation_send_attempts /
// no_show_email_send_attempts columns the row already loaded. No retry
// implied — this is just an honest status display.
function EmailRow({
  label,
  iso,
  attempts,
}: {
  label: string;
  iso: string | null;
  attempts: number;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
      <span className="text-neutral-500">{label}</span>
      {iso ? (
        <span className="text-neutral-700 dark:text-neutral-300">
          Sent <FormattedDateTime iso={iso} />
        </span>
      ) : attempts > 0 ? (
        <span className="text-amber-700 dark:text-amber-400">
          Failed after {attempts} attempt{attempts === 1 ? "" : "s"}
        </span>
      ) : (
        <span className="text-neutral-400">Not sent</span>
      )}
    </div>
  );
}


// Postcare section (manual practitioner-triggered email).
//
// Server-renders the preview text once via buildPostcareEmail and
// passes it to the client-side PostcareSendButton, so the modal opens
// instantly with the exact text the client will receive. No new fetch
// at button-click time; no auto-send; no completion-event coupling.
//
// When postcare_aftercare_text is empty the button still renders but
// the send action returns a friendly "Add postcare aftercare text in
// Studio settings before sending postcare." error. Choosing "render
// + late-error" over "hide on empty" matches the spec's intent that
// the practitioner discovers the missing setup intentionally.
function PostcareSection(props: {
  appointmentId: string;
  studioName: string;
  studioEmail: string;
  studioTimezone: string;
  aftercareText: string | null;
  warningSignsText: string | null;
  productRecommendationsText: string | null;
  reviewUrl: string | null;
  clientName: string;
  serviceName: string | null;
  startsAt: string;
  practitionerName: string | null;
  postcareEmailSentAt: string | null;
  postcareEmailSendAttempts: number;
}) {
  const preview = buildPostcareEmail({
    clientName: props.clientName,
    studioName: props.studioName,
    studioEmail: props.studioEmail,
    practitionerName: props.practitionerName,
    serviceName: props.serviceName,
    startsAt: props.startsAt ? new Date(props.startsAt) : null,
    timezone: props.studioTimezone,
    aftercareText: props.aftercareText,
    warningSignsText: props.warningSignsText,
    productRecommendationsText: props.productRecommendationsText,
    reviewUrl: props.reviewUrl,
  });

  const aftercareConfigured =
    !!props.aftercareText && props.aftercareText.trim().length > 0;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Postcare email
      </h2>
      <p className="text-xs text-neutral-500">
        {aftercareConfigured
          ? "Send the client your studio's aftercare information. Preview the email before sending."
          : "Add postcare aftercare text in Studio settings before sending."}
      </p>
      <PostcareSendButton
        appointmentId={props.appointmentId}
        alreadySentAt={props.postcareEmailSentAt}
        sendAttempts={props.postcareEmailSendAttempts}
        previewText={preview.preview}
      />
    </section>
  );
}
