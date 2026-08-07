"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  isClientOwnedResponseKey,
  PRACTITIONER_ENTERABLE_STEPS,
  stepById,
  validateVisibleAnswers,
  visibleQuestionsForStep,
} from "@/lib/intake/questions";
import { IntakeQuestionField } from "@/components/intake/intake-question-field";
import {
  handOffAssistedIntakeAction,
  saveAssistedIntakeStepAction,
} from "../actions";

type Responses = Record<string, unknown>;

type Props = {
  clientId: string;
  clientName: string;
  intakeId: string;
  initialStep: number;
  initialResponses: Responses;
  initialUpdatedAt: string;
};

const STEP_IDS = PRACTITIONER_ENTERABLE_STEPS.map((s) => s.id);

// Drop every key the client alone may author before sending. Defence in
// depth, not the control: lib/intake/responses.ts strips them server-side and
// the action refuses any that would change a stored client answer.
function withoutClientOwnedKeys(responses: Responses): Responses {
  const out: Responses = {};
  for (const [key, value] of Object.entries(responses)) {
    if (!isClientOwnedResponseKey(key)) out[key] = value;
  }
  return out;
}
const LAST_STEP_ID = STEP_IDS[STEP_IDS.length - 1] ?? 1;

export function AssistedIntakeEditor({
  clientId,
  clientName,
  intakeId,
  initialStep,
  initialResponses,
  initialUpdatedAt,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState(initialStep);
  const [responses, setResponses] = useState<Responses>(initialResponses);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Optimistic-concurrency token. Refreshed from every successful save so a
  // long assisted session keeps working, and used to refuse a save that would
  // clobber a write made through the client's own link in the meantime.
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [atHandoff, setAtHandoff] = useState(false);
  const [isPending, startTransition] = useTransition();

  const current = stepById(step);

  // Same conditional-visibility authority the client's wizard uses. Not a
  // copy of it — the same exported function.
  const visibleQuestions = useMemo(
    () => visibleQuestionsForStep(step, responses),
    [step, responses],
  );

  if (!current) return null;

  function setValue(key: string, value: unknown) {
    setSavedAt(null);
    setResponses((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // One save path for every button, so "Continue", "Save" and "Back" cannot
  // drift in what they persist.
  function persist(
    targetStep: number,
    onDone?: () => void,
  ): void {
    setActionError(null);
    startTransition(async () => {
      const res = await saveAssistedIntakeStepAction({
        intakeId,
        clientId,
        step: targetStep,
        // Do not post what this surface may not write. The editor's state is
        // seeded from the stored responses, which can already contain the
        // client's own step-5 answers if they used their link first; sending
        // them back is pointless and makes the server work harder to prove
        // they are unchanged. The server remains the authority — it strips
        // these keys and refuses any that would CHANGE a client answer.
        responses: withoutClientOwnedKeys(responses),
        expectedUpdatedAt: updatedAt,
      });
      if (!res.ok) {
        setActionError(res.error);
        return;
      }
      setUpdatedAt(res.updatedAt);
      setSavedAt(new Date().toISOString());
      onDone?.();
    });
  }

  function goBack() {
    const idx = STEP_IDS.indexOf(step);
    if (idx <= 0) return;
    const target = STEP_IDS[idx - 1];
    persist(target, () => setStep(target));
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
    const idx = STEP_IDS.indexOf(step);
    if (idx < STEP_IDS.length - 1) {
      const target = STEP_IDS[idx + 1];
      persist(target, () => setStep(target));
      return;
    }
    // Last practitioner-enterable step cleared: everything a practitioner may
    // record is recorded. What remains is the client's own.
    persist(step, () => setAtHandoff(true));
  }

  function handOff() {
    setActionError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("intake_id", intakeId);
      fd.set("client_id", clientId);
      const res = await handOffAssistedIntakeAction(fd);
      if (!res.ok) {
        setActionError(res.error);
        return;
      }
      // Navigate this device to the client's own intake link. From here on the
      // existing public wizard is in charge: it renders the acknowledgements
      // unticked and performs the submission.
      window.location.href = res.intakeUrl;
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <AssistedBanner clientName={clientName} />

      {atHandoff ? (
        <HandoffPanel
          clientName={clientName}
          onHandOff={handOff}
          onBack={() => setAtHandoff(false)}
          isPending={isPending}
          error={actionError}
        />
      ) : (
        <>
          <AssistedStepIndicator currentStep={step} />

          <div>
            <h2 className="text-[22px] font-semibold leading-tight tracking-tight">
              {current.title}
            </h2>
            {current.description && (
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                {current.description}
              </p>
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

          {actionError && (
            <p
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-100"
            >
              {actionError}
            </p>
          )}

          {savedAt && !actionError && (
            <p className="text-xs text-neutral-500" role="status">
              Answers saved.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={goBack}
              // Distinct accessible name: an intake OPTION is also labelled
              // "Back" (the body-area question), so a bare "Back" is
              // ambiguous for assistive tech on that step.
              aria-label="Back to previous step"
              disabled={STEP_IDS.indexOf(step) <= 0 || isPending}
              className="min-h-[44px] rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            >
              Back
            </button>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  persist(step, () => router.push(`/clients/${clientId}/intake`))
                }
                disabled={isPending}
                className="min-h-[44px] rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
              >
                Save and leave
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={isPending}
                className="min-h-[44px] rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
              >
                {isPending
                  ? "Saving..."
                  : step === LAST_STEP_ID
                    ? "Save and continue"
                    : "Continue"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Persistent, unmissable, and carefully worded. It states what is happening —
// the practitioner is recording answers the client is giving — and who
// finishes. It never says "acting as", "on behalf of", "signing for" or
// "submitting for": none of those would be true.
function AssistedBanner({ clientName }: { clientName: string }) {
  return (
    <div
      className="rounded-md border border-blue-300 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100"
      role="note"
    >
      <p className="text-xs font-semibold uppercase tracking-wider">
        Completing with client
      </p>
      <p className="mt-1 leading-relaxed">
        You&rsquo;re recording {clientName}&rsquo;s answers while they are with
        you. {clientName} will complete their acknowledgements and submit at the
        end.
      </p>
    </div>
  );
}

function AssistedStepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <ol
      className="grid gap-2"
      style={{
        gridTemplateColumns: `repeat(${STEP_IDS.length + 1}, minmax(0, 1fr))`,
      }}
      aria-label="Assisted intake progress"
    >
      {PRACTITIONER_ENTERABLE_STEPS.map((s) => {
        const done = s.id < currentStep;
        const active = s.id === currentStep;
        return (
          <li key={s.id} className="flex flex-col items-center gap-1.5">
            <div
              className={`h-1.5 w-full rounded-full ${
                done || active
                  ? "bg-neutral-900 dark:bg-neutral-100"
                  : "bg-neutral-200 dark:bg-neutral-800"
              }`}
              aria-hidden
            />
            <span
              className={`text-center text-[11px] leading-tight tracking-wide ${
                active
                  ? "font-medium text-neutral-900 dark:text-neutral-100"
                  : "text-neutral-500"
              }`}
            >
              {s.shortLabel}
            </span>
          </li>
        );
      })}
      {/* The client's step is shown so the practitioner can see where this
          ends, and is never reachable from here. */}
      <li className="flex flex-col items-center gap-1.5">
        <div
          className="h-1.5 w-full rounded-full bg-neutral-200 dark:bg-neutral-800"
          aria-hidden
        />
        <span className="text-center text-[11px] leading-tight tracking-wide text-neutral-500">
          Client
        </span>
      </li>
    </ol>
  );
}

function HandoffPanel({
  clientName,
  onHandOff,
  onBack,
  isPending,
  error,
}: {
  clientName: string;
  onHandOff: () => void;
  onBack: () => void;
  isPending: boolean;
  error: string | null;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-300 p-5 dark:border-neutral-700">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold tracking-tight">
          Client confirmation required
        </h2>
        <p className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
          The questionnaire is recorded. The final step is {clientName}&rsquo;s
          own — a short set of confirmations they read and tick themselves,
          followed by submitting the intake. You cannot complete that part for
          them.
        </p>
        <p className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
          Hand your device to {clientName}, or send them their link to finish on
          their own phone.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-100"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onHandOff}
          disabled={isPending}
          className="min-h-[44px] rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {isPending ? "Opening..." : "Hand to client"}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={isPending}
          className="min-h-[44px] rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
        >
          Back to answers
        </button>
      </div>
    </section>
  );
}
