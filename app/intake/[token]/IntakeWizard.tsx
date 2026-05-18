"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  INTAKE_STEPS,
  TOTAL_STEPS,
  stepById,
  type Question,
  type Step,
} from "@/lib/intake/questions";
import { saveIntakeStepAction, submitIntakeAction } from "./actions";

type Responses = Record<string, unknown>;

type Props = {
  token: string;
  studioName: string;
  initialStep: number;
  initialResponses: Responses;
  alreadySubmitted: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const visibleQuestions = useMemo(() => {
    if (!current) return [];
    return current.questions.filter((q) => isVisible(q, responses));
  }, [current, responses]);

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

  function validateStep(): Record<string, string> {
    const stepErrors: Record<string, string> = {};
    for (const q of visibleQuestions) {
      if (!q.required) continue;
      const v = responses[q.key];
      if (q.type === "multi_select") {
        if (!Array.isArray(v) || v.length === 0) {
          stepErrors[q.key] = "Please answer this question to continue.";
        }
        continue;
      }
      if (q.type === "checkbox") {
        if (v !== true) {
          stepErrors[q.key] = "Please confirm to continue.";
        }
        continue;
      }
      if (typeof v !== "string" || v.trim() === "") {
        stepErrors[q.key] = "Please answer this question to continue.";
        continue;
      }
      if (q.key === "email" && !EMAIL_RE.test(v.trim())) {
        stepErrors[q.key] = "Enter a valid email address.";
      }
      if (q.type === "date") {
        const d = new Date(v);
        const year = d.getUTCFullYear();
        if (Number.isNaN(d.getTime()) || year < 1900 || d.getTime() > Date.now()) {
          stepErrors[q.key] = "Enter a valid date of birth.";
        }
      }
    }
    return stepErrors;
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
        responses,
      });
      if (!res.ok) setSavingError(res.error);
    });
  }

  function goNext() {
    const stepErrors = validateStep();
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
          responses,
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
      const res = await submitIntakeAction({ token, responses });
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
          <QuestionField
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

function isVisible(q: Question, responses: Responses): boolean {
  if (!q.conditional) return true;
  const parent = responses[q.conditional.whenKey];
  const allowed = q.conditional.whenEquals;
  if (typeof parent === "string") return allowed.includes(parent);
  if (Array.isArray(parent)) {
    return parent.some((v) => typeof v === "string" && allowed.includes(v));
  }
  return false;
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

type FieldProps = {
  q: Question;
  value: unknown;
  notesValue: unknown;
  onChange: (v: unknown) => void;
  onNotesChange: (v: unknown) => void;
  error?: string;
};

function QuestionField({ q, value, notesValue, onChange, onNotesChange, error }: FieldProps) {
  const showTopLabel = q.type !== "checkbox";
  return (
    <div className="flex flex-col gap-2">
      {showTopLabel && (
        <div className="flex flex-col gap-0.5">
          <label
            htmlFor={q.key}
            className="text-sm font-medium text-neutral-800"
          >
            {q.label}
            {q.required && <span className="ml-1 text-red-600">*</span>}
          </label>
          {q.helpText && (
            <span className="text-xs text-neutral-500">{q.helpText}</span>
          )}
        </div>
      )}

      {renderControl(q, value, onChange)}

      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}

      {q.followUpNotesPrompt && shouldShowFollowUp(q, value) && (
        <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3">
          <label
            htmlFor={`${q.key}_notes`}
            className="text-xs font-medium text-neutral-700"
          >
            {q.followUpNotesPrompt}
          </label>
          <textarea
            id={`${q.key}_notes`}
            value={typeof notesValue === "string" ? notesValue : ""}
            onChange={(e) => onNotesChange(e.target.value)}
            rows={3}
            className="w-full min-h-[44px] rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm leading-relaxed focus:border-neutral-900 focus:outline-none"
          />
        </div>
      )}
    </div>
  );
}

function shouldShowFollowUp(q: Question, value: unknown): boolean {
  if (q.type === "yes_no") return value === "yes";
  return false;
}

function renderControl(
  q: Question,
  value: unknown,
  onChange: (v: unknown) => void,
): React.ReactNode {
  const baseInputClass =
    "w-full min-h-[44px] rounded-md border border-neutral-300 bg-white px-3 py-2 text-base leading-normal focus:border-neutral-900 focus:outline-none";

  if (q.type === "short_text") {
    return (
      <input
        id={q.key}
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className={baseInputClass}
        inputMode={q.key === "phone" || q.key === "emergency_contact_phone" ? "tel" : undefined}
        autoComplete={
          q.key === "email"
            ? "email"
            : q.key === "phone"
              ? "tel"
              : q.key === "legal_name"
                ? "name"
                : undefined
        }
      />
    );
  }
  if (q.type === "long_text") {
    return (
      <textarea
        id={q.key}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className={`${baseInputClass} leading-relaxed`}
      />
    );
  }
  if (q.type === "date") {
    return (
      <input
        id={q.key}
        type="date"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className={baseInputClass}
      />
    );
  }
  if (q.type === "yes_no") {
    const sel = value;
    return (
      <div className="flex gap-2">
        {[
          { v: "yes", label: "Yes" },
          { v: "no", label: "No" },
        ].map((opt) => (
          <button
            key={opt.v}
            type="button"
            onClick={() => onChange(opt.v)}
            className={`min-h-[44px] flex-1 rounded-md border px-4 py-2 text-sm font-medium ${
              sel === opt.v
                ? "border-neutral-900 bg-neutral-900 text-white"
                : "border-neutral-300 bg-white text-neutral-700"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    );
  }
  if (q.type === "single_select") {
    return (
      <div className="flex flex-col gap-2">
        {(q.options ?? []).map((opt) => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`min-h-[44px] rounded-md border px-4 py-3 text-left text-sm ${
                selected
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 bg-white text-neutral-700"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }
  if (q.type === "multi_select") {
    const selected = new Set(
      Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string") : [],
    );
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(q.options ?? []).map((opt) => {
          const isSel = selected.has(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                const next = new Set(selected);
                if (isSel) next.delete(opt.value);
                else next.add(opt.value);
                onChange(Array.from(next));
              }}
              className={`min-h-[44px] rounded-md border px-4 py-3 text-left text-sm ${
                isSel
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 bg-white text-neutral-700"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }
  if (q.type === "checkbox") {
    const checked = value === true;
    return (
      <label className="flex items-start gap-3 rounded-md border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-5 w-5 rounded border-neutral-400"
        />
        <span>{q.label}</span>
      </label>
    );
  }
  return null;
}
