import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getCurrentPractitionerWithStudio,
  getPractitionersForStudio,
} from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import {
  getIntakeById,
  getIntakeHistoryForClient,
} from "@/lib/intake/queries";
import {
  INTAKE_STEPS,
  NONE_VALUE,
  type Question,
} from "@/lib/intake/questions";
import { computeFitzpatrickEstimate } from "@/lib/intake/fitzpatrick";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { IntakeReviewForm } from "./IntakeReviewForm";
import { IntakeReissueCard } from "./IntakeReissueCard";
import { IntakeHistoryList } from "./IntakeHistoryList";
import { NoneAnswerSummary } from "./NoneAnswerSummary";

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
    const selected = (value as unknown[]).filter(
      (v): v is string => typeof v === "string",
    );
    // When the client selected the exclusive "None" sentinel, the
    // raw answer alone reads as a vague "None of these apply to me"
    // with no context for the practitioner about WHAT was negated.
    // We surface the negated option set inline so the review is
    // self-contained: e.g. "None of these apply to me (out of:
    // pregnancy, diabetes, thyroid disorder, ...)". First five
    // non-None options shown; the remainder collapses to "+N more"
    // so very long lists (e.g. medical_conditions has 14) don't
    // dominate the review grid.
    if (selected.length === 1 && selected[0] === NONE_VALUE) {
      const noneLabel = optionLabel(q, NONE_VALUE);
      const others = (q.options ?? [])
        .filter((o) => o.value !== NONE_VALUE)
        .map((o) => o.label);
      // The truncate/expand UI lives in a tiny client component so the
      // practitioner can reveal the full negated list on demand
      // without paging away. No data is fetched on expand; the option
      // list is read from the current INTAKE_STEPS at render time.
      return <NoneAnswerSummary noneLabel={noneLabel} options={others} />;
    }
    return (
      <span>{selected.map((v) => optionLabel(q, v)).join(", ")}</span>
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ intake?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const requestedIntakeId =
    typeof sp.intake === "string" && sp.intake ? sp.intake : null;
  const { studio } = await getCurrentPractitionerWithStudio();

  const supabase = await createClient();
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, name, email")
    .eq("studio_id", studio.id)
    .eq("id", id)
    .maybeSingle();
  if (clientErr) throw new Error(clientErr.message);
  if (!client) notFound();

  // Full history powers the new IntakeHistoryList and the latest-vs-
  // requested resolution below. Cheap: small per-client cardinality.
  const history = await getIntakeHistoryForClient(studio.id, id);
  const latest = history[0] ?? null;

  // Default to latest; respect ?intake=<id> when the practitioner
  // clicked a non-latest row in the history. Falls back to latest if
  // the requested id is not in this client's history (deleted /
  // wrong-studio / typo).
  let intake = latest;
  if (requestedIntakeId) {
    const match = history.find((h) => h.id === requestedIntakeId);
    if (match) {
      intake = match;
    } else {
      // Best-effort lookup so a direct deep link still works as long
      // as the row is in this studio and not deleted; otherwise stay
      // on latest.
      const looked = await getIntakeById(studio.id, requestedIntakeId);
      if (looked && looked.client_id === id) intake = looked;
    }
  }

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
          automatically with each booking confirmation, or you can request
          one below.
        </p>
        <IntakeReissueCard
          clientId={id}
          clientHasEmail={!!client.email}
        />
      </div>
    );
  }

  const practitioners = await getPractitionersForStudio(studio.id);
  const reviewer = intake.reviewed_by
    ? practitioners.find((p) => p.id === intake.reviewed_by)
    : null;
  const responses = (intake.responses ?? {}) as Record<string, unknown>;
  const viewingNonLatest = latest != null && intake.id !== latest.id;

  // Pre-resolve per-row reviewer / requester display names for the
  // history list so the client component can stay pure UI.
  const historyRows = history.map((h) => ({
    id: h.id,
    status: h.status,
    started_at: h.started_at,
    submitted_at: h.submitted_at,
    reviewed_at: h.reviewed_at,
    reviewed_by_name: h.reviewed_by
      ? practitionerName(practitioners, h.reviewed_by)
      : null,
    requested_at: h.requested_at,
    requested_by_name: h.requested_by
      ? practitionerName(practitioners, h.requested_by)
      : null,
    isLatest: latest != null && h.id === latest.id,
  }));

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
        {viewingNonLatest && (
          <p className="rounded-md border border-neutral-300 bg-neutral-50 p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
            You are viewing a previous intake.{" "}
            <Link
              href={`/clients/${id}/intake`}
              className="font-medium underline"
            >
              View current intake
            </Link>
          </p>
        )}
      </div>

      <IntakeReissueCard
        clientId={id}
        clientHasEmail={!!client.email}
      />

      <IntakeHistoryList
        clientId={id}
        rows={historyRows}
        clientHasEmail={!!client.email}
      />

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

      <AllergiesSummary responses={responses} />

      <FitzpatrickSummary responses={responses} />

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

// Resolve practitioner display name from the prefetched list. Falls
// back to email if no display_name; returns null when the id is not
// in the studio's active practitioner set.
function practitionerName(
  practitioners: ReadonlyArray<{
    id: string;
    display_name: string | null;
    email: string;
  }>,
  id: string,
): string | null {
  const match = practitioners.find((p) => p.id === id);
  if (!match) return null;
  return match.display_name?.trim() ? match.display_name : match.email;
}

