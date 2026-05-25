import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getPinnedNotesForClient } from "@/lib/client-pinned-notes/queries";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PinnedNotesReadonly } from "@/components/pinned-notes-readonly";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import { AppointmentLifecycleActions } from "../AppointmentLifecycleActions";
import { PractitionerCancelForm } from "../PractitionerCancelForm";
import type {
  Appointment,
  Client,
  Practitioner,
  Service,
} from "@/lib/types/database";

type Joined = Appointment & {
  client: Pick<Client, "id" | "name" | "email" | "phone"> | null;
  service: Pick<Service, "id" | "name" | "default_duration_minutes"> | null;
  practitioner: Pick<Practitioner, "id" | "display_name" | "color"> | null;
};

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
      "*, client:clients(id, name, email, phone), service:services(id, name, default_duration_minutes), practitioner:practitioners(id, display_name, color)",
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

  // Workflow fix 3: the Cancel surface must not be presented for an
  // appointment whose start time has passed (in-progress OR ended).
  // The practitioner_cancel_appointment RPC already refuses these,
  // but the UI must not lead Chloe to click an action that can only
  // fail. For started/past appointments the lifecycle outcome buttons
  // (Mark complete / Mark no-show) are the only valid controls.
  const startsAtMs = new Date(data.starts_at).getTime();
  const isCancelable =
    typedStatus === "confirmed"
    && Number.isFinite(startsAtMs)
    && startsAtMs > Date.now();
  const pinnedNotes = data.client
    ? await getPinnedNotesForClient(studio.id, data.client.id)
    : [];

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/calendar"
        className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        ← Calendar
      </Link>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">
          {data.service?.name ?? "Appointment"}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          <FormattedDateTime iso={data.starts_at} /> · {data.duration_minutes} min
          {isCancelled && (
            <span className="ml-2 rounded bg-neutral-200 px-2 py-0.5 text-xs uppercase tracking-wider text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
              Cancelled
            </span>
          )}
        </p>
        <PractitionerLine practitioner={data.practitioner} />
      </header>

      <PinnedNotesReadonly notes={pinnedNotes} />

      <section className="rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
        <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Client
        </h2>
        {data.client ? (
          <div className="mt-2 flex flex-col gap-1">
            <Link
              href={`/clients/${data.client.id}`}
              className="font-medium hover:underline"
            >
              {data.client.name}
            </Link>
            <span className="text-neutral-500">
              {[data.client.email, data.client.phone].filter(Boolean).join(" · ")}
            </span>
          </div>
        ) : (
          <p className="mt-2 text-neutral-500">Client deleted.</p>
        )}
      </section>

      {data.notes && (
        <section className="rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Notes
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
            {data.notes}
          </p>
        </section>
      )}

      <EmailActivity appointment={data} />

      {typedStatus === "confirmed" && (
        <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Outcome
          </h2>
          <p className="text-xs text-neutral-500">
            Mark complete once the appointment finished. Mark no-show only if
            the client did not arrive — available after the end time.
          </p>
          <AppointmentLifecycleActions
            appointmentId={id}
            status={typedStatus}
            endsAt={data.ends_at}
          />
        </section>
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
        // Workflow fix 3: Cancel surface is shown ONLY when the
        // appointment is `confirmed` AND `starts_at > now()`. For
        // started/past confirmed appointments the lifecycle outcome
        // section above (Mark complete / Mark no-show) is the only
        // legitimate path.
        <PractitionerCancelForm appointmentId={id} />
      ) : null}
    </div>
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
      <p className="mt-2 text-sm text-neutral-400 dark:text-neutral-500">
        Unassigned
      </p>
    );
  }
  const color = resolvePractitionerColor(practitioner.color);
  return (
    <p className="mt-2 flex items-center gap-2 text-sm">
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

function EmailActivity({ appointment }: { appointment: Appointment }) {
  function row(label: string, iso: string | null) {
    return (
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="text-neutral-500">{label}</span>
        {iso ? (
          <span className="text-neutral-700 dark:text-neutral-300">
            <FormattedDateTime iso={iso} />
          </span>
        ) : (
          <span className="text-neutral-400">Not sent</span>
        )}
      </div>
    );
  }
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Email activity
      </h2>
      <div className="mt-3 flex flex-col gap-1.5">
        {row("Confirmation sent", appointment.confirmation_sent_at)}
        {row("24-hour reminder sent", appointment.reminder_24h_sent_at)}
        {row("2-hour reminder sent", appointment.reminder_2h_sent_at)}
        {appointment.no_show_email_sent_at &&
          row("No-show follow-up sent", appointment.no_show_email_sent_at)}
      </div>
    </section>
  );
}
