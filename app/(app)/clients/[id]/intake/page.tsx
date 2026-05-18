import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getCurrentPractitionerWithStudio,
  getPractitionersForStudio,
} from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { getLatestIntakeForClient } from "@/lib/intake/queries";
import { INTAKE_STEPS, type Question } from "@/lib/intake/questions";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { IntakeReviewForm } from "./IntakeReviewForm";

function optionLabel(q: Question, value: string): string {
  const match = q.options?.find((o) => o.value === value);
  return match?.label ?? value;
}

function renderResponse(q: Question, value: unknown, notes: unknown): React.ReactNode {
  if (value === undefined || value === null || value === "") {
    return <span className="text-neutral-400">Not answered</span>;
  }
  if (q.type === "multi_select") {
    if (!Array.isArray(value) || value.length === 0) {
      return <span className="text-neutral-400">None selected</span>;
    }
    return (
      <span>
        {(value as unknown[])
          .filter((v): v is string => typeof v === "string")
          .map((v) => optionLabel(q, v))
          .join(", ")}
      </span>
    );
  }
  if (q.type === "single_select" && typeof value === "string") {
    return <span>{optionLabel(q, value)}</span>;
  }
  if (q.type === "yes_no" && typeof value === "string") {
    const notesText =
      typeof notes === "string" && notes.trim().length > 0 ? notes : null;
    return (
      <span>
        <span className="font-medium">{value === "yes" ? "Yes" : "No"}</span>
        {notesText && (
          <span className="block whitespace-pre-wrap text-neutral-600">
            {notesText}
          </span>
        )}
      </span>
    );
  }
  if (q.type === "checkbox") {
    return <span>{value === true ? "Confirmed" : "Not confirmed"}</span>;
  }
  if (typeof value === "string") {
    return <span className="whitespace-pre-wrap">{value}</span>;
  }
  return <span>{JSON.stringify(value)}</span>;
}

export default async function ClientIntakePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio } = await getCurrentPractitionerWithStudio();

  const supabase = await createClient();
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, name")
    .eq("studio_id", studio.id)
    .eq("id", id)
    .maybeSingle();
  if (clientErr) throw new Error(clientErr.message);
  if (!client) notFound();

  const intake = await getLatestIntakeForClient(studio.id, id);
  if (!intake) {
    return (
      <div className="flex flex-col gap-6">
        <Link
          href={`/clients/${id}`}
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← {client.name}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Health intake</h1>
        <p className="text-sm text-neutral-600">
          No intake on file for this client. An intake link is sent
          automatically with each booking confirmation.
        </p>
      </div>
    );
  }

  const practitioners = await getPractitionersForStudio(studio.id);
  const reviewer = intake.reviewed_by
    ? practitioners.find((p) => p.id === intake.reviewed_by)
    : null;
  const responses = (intake.responses ?? {}) as Record<string, unknown>;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link
          href={`/clients/${id}`}
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← {client.name}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Health intake</h1>
        <p className="text-sm text-neutral-500">
          {intake.status === "in_progress" && (
            <>
              Started <FormattedDateTime iso={intake.started_at} /> · not yet
              submitted
            </>
          )}
          {intake.status === "submitted" && intake.submitted_at && (
            <>
              Submitted <FormattedDateTime iso={intake.submitted_at} />
            </>
          )}
          {intake.status === "reviewed" && intake.reviewed_at && (
            <>
              Reviewed <FormattedDateTime iso={intake.reviewed_at} />
              {reviewer ? ` by ${reviewer.display_name || reviewer.email}` : ""}
            </>
          )}
        </p>
      </div>

      {responses.requires_epipen === "yes" && (
        <div className="rounded-md border border-red-400 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-100">
          <p className="font-semibold uppercase tracking-wider text-xs">
            EpiPen required
          </p>
          <p className="mt-1">
            This client requires an EpiPen. Confirm they have it with them
            before starting treatment.
          </p>
        </div>
      )}

      {intake.status === "in_progress" ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          The client has not submitted their intake yet. Responses shown below
          are what they have entered so far.
        </p>
      ) : null}

      <div className="flex flex-col gap-6">
        {INTAKE_STEPS.map((s) => (
          <section
            key={s.id}
            className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
          >
            <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
              {s.title}
            </h2>
            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
              {s.questions.map((q) => (
                <div key={q.key} className="flex flex-col gap-0.5">
                  <dt className="text-xs uppercase tracking-wider text-neutral-500">
                    {q.label}
                  </dt>
                  <dd className="text-neutral-800 dark:text-neutral-200">
                    {renderResponse(q, responses[q.key], responses[`${q.key}_notes`])}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      <IntakeReviewForm
        intakeId={intake.id}
        clientId={id}
        initialNotes={intake.practitioner_notes}
        alreadyReviewed={intake.status === "reviewed"}
      />
    </div>
  );
}
