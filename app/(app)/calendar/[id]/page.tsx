import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getPinnedNotesForClient } from "@/lib/client-pinned-notes/queries";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PinnedNotesReadonly } from "@/components/pinned-notes-readonly";
import { cancelAppointmentAction } from "../actions";
import type { Appointment, Client, Service } from "@/lib/types/database";

type Joined = Appointment & {
  client: Pick<Client, "id" | "name" | "email" | "phone"> | null;
  service: Pick<Service, "id" | "name" | "default_duration_minutes"> | null;
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
    .select("*, client:clients(id, name, email, phone), service:services(id, name, default_duration_minutes)")
    .eq("id", id)
    .eq("studio_id", studio.id)
    .maybeSingle<Joined>();
  if (error) throw new Error(error.message);
  if (!data) notFound();

  const isCancelled = data.status === "cancelled";
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
      ) : (
        <form
          action={async (fd: FormData) => {
            "use server";
            fd.set("appointment_id", id);
            await cancelAppointmentAction(fd);
          }}
          className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
        >
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Cancel
          </h2>
          <textarea
            name="reason"
            rows={2}
            placeholder="Reason (optional)"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <div>
            <button
              type="submit"
              className="rounded-md border border-red-500 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-400 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              Cancel appointment
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
