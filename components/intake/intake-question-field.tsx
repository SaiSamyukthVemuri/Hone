"use client";

// The ONE renderer for an intake question control.
//
// Previously this lived privately inside app/intake/[token]/IntakeWizard.tsx.
// It moved here when the practitioner-assisted editor was added so the two
// surfaces render identical controls — same field types, same option order,
// same "none of the above" exclusivity, same required marker, same follow-up
// notes rule — rather than becoming a fourth independent transcription of
// INTAKE_STEPS (the repo already carries the read-only settings preview and
// the practitioner review grid).
//
// This move is deliberately behaviour-preserving: every branch below is
// transcribed verbatim from the wizard as it shipped in PR #518. In
// particular `const checked = value === true;` is load-bearing — nothing here
// may ever default a checkbox to checked, because the acknowledgement
// checkboxes are client-owned first-person statements. The guard that pins
// that now points at this file (see
// tests/app/intake/electrolysis-acknowledgement-wiring.test.ts §14).

import { NONE_VALUE, type Question } from "@/lib/intake/questions";

type FieldProps = {
  q: Question;
  value: unknown;
  notesValue: unknown;
  onChange: (v: unknown) => void;
  onNotesChange: (v: unknown) => void;
  error?: string;
};

export function IntakeQuestionField({
  q,
  value,
  notesValue,
  onChange,
  onNotesChange,
  error,
}: FieldProps) {
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

      {renderControl(q, value, onChange, error)}

      {error && (
        <p id={`${q.key}_error`} className="text-xs text-red-700" role="alert">
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

export function shouldShowFollowUp(q: Question, value: unknown): boolean {
  if (q.type === "yes_no") return value === "yes";
  return false;
}

function renderControl(
  q: Question,
  value: unknown,
  onChange: (v: unknown) => void,
  error?: string,
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
          const isNone = opt.value === NONE_VALUE;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                // "None of the above" is exclusive: selecting it clears any
                // other choices; selecting any other option clears it.
                if (isNone) {
                  onChange(isSel ? [] : [NONE_VALUE]);
                  return;
                }
                const next = new Set(selected);
                next.delete(NONE_VALUE);
                if (isSel) next.delete(opt.value);
                else next.add(opt.value);
                onChange(Array.from(next));
              }}
              className={`min-h-[44px] rounded-md border px-4 py-3 text-left text-sm ${
                isSel
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 bg-white text-neutral-700"
              } ${isNone ? "sm:col-span-2" : ""}`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }
  if (q.type === "checkbox") {
    // Unchecked unless the stored answer is exactly `true`. Nothing here
    // defaults a checkbox to checked, and no code path ticks it on the
    // client's behalf — opening the step or continuing past an earlier one
    // never marks an acknowledgement accepted. The practitioner-assisted
    // editor never renders this step at all; the server additionally strips
    // every client-owned key from an assisted save.
    const checked = value === true;
    // A checkbox is the one control type this component renders without the
    // top label block, so before this it was the only one with no `id`, no
    // required marker and no help text at all — required-ness was
    // discoverable only by pressing Continue and failing. The wrapping
    // <label> already names the input; what was missing is the required
    // signal, the help text, and a programmatic tie to the error.
    const helpId = q.helpText ? `${q.key}_help` : undefined;
    const errorId = error ? `${q.key}_error` : undefined;
    const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
    return (
      <div className="flex flex-col gap-1.5">
        <label className="flex items-start gap-3 rounded-md border border-neutral-300 bg-white px-3 py-3 text-sm leading-relaxed text-neutral-700">
          <input
            id={q.key}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            aria-required={q.required || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className="mt-0.5 h-5 w-5 flex-none rounded border-neutral-400"
          />
          <span>
            {q.label}
            {q.required && <span className="ml-1 text-red-600">*</span>}
          </span>
        </label>
        {q.helpText && (
          <span id={helpId} className="text-xs text-neutral-500">
            {q.helpText}
          </span>
        )}
      </div>
    );
  }
  return null;
}