// Prominent allergy summary surfaced near the top of the intake review
// (separate from the per-question grid below). Sits below the EpiPen
// banner so EpiPen stays the single most-urgent signal, then the full
// list is right under it for scan-once review. Renders nothing when the
// client reported no allergies; otherwise renders as a rose card with
// each reported allergy on its own line.
function AllergiesSummary({
  responses,
}: {
  responses: Record<string, unknown>;
}) {
  const hasAllergies = responses.has_allergies === "yes";
  const requiresEpipen = responses.requires_epipen === "yes";
  const allergyNotes =
    typeof responses.has_allergies_notes === "string"
      ? responses.has_allergies_notes.trim()
      : "";
  const metalAllergy = responses.metal_allergy === "yes";
  const metalTypes = Array.isArray(responses.metal_allergy_types)
    ? (responses.metal_allergy_types as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const metalOther =
    typeof responses.metal_allergy_other_text === "string"
      ? responses.metal_allergy_other_text.trim()
      : "";
  const latexAllergy = responses.latex_allergy === "yes";
  const anestheticAllergy = responses.anesthetic_allergy === "yes";

  if (
    !hasAllergies &&
    !metalAllergy &&
    !latexAllergy &&
    !anestheticAllergy
  ) {
    return null;
  }

  const metalDetail: string[] = [];
  if (metalTypes.length > 0) metalDetail.push(metalTypes.join(", "));
  if (metalOther) metalDetail.push(metalOther);

  return (
    <section className="rounded-lg border border-rose-300 bg-rose-50 p-5 dark:border-rose-700 dark:bg-rose-950/30">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-rose-800 dark:text-rose-300">
        Allergies summary
      </h2>
      <ul className="mt-3 flex flex-col gap-1.5 text-sm text-rose-900 dark:text-rose-100">
        <li>
          <span className="font-medium">Severe reaction / EpiPen:</span>{" "}
          {requiresEpipen ? "Yes" : "No"}
        </li>
        {hasAllergies && (
          <li>
            <span className="font-medium">Allergies:</span>{" "}
            {allergyNotes || "Yes (no details provided)"}
          </li>
        )}
        {metalAllergy && (
          <li>
            <span className="font-medium">Metal allergy:</span>{" "}
            {metalDetail.length > 0 ? metalDetail.join("; ") : "Yes"}
          </li>
        )}
        {latexAllergy && (
          <li>
            <span className="font-medium">Latex allergy:</span> Yes
          </li>
        )}
        {anestheticAllergy && (
          <li>
            <span className="font-medium">Topical anesthetic allergy:</span> Yes
          </li>
        )}
      </ul>
    </section>
  );
}

// Fitzpatrick estimate summary. Renders nothing for older intakes that
// pre-date this section (computeFitzpatrickEstimate returns null when
// any of the ten Fitzpatrick answers are missing or malformed). Hair
// colour / texture in the treatment area are resolved to their option
// labels via the per-question option lookup the rest of the review
// already uses. The card is intentionally muted vs the Allergies one
// above: Fitzpatrick is context, not a clinical alert. The bottom line
// reminds the practitioner this is a self-reported intake estimate,
// not a clinical assessment.
function FitzpatrickSummary({
  responses,
}: {
  responses: Record<string, unknown>;
}) {
  const estimate = computeFitzpatrickEstimate(responses);
  const hairColorRaw = responses.hair_color_in_treatment_area;
  const hairTextureRaw = responses.hair_texture_in_treatment_area;
  const hairColorLabel =
    typeof hairColorRaw === "string"
      ? resolveOptionLabel("hair_color_in_treatment_area", hairColorRaw)
      : null;
  const hairTextureLabel =
    typeof hairTextureRaw === "string"
      ? resolveOptionLabel("hair_texture_in_treatment_area", hairTextureRaw)
      : null;

  // Nothing to render: this intake pre-dates the Fitzpatrick section
  // and has no hair colour/texture either. Keep silent rather than
  // showing a "Not completed" stub for every older record.
  if (!estimate && !hairColorLabel && !hairTextureLabel) {
    return null;
  }

  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
        Fitzpatrick skin typing
      </h2>
      <ul className="mt-3 flex flex-col gap-1.5 text-sm text-neutral-800 dark:text-neutral-200">
        {estimate ? (
          <>
            <li>
              <span className="font-medium">Estimated Fitzpatrick type:</span>{" "}
              {estimate.type}
            </li>
            <li>
              <span className="font-medium">Score:</span> {estimate.score} / 40
            </li>
          </>
        ) : (
          <li className="text-neutral-500">Fitzpatrick: not completed.</li>
        )}
        {(hairColorLabel || hairTextureLabel) && (
          <li>
            <span className="font-medium">Hair in treatment area:</span>{" "}
            {[hairColorLabel, hairTextureLabel].filter(Boolean).join(", ")}
          </li>
        )}
      </ul>
      <p className="mt-3 text-xs text-neutral-500">
        Self-reported intake estimate, not a clinical assessment.
      </p>
    </section>
  );
}

// Look up the option label for a single_select / multi_select answer
// by walking INTAKE_STEPS. Falls back to the raw value if the question
// or option isn't found (e.g. an older intake whose key has since been
// renamed). Pure, no React or I/O.
function resolveOptionLabel(key: string, value: string): string {
  for (const step of INTAKE_STEPS) {
    const q = step.questions.find((qq) => qq.key === key);
    if (q && q.options) {
      const opt = q.options.find((o) => o.value === value);
      return opt?.label ?? value;
    }
  }
  return value;
}
