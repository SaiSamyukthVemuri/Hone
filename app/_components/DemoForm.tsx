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

export function DemoForm() {
  const [values, setValues] = useState<DemoPayload>(EMPTY);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [, startTransition] = useTransition();
  // Fire "form started" at most once, on first interaction. Event NAME only —
  // never any field value (no name/email/studio/free text sent to analytics).
  const startedRef = useRef(false);

  function update<K extends keyof DemoPayload>(key: K, value: DemoPayload[K]) {
    if (!startedRef.current) {
      startedRef.current = true;
      track(ANALYTICS_EVENTS.walkthroughFormStarted);
    }
    setValues((v) => ({ ...v, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "submitting" || status.kind === "fading") return;

    setStatus({ kind: "submitting" });
    startTransition(async () => {
      const result = await submitDemoRequest(values);
      if (!result.ok) {
        setStatus({ kind: "error", message: result.error });
        return;
      }
      // Success — event name only, no submitted values.
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
          There is no automatic booking — a real person will email you to find a time that
          works. You can reply to that email with anything else we should know.
        </p>
      </div>
    );
  }

  const fading = status.kind === "fading";
  const submitting = status.kind === "submitting";

  return (
    <form
      onSubmit={handleSubmit}
      style={{ opacity: fading ? 0 : 1, transition: "opacity 200ms ease-out" }}
      noValidate
      className="flex flex-col gap-7"
    >
      <UnderlineField label="Your name" autoComplete="name" value={values.name} onChange={(v) => update("name", v)} />
      <UnderlineField
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={values.email}
        onChange={(v) => update("email", v)}
      />
      <UnderlineField
        label="Studio or practice name"
        value={values.practice_name}
        onChange={(v) => update("practice_name", v)}
      />
      <UnderlineField
        label="Where you practice"
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

      <UnderlineField
        label="How you chart today"
        placeholder="Paper, Fresha notes, Google Sheets, another tool"
        value={values.current_tool}
        onChange={(v) => update("current_tool", v)}
      />
      <UnderlineTextarea
        label="Anything we should know before the walkthrough?"
        value={values.notes}
        onChange={(v) => update("notes", v)}
      />

      <div className="mt-1 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={submitting || fading}
          className="inline-flex min-h-[44px] items-center justify-center rounded-[8px] bg-mineral px-5 text-[0.9375rem] font-semibold text-paper transition-colors hover:bg-[color:var(--color-mineral-deep)] disabled:opacity-50"
        >
          {submitting ? WALKTHROUGH.submitPendingLabel : WALKTHROUGH.submitLabel}
        </button>
        {status.kind === "error" && (
          <p role="alert" className="text-[0.8125rem] text-muted">
            {status.message}
          </p>
        )}
      </div>
    </form>
  );
}

function UnderlineField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "tel" | "email" | "numeric";
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[0.75rem] font-semibold uppercase tracking-[0.12em] text-muted">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        className="bg-transparent pb-2 text-[1rem] leading-none text-ink outline-none placeholder:text-muted focus:border-[color:var(--color-mineral)]"
        style={{ borderBottom: "1px solid var(--color-hairline-strong)" }}
      />
    </label>
  );
}

function UnderlineTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[0.75rem] font-semibold uppercase tracking-[0.12em] text-muted">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="resize-none bg-transparent pb-2 text-[1rem] leading-[1.45] text-ink outline-none placeholder:text-muted focus:border-[color:var(--color-mineral)]"
        style={{ borderBottom: "1px solid var(--color-hairline-strong)" }}
      />
    </label>
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
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-[0.75rem] font-semibold uppercase tracking-[0.12em] text-muted">
        {label}
      </legend>
      <div className="flex flex-wrap gap-x-6 gap-y-3 pt-1">
        {options.map((opt) => {
          const selected = value === opt.value;
          const id = `${name}-${opt.value}`;
          return (
            <label
              key={opt.value}
              htmlFor={id}
              className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[0.9375rem] text-ink"
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
