"use client";

import { useRef, useState, useTransition } from "react";
import { track } from "@vercel/analytics";
import { submitDemoRequest, type DemoPayload } from "@/app/actions/demo";
import { WALKTHROUGH, ANALYTICS_EVENTS } from "@/lib/marketing/content";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "fading" }
  | { kind: "done" };

const EMPTY: DemoPayload = {
  name: "",
  email: "",
  practice_name: "",
  location: "",
  practice_type: "",
  practitioner_count: "",
  current_tool: "",
  notes: "",
};

const PRACTICE_OPTIONS: ReadonlyArray<{
  value: "electrolysis" | "laser" | "both";
  label: string;
}> = [
  { value: "electrolysis", label: "Electrolysis only" },
  { value: "laser", label: "Laser only" },
  { value: "both", label: "Both" },
];

const COUNT_OPTIONS: ReadonlyArray<{
  value: "1" | "2-5" | "5+";
  label: string;
}> = [
  { value: "1", label: "1" },
  { value: "2-5", label: "2 to 5" },
  { value: "5+", label: "More than 5" },
];

// The same two checks app/actions/demo.ts makes, run first in the browser so a
// missing name or a mistyped email is named beside its own field, with focus
// on it, instead of as one line under the button after a round trip. The
// server action still runs both and stays the authority.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type FieldErrors = Partial<Record<"name" | "email", string>>;

function checkFields(values: DemoPayload): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.name.trim()) errors.name = "Enter your name.";
  if (!EMAIL_RE.test(values.email.trim())) errors.email = "Enter an email address we can reply to.";
  return errors;
}

export function DemoForm() {
  const [values, setValues] = useState<DemoPayload>(EMPTY);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [, startTransition] = useTransition();
  // Fire "form started" at most once, on first interaction. Event NAME only,
  // never any field value (no name/email/studio/free text sent to analytics).
  const startedRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  function update<K extends keyof DemoPayload>(key: K, value: DemoPayload[K]) {
    if (!startedRef.current) {
      startedRef.current = true;
      track(ANALYTICS_EVENTS.walkthroughFormStarted);
    }
    setValues((v) => ({ ...v, [key]: value }));
    // A field stops being marked wrong as soon as it is being corrected.
    if (key === "name" || key === "email") {
      const field: keyof FieldErrors = key;
      setFieldErrors((errs) => (errs[field] ? { ...errs, [field]: undefined } : errs));
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "submitting" || status.kind === "fading") return;

    const errors = checkFields(values);
    setFieldErrors(errors);
    const firstInvalid = (["name", "email"] as const).find((k) => errors[k]);
    if (firstInvalid) {
      setStatus({ kind: "idle" });
      formRef.current?.querySelector<HTMLInputElement>(`[name="${firstInvalid}"]`)?.focus();
      return;
    }

    setStatus({ kind: "submitting" });
    startTransition(async () => {
      const result = await submitDemoRequest(values);
      if (!result.ok) {
        setStatus({ kind: "error", message: result.error });
        return;
      }
      // Success, event name only, no submitted values.
      track(ANALYTICS_EVENTS.walkthroughFormSubmitted);
      setStatus({ kind: "fading" });
      window.setTimeout(() => setStatus({ kind: "done" }), 220);
    });
  }

  if (status.kind === "done") {
    return (
      <div className="text-[1.0625rem] leading-[1.6] text-ink">
        <p className="font-medium">{WALKTHROUGH.successMessage}</p>
        <p className="mt-3 text-[0.9375rem] text-muted">
          There is no automatic booking, a real person will email you to find a time that
          works. You can reply to that email with anything else we should know.
        </p>
      </div>
    );
  }

  const fading = status.kind === "fading";
  const submitting = status.kind === "submitting";

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      style={{ opacity: fading ? 0 : 1, transition: "opacity 200ms ease-out" }}
      noValidate
      className="flex flex-col gap-5"
    >
      <p className="text-[0.875rem] text-muted">
        Your name and email are required. Everything else is optional.
      </p>
      <BoxField
        label="Your name"
        name="name"
        autoComplete="name"
        required
        error={fieldErrors.name}
        value={values.name}
        onChange={(v) => update("name", v)}
      />
      <BoxField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        error={fieldErrors.email}
        value={values.email}
        onChange={(v) => update("email", v)}
      />
      <BoxField
        label="Studio or practice name"
        name="practice_name"
        value={values.practice_name}
        onChange={(v) => update("practice_name", v)}
      />
      <BoxField
        label="Where you practice"
        name="location"
        placeholder="City, country"
        value={values.location}
        onChange={(v) => update("location", v)}
      />

      <RadioGroup
        label="What you offer"
        name="practice_type"
        value={values.practice_type}
        onChange={(v) => update("practice_type", v as DemoPayload["practice_type"])}
        options={PRACTICE_OPTIONS}
      />
      <RadioGroup
        label="Practitioners in the studio"
        name="practitioner_count"
        value={values.practitioner_count}
        onChange={(v) => update("practitioner_count", v as DemoPayload["practitioner_count"])}
        options={COUNT_OPTIONS}
      />

      <BoxField
        label="How you chart today"
        name="current_tool"
        placeholder="Paper, Fresha notes, Google Sheets, another tool"
        value={values.current_tool}
        onChange={(v) => update("current_tool", v)}
      />
      <BoxTextarea
        label="Anything we should know before the walkthrough?"
        name="notes"
        value={values.notes}
        onChange={(v) => update("notes", v)}
      />

      {/* A refusal from the server (the rate limit, or a failed save) is
          announced and stated in full, above the button it is about. */}
      {status.kind === "error" && (
        <p
          role="alert"
          className="rounded-[8px] border border-[color:var(--color-hairline-strong)] bg-warm px-3.5 py-3 text-[0.9375rem] font-medium leading-[1.5] text-ink"
        >
          {status.message}
        </p>
      )}

      <div className="mt-1">
        <button
          type="submit"
          disabled={submitting || fading}
          aria-busy={submitting || undefined}
          className="inline-flex min-h-11 w-full items-center justify-center rounded-[8px] bg-mineral px-5 text-[0.9375rem] font-semibold text-paper transition-colors duration-[var(--hone-duration-ui)] hover:bg-[color:var(--color-mineral-deep)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-mineral)] disabled:opacity-60 sm:w-auto"
        >
          {submitting ? WALKTHROUGH.submitPendingLabel : WALKTHROUGH.submitLabel}
        </button>
      </div>
    </form>
  );
}

