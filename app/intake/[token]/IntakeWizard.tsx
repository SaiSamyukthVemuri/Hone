"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  INTAKE_STEPS,
  TOTAL_STEPS,
  stepById,
  validateVisibleAnswers,
  visibleQuestionsForStep,
  type Step,
} from "@/lib/intake/questions";
import {
  INTAKE_CONSENT_RESPONSES,
  type IntakeConsentResponse,
} from "@/lib/intake/consent-forms";
import { IntakeQuestionField } from "@/components/intake/intake-question-field";
import {
  buildIntakeConsentClaims,
  findIncompleteConsentForms,
  IntakeConsentForms,
  type RenderedConsentForm,
} from "./IntakeConsentForms";
import { saveIntakeStepAction, submitIntakeAction } from "./actions";

type Responses = Record<string, unknown>;

// The consent forms are a wizard-LOCAL phase that follows step 5. It is
// deliberately NOT a sixth step: `client_intake_forms.current_step` is bounded
// by the questionnaire (1..TOTAL_STEPS) and every other surface — the assisted
// editor's clamp, the hand-off, findMissingRequiredAnswers — reads that
// contract. Persisting a 6 would be a schema change in all but name.
//
// So the phase lives only in this component's state, and every save it makes
// persists `current_step = TOTAL_STEPS`. A client who abandons the intake on
// the consent phase resumes on step 5 with their answers intact, which is
// truthful: they have not completed the consent forms.
const CONSENT_PHASE = TOTAL_STEPS + 1;

// RETIRED (#518): this component used to attach a versioned electrolysis
// acknowledgement claim to every save and submit. The acknowledgement is no
// longer collected — #529's real studio consent forms replaced it — so the
// claim is gone and the browser no longer sends anything under that key.
//
type Props = {
  token: string;
  studioName: string;
  initialStep: number;
  initialResponses: Responses;
  alreadySubmitted: boolean;
  // The studio's live treatment/photo consent forms, resolved server-side.
  // Empty when the studio has none live — the wizard then behaves exactly as
  // it did before this feature: step 5 submits.
  consentForms: RenderedConsentForm[];
};

