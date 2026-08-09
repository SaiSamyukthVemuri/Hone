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
  INTAKE_LINK_TTL_DAYS,
} from "@/lib/intake/queries";
import {
  INTAKE_STEPS,
  NONE_VALUE,
  type Question,
} from "@/lib/intake/questions";
import { computeFitzpatrickEstimate } from "@/lib/intake/fitzpatrick";
import {
  ACKNOWLEDGEMENT_REVIEW_COPY,
  readElectrolysisAcknowledgement,
  type IntakeLifecycleStatus,
} from "@/lib/intake/acknowledgements";
import {
  INTAKE_CONSENT_REVIEW_COPY,
  PORTAL_PHOTO_CONSENT_COPY,
  intakeConsentResponseLabel,
  readIntakeConsentResponses,
} from "@/lib/intake/consent-forms";
import { buildConsentReviewModel } from "@/lib/intake/consent-review-model";
import { IntakeConsentRecordViewer } from "@/components/intake-consent-record-viewer";
import {
  getPortalPhotoConsentsForPractitionerView,
  type PortalPhotoConsentView,
} from "@/lib/consent/queries";
import { SignedConsentViewer } from "@/components/signed-consent-viewer";
import {
  ASSISTED_ENTRY_REVIEW_COPY,
  readAssistedEntry,
} from "@/lib/intake/entry-provenance";
import {
  REVIEW_ANSWER_COPY,
  reviewAnswerState,
} from "@/lib/intake/review-answers";
import {
  deriveIntakeReviewFlags,
  MODALITY_WORDING,
  type IntakeReviewFlag,
} from "@/lib/intake/review-flags";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { IntakeReviewForm } from "./IntakeReviewForm";
import { IntakeReissueCard } from "./IntakeReissueCard";
import { IntakeResendCard } from "./IntakeResendCard";
import { computeIntakeLinkStatus } from "@/lib/intake/link-status";
import { IntakeHistoryList } from "./IntakeHistoryList";
import { NoneAnswerSummary } from "./NoneAnswerSummary";

function optionLabel(q: Question, value: string): string {
  const match = q.options?.find((o) => o.value === value);
  return match?.label ?? value;
}