// FIELDS ARE BOXES, 44px TALL, WITH A VISIBLE FOCUS (DESIGN LAWS 5 and 6). They
// were underlines whose colour was set inline — which outranks the `focus:`
// class, so a focused field looked exactly like an idle one — at 29px tall.
// The focus ring is an outline, so forced-colours mode redraws it.
const FIELD_LABEL = "text-[0.9375rem] font-medium text-ink";
const FIELD_BOX =
  "min-h-11 w-full rounded-[8px] border bg-white px-3.5 text-[1rem] text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-mineral)]";
// An error is the system's danger tone (DESIGN LAW 9: the caller says what a
// state MEANS), never the brand green, which would read as "done".
const FIELD_ERROR = "text-[0.875rem] font-medium text-[color:var(--color-danger-fg)]";

function BoxField({
  label,
  name,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
  inputMode,
  required = false,
  error,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "email" | "numeric";
  required?: boolean;
  error?: string;
}) {
  const id = `demo-${name}`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
        {required ? <span className="text-muted"> (required)</span> : null}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`${FIELD_BOX} py-2.5 ${
          error ? "border-[color:var(--color-danger-fg)]" : "border-[color:var(--color-hairline-strong)]"
        }`}
      />
      {error ? (
        <p id={errorId} className={FIELD_ERROR}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function BoxTextarea({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `demo-${name}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className={`${FIELD_BOX} resize-y py-2.5 leading-[1.5] border-[color:var(--color-hairline-strong)]`}
      />
    </div>
  );
}

function RadioGroup({
  label,
  name,
  value,
  onChange,
  options,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  // The real radio is visually hidden, so its LABEL carries the focus ring:
  // `has-[:focus-visible]` draws the outline on the label whenever the input
  // inside it holds keyboard focus. Without it, arrowing through the options
  // moved focus with nothing on screen to show where it went.
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className={FIELD_LABEL}>{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
        {options.map((opt) => {
          const selected = value === opt.value;
          const id = `${name}-${opt.value}`;
          return (
            <label
              key={opt.value}
              htmlFor={id}
              className="-mx-1.5 flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[8px] px-1.5 text-[0.9375rem] text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[color:var(--color-mineral)]"
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={opt.value}
                checked={selected}
                onChange={() => onChange(opt.value)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  border: `1px solid ${selected ? "var(--color-mineral)" : "var(--color-hairline-strong)"}`,
                  backgroundColor: selected ? "var(--color-mineral)" : "transparent",
                }}
              />
              {opt.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