export function IntakeWizard({
  token,
  studioName,
  initialStep,
  initialResponses,
  alreadySubmitted,
  consentForms,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState(
    Math.min(Math.max(initialStep, 1), TOTAL_STEPS),
  );
  const [responses, setResponses] = useState<Responses>(initialResponses);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingError, setSavingError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // The client's consent choices, keyed by template id.
  //
  // Seeded EMPTY, deliberately. A resumed draft may carry stored consent
  // entries, but re-checking a box on the client's behalf because a previous
  // session did is exactly the auto-acceptance this feature must not have —
  // and the stored entry may be against a version that has since changed. The
  // client re-reads the current text and answers again.
  const [consentAnswers, setConsentAnswers] = useState<
    Record<string, IntakeConsentResponse>
  >({});
  const [consentErrors, setConsentErrors] = useState<Record<string, string>>({});

  const hasConsentPhase = consentForms.length > 0;
  const lastPhase = hasConsentPhase ? CONSENT_PHASE : TOTAL_STEPS;

  // Attach the consent claims to whatever the wizard is about to send.
  // Applied on top of the acknowledgement claim so both carve-outs travel
  // together on every save and on submit.
  function withConsentClaims(base: Responses): Responses {
    if (!hasConsentPhase) return base;
    return {
      ...base,
      [INTAKE_CONSENT_RESPONSES.id]: {
        version: INTAKE_CONSENT_RESPONSES.version,
        forms: buildIntakeConsentClaims(consentForms, consentAnswers),
      },
    };
  }

  function outbound(): Responses {
    return withConsentClaims(responses);
  }

  function setConsentAnswer(
    templateId: string,
    response: IntakeConsentResponse | null,
  ) {
    setConsentAnswers((prev) => {
      const next = { ...prev };
      // Unticking a treatment checkbox CLEARS the answer rather than
      // recording a denial: a treatment consent has no "denied" state, and
      // storing one would be a false record of what the client did.
      if (response === null) delete next[templateId];
      else next[templateId] = response;
      return next;
    });
    setConsentErrors((prev) => {
      if (!prev[templateId]) return prev;
      const next = { ...prev };
      delete next[templateId];
      return next;
    });
  }

  const onConsentPhase = step === CONSENT_PHASE;
  const current: Step | undefined = stepById(step);

  // Conditional visibility comes from the shared questionnaire authority in
  // lib/intake/questions.ts. This component used to carry a private `isVisible`
  // fork of the same predicate; the fork is gone so the practitioner-assisted
  // editor and this wizard cannot disagree about which questions apply.
  const visibleQuestions = useMemo(
    () => visibleQuestionsForStep(step, responses),
    [step, responses],
  );

  if (alreadySubmitted) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-sm leading-relaxed text-neutral-700">
        <p>
          Your intake has already been submitted. Thank you. If you need to
          update anything, contact {studioName} directly.
        </p>
      </div>
    );
  }
  if (!current && !onConsentPhase) return null;

  function setValue(key: string, value: unknown) {
    setResponses((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function goBack() {
    if (step <= 1) return;
    const nextStep = step - 1;
    setSavingError(null);
    setStep(nextStep);
    startTransition(async () => {
      const res = await saveIntakeStepAction({
        token,
        // The consent phase is not a persisted step: leaving it saves against
        // the last real questionnaire step.
        step: Math.min(nextStep, TOTAL_STEPS),
        responses: outbound(),
      });
      if (!res.ok) setSavingError(res.error);
    });
  }

  function submit() {
    startTransition(async () => {
      const res = await submitIntakeAction({ token, responses: outbound() });
      if (!res.ok) {
        setSavingError(res.error);
        return;
      }
      router.push("/intake/thank-you");
    });
  }

  function goNext() {
    // The consent phase validates consent, not questionnaire answers.
    if (step === CONSENT_PHASE) {
      const incomplete = findIncompleteConsentForms(
        consentForms,
        consentAnswers,
      );
      if (Object.keys(incomplete).length > 0) {
        setConsentErrors(incomplete);
        return;
      }
      setConsentErrors({});
      setSavingError(null);
      submit();
      return;
    }

    const stepErrors = validateVisibleAnswers(
      visibleQuestions,
      responses,
      Date.now(),
    );
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }
    setErrors({});
    setSavingError(null);

    if (step < lastPhase) {
      const nextStep = step + 1;
      startTransition(async () => {
        const res = await saveIntakeStepAction({
          token,
          // Entering the consent phase still persists TOTAL_STEPS — the DB
          // step contract is unchanged by this feature.
          step: Math.min(nextStep, TOTAL_STEPS),
          responses: outbound(),
        });
        if (!res.ok) {
          setSavingError(res.error);
          return;
        }
        setStep(nextStep);
      });
      return;
    }

    // No consent phase for this studio: step 5 submits, exactly as before.
    submit();
  }

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator currentStep={step} showConsent={hasConsentPhase} />

      <div>
        <h2 className="text-[24px] font-semibold leading-tight tracking-tight">
          {onConsentPhase ? "Consent forms" : current!.title}
        </h2>
        {onConsentPhase ? (
          <p className="mt-2 text-sm text-neutral-600">
            Please read {studioName}&apos;s forms below and complete each one.
          </p>
        ) : (
          current!.description && (
            <p className="mt-2 text-sm text-neutral-600">
              {current!.description}
            </p>
          )
        )}
      </div>

      {onConsentPhase ? (
        <IntakeConsentForms
          forms={consentForms}
          answers={consentAnswers}
          onChange={setConsentAnswer}
          errors={consentErrors}
        />
      ) : (
        <div className="flex flex-col gap-5">
          {visibleQuestions.map((q) => (
            <IntakeQuestionField
              key={q.key}
              q={q}
              value={responses[q.key]}
              notesValue={responses[`${q.key}_notes`]}
              onChange={(v) => setValue(q.key, v)}
              onNotesChange={(v) => setValue(`${q.key}_notes`, v)}
              error={errors[q.key]}
            />
          ))}
        </div>
      )}

      {savingError && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {savingError}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-3">
        <button
          type="button"
          onClick={goBack}
          disabled={step <= 1 || isPending}
          className="min-h-[44px] rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={isPending}
          className="min-h-[44px] rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
        >
          {isPending
            ? "Saving..."
            : step === lastPhase
              ? "Submit intake"
              : "Continue"}
        </button>
      </div>
    </div>
  );
}

function StepIndicator({
  currentStep,
  showConsent,
}: {
  currentStep: number;
  showConsent: boolean;
}) {
  // The consent phase gets a column only when the studio actually has live
  // forms, so a studio with none sees the unchanged five-column indicator.
  const columns: Array<{ id: number; shortLabel: string }> = [
    ...INTAKE_STEPS.map((s) => ({ id: s.id, shortLabel: s.shortLabel })),
    ...(showConsent
      ? [{ id: CONSENT_PHASE, shortLabel: "Consent" }]
      : []),
  ];
  return (
    <ol
      className="grid gap-2"
      style={{
        gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`,
      }}
      aria-label="Intake progress"
    >
      {columns.map((s) => {
        const done = s.id < currentStep;
        const active = s.id === currentStep;
        return (
          <li key={s.id} className="flex flex-col items-center gap-1.5">
            <div
              className={`h-1.5 w-full rounded-full ${
                done || active ? "bg-neutral-900" : "bg-neutral-200"
              }`}
              aria-hidden
            />
            <span
              className={`text-[11px] tracking-wide ${
                active ? "font-medium text-neutral-900" : "text-neutral-500"
              }`}
            >
              {s.shortLabel}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