function renderResponse(q: Question, value: unknown, notes: unknown): React.ReactNode {
  if (value === undefined || value === null || value === "") {
    return (
      <span className="text-neutral-400">
        {REVIEW_ANSWER_COPY.unanswered}
      </span>
    );
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

  // Photo consent lives in the CLIENT PORTAL, not in the intake, so the
  // practitioner reviewing an intake would otherwise have no way to see
  // whether this client has granted or denied photo use — which is exactly the
  // gap Chloe hit ("I can't see the answers to the consent forms"). Loaded
  // here and rendered beside the intake's own consent record, clearly labelled
  // as a different source. Null when the studio runs no photo consent form.
  // EVERY live photo form, not just one: a studio may run more than one, and
  // each is a separate question the client answers separately.
  const portalPhotos = await getPortalPhotoConsentsForPractitionerView(
    studio.id,
    id,
  );

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

      {/* Practitioner-assisted entry. Offered only while the intake is still
          being filled in — a submitted or reviewed intake is terminal and the
          correction model is a NEW intake, never a rewrite. The editor covers
          the questionnaire only; the client's own acknowledgements and the
          submission stay with the client. */}
      {intake.status === "in_progress" && (
        <section className="rounded-lg border border-neutral-300 p-5 dark:border-neutral-700">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
            With the client
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
            Sitting with {client.name}? Work through the questionnaire together
            and record their answers. They complete their own confirmations and
            submit at the end.
          </p>
          <Link
            href={`/clients/${id}/intake/assist?intake=${intake.id}`}
            className="mt-4 inline-flex min-h-[44px] items-center rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Complete intake with client
          </Link>
        </section>
      )}

      {/* PR #293: primary resend CTA for an in-progress intake — refreshes
          the link for THIS row and keeps saved answers. The reissue card
          below is the secondary "start a brand-new blank intake" path. */}
      {intake.status === "in_progress" && (
        <IntakeResendCard
          clientId={id}
          intakeId={intake.id}
          clientHasEmail={!!client.email}
          // Best-effort: an in-progress intake older than the 14-day link
          // TTL means the last link the client got has likely expired.
          linkMaybeExpired={
            Date.now() - new Date(intake.started_at).getTime() >
            INTAKE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000
          }
          status={computeIntakeLinkStatus(intake, Date.now())}
        />
      )}

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

      <IntakeReviewFlags responses={responses} />

      <FitzpatrickSummary responses={responses} />

      <IntakeEntrySummary
        responses={responses}
        reviewedBy={intake.reviewed_by}
      />

      <ElectrolysisAcknowledgementSummary
        responses={responses}
        status={intake.status}
      />

      <IntakeConsentFormsSummary
        responses={responses}
        status={intake.status}
        portalPhotos={portalPhotos}
      />

      {intake.status === "in_progress" ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          The client has not submitted their intake yet. Responses shown below
          are what they have entered so far.
        </p>
      ) : null}

      {/* Step-by-step intake answers, wrapped in native
          <details open> disclosures so a practitioner can collapse a
          long step once they have read it. Default open: nothing is
          hidden on first scan; the critical-answer cards above
          (EpiPen, Allergies, Fitzpatrick) keep doing their job. Slightly
          more breathing room (gap-y-4) and a bolder per-question label
          improve scannability without restructuring the data. */}
      <div className="flex flex-col gap-4">
        {INTAKE_STEPS.map((s) => (
          <details
            key={s.id}
            open
            className="group rounded-lg border border-neutral-200 dark:border-neutral-800"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                  Step {s.id} of {INTAKE_STEPS.length}
                </span>
                <h2 className="text-base font-medium tracking-tight text-neutral-900 dark:text-neutral-100">
                  {s.title}
                </h2>
              </div>
              <span
                aria-hidden
                className="select-none text-neutral-500 transition-transform group-open:rotate-180"
              >
                ▾
              </span>
            </summary>
            <div className="border-t border-neutral-200 px-5 py-5 dark:border-neutral-800">
              <dl className="grid grid-cols-1 gap-x-8 gap-y-5 text-sm md:grid-cols-2">
                {s.questions.map((q) => {
                  // Every question still gets a row — the reviewer sees the
                  // whole form, not a form with holes in it — but WHAT the row
                  // says is decided by the projection, which distinguishes an
                  // answer from "you were never asked this" and from "this
                  // record predates the question". See lib/intake/review-answers.
                  const state = reviewAnswerState(q, responses, intake.status);
                  return (
                    <div key={q.key} className="flex flex-col gap-1">
                      <dt className="text-xs font-medium text-neutral-500">
                        {q.label}
                      </dt>
                      <dd className="text-neutral-900 dark:text-neutral-100">
                        {state === "answered" ? (
                          renderResponse(
                            q,
                            responses[q.key],
                            responses[`${q.key}_notes`],
                          )
                        ) : (
                          // Deliberately does NOT fall through to
                          // renderResponse: for a non-applicable question a
                          // stale value may still be sitting in the jsonb, and
                          // rendering it would present an answer the client
                          // retracted as if it still stood.
                          <span className="text-neutral-400">
                            {REVIEW_ANSWER_COPY[state]}
                          </span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          </details>
        ))}
      </div>

      {/* F-CLIN-004: pass the ACTUAL server status. The previous
          `alreadyReviewed` boolean collapsed in_progress and submitted into a
          single "not reviewed" state, so the Mark reviewed CTA was rendered
          for intakes the client had never submitted. */}
      <IntakeReviewForm
        intakeId={intake.id}
        clientId={id}
        initialNotes={intake.practitioner_notes}
        status={intake.status}
        reviewedAtIso={intake.reviewed_at}
        reviewedByName={
          reviewer ? reviewer.display_name || reviewer.email : null
        }
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

// PR #266 / #267. Practitioner-only intake review flags. Surfaces existing
// intake answers Chloe wants reviewed before treatment (derived purely from
// `responses` by lib/intake/review-flags.ts). PR #267 adds modality/category
// badges from Chloe's clinic reference chart (thermolysis / continuous-galvanic
// / authorization / precaution). Renders nothing when there are no flags. Hone
// surfaces intake answers for review only and does not make treatment decisions
// — every flag cites the intake answer it came from and the card closes with
// the professional-judgment caveat. Allergy / EpiPen signals live in their own
// cards above; they are not duplicated here.
function flagTone(level: IntakeReviewFlag["level"]): string {
  if (level === "authorization") {
    return "border-red-400 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-100";
  }
  if (level === "review") {
    return "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/30 dark:text-rose-100";
  }
  return "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100";
}

function IntakeReviewFlags({
  responses,
}: {
  responses: Record<string, unknown>;
}) {
  const flags = deriveIntakeReviewFlags(responses);
  if (flags.length === 0) return null;

  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
        Intake review needed
      </h2>
      <p className="mt-1 text-xs text-neutral-500">
        Based on the latest recorded intake. Hone surfaces intake answers for
        review only and does not make treatment decisions.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {flags.map((flag) => (
          <li
            key={flag.id}
            className={`rounded-md border p-3 text-sm ${flagTone(flag.level)}`}
          >
            <span className="font-medium">{flag.category}</span>
            <p className="mt-1 text-xs opacity-80">{flag.basis}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {flag.badges.map((badge) => (
                <span
                  key={badge}
                  className="rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
                >
                  {MODALITY_WORDING[badge]}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-neutral-500">
        Use professional judgment and clinic policy.
      </p>
    </section>
  );
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

// Versioned electrolysis acknowledgement. A pure projection of what the
// row actually stores — it never re-validates the intake, never derives a
// verdict, and offers no control that could change the client's answer.
// The practitioner review surface reads this record; it does not author it.
//
// The wording shown for an acknowledged intake is the SNAPSHOT the client
// read at submit time, not the current constant, so editing the wording
// later cannot rewrite what a past client is shown to have agreed to.
//
// Every absent-record case is stated for what it is. An intake submitted
// before this acknowledgement existed says so explicitly rather than
// borrowing the question grid's "Not answered", which would attribute an
// omission to a client who was never shown the question.
function ElectrolysisAcknowledgementSummary({
  responses,
  status,
}: {
  responses: Record<string, unknown>;
  status: IntakeLifecycleStatus;
}) {
  const view = readElectrolysisAcknowledgement(responses, status);

  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
        {ACKNOWLEDGEMENT_REVIEW_COPY.heading}
      </h2>
      <div className="mt-3 flex flex-col gap-2 text-sm text-neutral-800 dark:text-neutral-200">
        {view.state === "acknowledged" && (
          <>
            <p className="font-medium">
              {ACKNOWLEDGEMENT_REVIEW_COPY.acknowledged}
            </p>
            <p className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
              {view.wording}
            </p>
            <p className="text-xs text-neutral-500">
              Version {view.version}
              {view.acceptedAtIso && (
                <>
                  {" · "}
                  <FormattedDateTime iso={view.acceptedAtIso} />
                </>
              )}
            </p>
          </>
        )}
        {view.state === "not_acknowledged" && (
          <>
            <p className="font-medium">
              {ACKNOWLEDGEMENT_REVIEW_COPY.notAcknowledged}
            </p>
            <p className="whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
              {view.wording}
            </p>
            <p className="text-xs text-neutral-500">Version {view.version}</p>
          </>
        )}
        {view.state === "no_record" && (
          <p className="text-neutral-600 dark:text-neutral-400">
            {ACKNOWLEDGEMENT_REVIEW_COPY.noRecord}
          </p>
        )}
        {view.state === "not_recorded" && (
          <p className="text-neutral-600 dark:text-neutral-400">
            {ACKNOWLEDGEMENT_REVIEW_COPY.notRecorded}
          </p>
        )}
        {view.state === "unreadable" && (
          <p className="text-neutral-600 dark:text-neutral-400">
            {ACKNOWLEDGEMENT_REVIEW_COPY.unreadable}
          </p>
        )}
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        {ACKNOWLEDGEMENT_REVIEW_COPY.caveat}
      </p>
    </section>
  );
}

// HOW THE QUESTIONNAIRE ANSWERS GOT HERE.
//
// Renders NOTHING for an ordinary, self-completed intake — the overwhelming
// majority of rows carry no assisted-entry record, and an intake the client
// filled in themselves must not gain a badge.
//
// Deliberately a SEPARATE section from the electrolysis acknowledgement card
// below it. The two record different things by different people: this one says
// a practitioner recorded the questionnaire; that one is the client's own
// confirmation. Merging them would blur exactly the line this feature exists
// to draw.
//
// Names and dates come from the STORED snapshot, never from a current
// practitioner lookup — a practitioner who has since been deactivated must
// still be named here.
function IntakeEntrySummary({
  responses,
  reviewedBy,
}: {
  responses: Record<string, unknown>;
  reviewedBy: string | null;
}) {
  const view = readAssistedEntry(responses);
  if (view.state === "none") return null;

  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
        {ASSISTED_ENTRY_REVIEW_COPY.heading}
      </h2>
      <div className="mt-3 flex flex-col gap-2 text-sm text-neutral-800 dark:text-neutral-200">
        {view.state === "unreadable" && (
          <p className="text-neutral-600 dark:text-neutral-400">
            {ASSISTED_ENTRY_REVIEW_COPY.unreadable}
          </p>
        )}
        {view.state === "assisted" && (
          <>
            <p className="font-medium">
              {ASSISTED_ENTRY_REVIEW_COPY.assistedLead}{" "}
              {view.startedBy.display_name} on{" "}
              <FormattedDateTime iso={view.startedAtIso} />.
            </p>
            {view.showLastUpdated && (
              <p className="text-neutral-700 dark:text-neutral-300">
                Answers were last recorded by {view.lastUpdatedBy.display_name}{" "}
                on <FormattedDateTime iso={view.lastUpdatedAtIso} />.
              </p>
            )}
            <p className="text-neutral-700 dark:text-neutral-300">
              {view.handoffAtIso && view.handoffBy ? (
                <>
                  {ASSISTED_ENTRY_REVIEW_COPY.handedOver}{" "}
                  {view.handoffBy.display_name} on{" "}
                  <FormattedDateTime iso={view.handoffAtIso} />.{" "}
                  {ASSISTED_ENTRY_REVIEW_COPY.handedOverTail}
                </>
              ) : (
                ASSISTED_ENTRY_REVIEW_COPY.notHandedOver
              )}
            </p>
            <p className="text-xs text-neutral-500">
              {ASSISTED_ENTRY_REVIEW_COPY.acknowledgementSeparate}
            </p>
            {reviewedBy &&
              (reviewedBy === view.startedBy.practitioner_id ||
                reviewedBy === view.lastUpdatedBy.practitioner_id) && (
                <p className="text-xs text-neutral-500">
                  {ASSISTED_ENTRY_REVIEW_COPY.selfReviewed}
                </p>
              )}
          </>
        )}
      </div>
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

// Read-only record of the studio's live consent forms as the client completed
// them inside the intake.
//
// EVERY field rendered here comes from the SNAPSHOT stored at completion, not
// from today's consent_form_templates row — a studio that has since edited or
// retired a form must not change what a historical intake says the client read.
//
// Emits no form control: this is server-rendered prose, which is what makes it
// structurally impossible for a practitioner to complete a client's consent
// from the review surface (pinned by tests/source-guards/assisted-intake-guards).
//
// Vocabulary is constrained to INTAKE_CONSENT_REVIEW_COPY — "Acknowledged",
// "Accepted", "Denied". Never "Signed": nothing here is a signature, and only
// the portal's own signature records may be described that way.
// The four portal states, in the practitioner's words. `not_signed` cannot
// occur for photo consent (consentRowState returns `not_answered`) but is
// mapped rather than left to fall through, so a future vocabulary change
// cannot silently render an empty status.
function portalPhotoLabel(state: PortalPhotoConsentView["state"]): string {
  switch (state) {
    case "granted":
      return PORTAL_PHOTO_CONSENT_COPY.granted;
    case "denied":
      return PORTAL_PHOTO_CONSENT_COPY.denied;
    case "outdated":
      return PORTAL_PHOTO_CONSENT_COPY.needsReview;
    default:
      return PORTAL_PHOTO_CONSENT_COPY.notCompleted;
  }
}

function IntakeConsentFormsSummary({
  responses,
  status,
  portalPhotos,
}: {
  responses: Record<string, unknown>;
  status: IntakeLifecycleStatus;
  portalPhotos: PortalPhotoConsentView[];
}) {
  const view = readIntakeConsentResponses(responses, status);
  // ONE current answer per consent question, prior answers demoted to history.
  // The partition and the supersession proof live in the pure model so they are
  // unit-testable without a browser; this component only renders the result.
  const model = buildConsentReviewModel({
    intakeForms: view.state === "recorded" ? view.forms : [],
    portalPhotos,
  });
  const hasCurrent =
    model.currentIntakeForms.length > 0 || model.currentPortalPhotos.length > 0;

  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
        {INTAKE_CONSENT_REVIEW_COPY.heading}
      </h2>

      {/* ================= 1 · CURRENT CONSENT =================
          Highest visual priority, and FIRST in the DOM so it is also first at
          a phone width where everything stacks. Every row is compact by
          design: title, the answer, where the answer came from, when. The
          legal wording is one click away and never inline — that combination
          is what makes "can this client's photos be taken?" a sub-second
          question instead of a reading exercise. */}
      {hasCurrent && (
        <div className="mt-3" data-testid="consent-current-block">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            {INTAKE_CONSENT_REVIEW_COPY.currentHeading}
          </h3>
          <div className="mt-2 flex flex-col gap-4 text-sm text-neutral-800 dark:text-neutral-200">
            {/* Intake-owned and still current: treatment consent. */}
            {model.currentIntakeForms.map((form, i) => (
              <div
                key={`${form.formType}-${i}`}
                className="flex flex-col gap-1"
                data-testid="intake-review-consent-form"
                data-form-type={form.formType}
              >
                <p className="font-medium">{form.titleSnapshot}</p>
                <p
                  data-testid="consent-current-status"
                  className="font-medium text-neutral-700 dark:text-neutral-300"
                >
                  {intakeConsentResponseLabel(form)}
                </p>
                <p className="text-xs text-neutral-500">
                  {INTAKE_CONSENT_REVIEW_COPY.recordedInIntake}
                  {" · "}Version {form.templateVersion}
                  {form.respondedAtIso && (
                    <>
                      {" · "}
                      <FormattedDateTime iso={form.respondedAtIso} />
                    </>
                  )}
                </p>
                <IntakeConsentRecordViewer
                  form={form}
                  label={INTAKE_CONSENT_REVIEW_COPY.viewRecordedForm}
                />
              </div>
            ))}

            {/* Portal-owned and current: photo consent.
                ONE ROW PER LIVE TEMPLATE — #545's multi-form correction, kept
                exactly. Two live photo forms are two separate questions;
                collapsing them into a single granted/denied would drop a real
                consent record, and ranking them by `version` would do it
                silently, since version is a template's own history and not a
                ranking between templates. */}
            {model.currentPortalPhotos.map((photo) => (
              <div
                key={photo.templateId}
                data-testid="review-portal-photo-consent"
                data-template-id={photo.templateId}
                data-state={photo.state}
                className="flex flex-col gap-1 text-sm"
              >
                <p className="font-medium">{photo.templateTitle}</p>
                <p
                  data-testid="review-portal-photo-status"
                  className="font-medium text-neutral-700 dark:text-neutral-300"
                >
                  {portalPhotoLabel(photo.state)}
                </p>
                {photo.record?.signed_at ? (
                  <p className="text-xs text-neutral-500">
                    {PORTAL_PHOTO_CONSENT_COPY.currentPortalResponse}
                    {" · "}
                    <FormattedDateTime iso={photo.record.signed_at} />
                    {" · "}Version {photo.record.template_version}
                  </p>
                ) : (
                  <p className="text-xs text-neutral-500">
                    {PORTAL_PHOTO_CONSENT_COPY.notCompletedHint}
                  </p>
                )}
                {photo.state === "outdated" && (
                  <p className="text-xs text-neutral-500">
                    {PORTAL_PHOTO_CONSENT_COPY.needsReviewHint}
                  </p>
                )}
                {/* The existing signed-record viewer, reused rather than
                    rebuilt — one signed-consent engine, as PR #405
                    established. */}
                {photo.record && (
                  <SignedConsentViewer
                    record={photo.record}
                    formType="photo_consent"
                    currentVersion={photo.currentVersion}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-4 text-sm text-neutral-800 dark:text-neutral-200">
        {view.state === "no_record" && (
          <p className="text-neutral-600 dark:text-neutral-400">
            {INTAKE_CONSENT_REVIEW_COPY.noRecord}
          </p>
        )}
        {view.state === "none_recorded" && (
          <p className="text-neutral-600 dark:text-neutral-400">
            {INTAKE_CONSENT_REVIEW_COPY.noneRecorded}
          </p>
        )}
        {view.state === "unreadable" && (
          <p className="text-neutral-600 dark:text-neutral-400">
            {INTAKE_CONSENT_REVIEW_COPY.unreadable}
          </p>
        )}
      </div>
      {/* ================= 3 · PREVIOUS CONSENT HISTORY =================
          Immutable. Nothing here is deleted, rewritten or relabelled — an
          Accepted the client really gave still reads "Accepted", with its own
          version and timestamp. What changed is that it can no longer be
          mistaken for the operative answer: it is below the current block,
          collapsed by default, and every entry states its provenance.

          A client accepting at T1 and denying at T2 is a legitimate change of
          mind and BOTH records survive. The thing that is now impossible is
          the screen presenting them as two simultaneously current answers. */}
      {model.history.length > 0 && (
        <details
          className="mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-800"
          data-testid="consent-history-block"
        >
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300">
            {INTAKE_CONSENT_REVIEW_COPY.historyToggle}
          </summary>
          <div className="mt-3 flex flex-col gap-4 text-sm">
            {model.history.map((entry, i) => (
              <div
                key={`${entry.form.formType}-${i}`}
                className="flex flex-col gap-1"
                data-testid="consent-history-entry"
                data-form-type={entry.form.formType}
                data-provenance={entry.provenance}
              >
                <p className="font-medium">{entry.form.titleSnapshot}</p>
                <p className="text-xs uppercase tracking-wider text-neutral-500">
                  {INTAKE_CONSENT_REVIEW_COPY.previousResponse}
                </p>
                <p
                  data-testid="consent-history-status"
                  className="font-medium text-neutral-700 dark:text-neutral-300"
                >
                  {intakeConsentResponseLabel(entry.form)}
                </p>
                <p className="text-xs text-neutral-500">
                  {INTAKE_CONSENT_REVIEW_COPY.recordedInIntake}
                  {" · "}Version {entry.form.templateVersion}
                  {entry.form.respondedAtIso && (
                    <>
                      {" · "}
                      <FormattedDateTime iso={entry.form.respondedAtIso} />
                    </>
                  )}
                </p>
                {/* Provenance, and ONLY what the records prove. "Superseded"
                    requires the SAME template_id carrying a demonstrably newer
                    portal answer; a portal answer merely existing somewhere
                    proves nothing about this record. */}
                <p
                  data-testid="consent-history-provenance"
                  className="text-xs text-neutral-500"
                >
                  {entry.provenance === "superseded_by_portal"
                    ? INTAKE_CONSENT_REVIEW_COPY.supersededByPortal
                    : entry.provenance === "also_answered_in_portal"
                      ? INTAKE_CONSENT_REVIEW_COPY.alsoAnsweredInPortal
                      : INTAKE_CONSENT_REVIEW_COPY.noLongerCollected}
                </p>
                <IntakeConsentRecordViewer
                  form={entry.form}
                  label={INTAKE_CONSENT_REVIEW_COPY.viewPreviousForm}
                />
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            {INTAKE_CONSENT_REVIEW_COPY.historicalNote}
          </p>
        </details>
      )}

      <p className="mt-3 text-xs text-neutral-500">
        {INTAKE_CONSENT_REVIEW_COPY.caveat}
      </p>
    </section>
  );
}
