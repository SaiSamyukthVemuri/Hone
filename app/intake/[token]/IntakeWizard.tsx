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
  buildElectrolysisAcknowledgementClaim,
  ELECTROLYSIS_ACKNOWLEDGEMENT,
} from "@/lib/intake/acknowledgements";
import { IntakeQuestionField } from "@/components/intake/intake-question-field";
import { saveIntakeStepAction, submitIntakeAction } from "./actions";

type Responses = Record<string, unknown>;

// Attach the versioned electrolysis acknowledgement claim — what this
// browser asserts it rendered — alongside the plain checkbox answer.
//
// Attached ONLY once the client has actually touched the checkbox. Before
// that the key is absent, so a draft abandoned on step 1 carries no
// acknowledgement record at all and the practitioner review surface can
// truthfully say "not yet reached" rather than "not acknowledged".
//
// Sent on every save AND on submit, so unticking the box overwrites the
// stored record instead of leaving a stale acceptance behind (the server
// merge is a spread and would otherwise preserve it).
//
// The server re-derives everything it stores from its own copy of the
// constant and validates this claim by exact equality; nothing here is
// trusted, and this is never the only enforcement.
function withAcknowledgementClaim(responses: Responses): Responses {
  const answer = responses[ELECTROLYSIS_ACKNOWLEDGEMENT.questionKey];
  if (answer === undefined) return responses;
  return {
    ...responses,
    [ELECTROLYSIS_ACKNOWLEDGEMENT.id]:
      buildElectrolysisAcknowledgementClaim(answer === true),
  };
}

type Props = {
  token: string;
  studioName: string;
  initialStep: number;
  initialResponses: Responses;
  alreadySubmitted: boolean;
};

export function IntakeWizard({
  token,
  studioName,
  initialStep,
  initialResponses,
  alreadySubmitted,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState(
    Math.min(Math.max(initialStep, 1), TOTAL_STEPS),
  );
  const [responses, setResponses] = useState<Responses>(initialResponses);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingError, setSavingError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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
  if (!current) return null;

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
        step: nextStep,
        responses: withAcknowledgementClaim(responses),
      });
      if (!res.ok) setSavingError(res.error);
    });
  }

  function goNext() {
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

    if (step < TOTAL_STEPS) {
      const nextStep = step + 1;
      startTransition(async () => {
        const res = await saveIntakeStepAction({
          token,
          step: nextStep,
          responses: withAcknowledgementClaim(responses),
        });
        if (!res.ok) {
          setSavingError(res.error);
          return;
        }
        setStep(nextStep);
      });
      return;
    }

    // Final submit
    startTransition(async () => {
      const res = await submitIntakeAction({
        token,
        responses: withAcknowledgementClaim(responses),
      });
      if (!res.ok) {
        setSavingError(res.error);
        return;
      }
      router.push("/intake/thank-you");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator currentStep={step} />

      <div>
        <h2 className="text-[24px] font-semibold leading-tight tracking-tight">
          {current.title}
        </h2>
        {current.description && (
          <p className="mt-2 text-sm text-neutral-600">{current.description}</p>
        )}
      </div>

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
            : step === TOTAL_STEPS
              ? "Submit intake"
              : "Continue"}
        </button>
      </div>
    </div>
  );
}

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <ol className="grid grid-cols-5 gap-2" aria-label="Intake progress">
      {INTAKE_STEPS.map((s) => {
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
