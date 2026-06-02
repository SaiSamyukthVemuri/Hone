"use client";

import { useState, useTransition } from "react";
import { submitDemoRequest, type DemoPayload } from "@/app/actions/demo";

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

  function update<K extends keyof DemoPayload>(key: K, value: DemoPayload[K]) {
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
      setStatus({ kind: "fading" });
      window.setTimeout(() => setStatus({ kind: "done" }), 220);
    });
  }

  if (status.kind === "done") {
    return (
      <p className="text-[18px] leading-[1.55] text-[#0A0A0A] md:text-[21px]">
        Thanks. We will be in touch within one business day to book your
        walkthrough.
      </p>
    );
  }

  const fading = status.kind === "fading";
  const submitting = status.kind === "submitting";

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        opacity: fading ? 0 : 1,
        transition: "opacity 200ms ease-out",
      }}
      noValidate
      className="flex flex-col gap-10"
    >
      <UnderlineField
        label="Your name"
        autoComplete="name"
        value={values.name}
        onChange={(v) => update("name", v)}
      />
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
        onChange={(v) =>
          update("practitioner_count", v as DemoPayload["practitioner_count"])
        }
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

      <div className="flex items-baseline gap-6">
        <button
          type="submit"
          disabled={submitting || fading}
          className="text-[14px] font-medium uppercase text-[#0A0A0A] transition-opacity hover:opacity-60 disabled:opacity-40"
          style={{ letterSpacing: "0.2em" }}
        >
          {submitting ? "Sending" : "Book the walkthrough"}
        </button>
        {status.kind === "error" && (
          <p className="text-[13px] text-[#6B6B6B]">{status.message}</p>
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
    <label className="flex flex-col gap-3">
      <span
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
      >
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        className="bg-transparent pb-3 text-[18px] leading-none text-[#0A0A0A] outline-none placeholder:text-[#6B6B6B]"
        style={{ borderBottom: "1px solid #0A0A0A" }}
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
    <label className="flex flex-col gap-3">
      <span
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
      >
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="resize-none bg-transparent pb-3 text-[18px] leading-[1.45] text-[#0A0A0A] outline-none placeholder:text-[#6B6B6B]"
        style={{ borderBottom: "1px solid #0A0A0A" }}
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
    <fieldset className="flex flex-col gap-3">
      <legend
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
      >
        {label}
      </legend>
      <div className="flex flex-wrap gap-x-8 gap-y-3 pt-1">
        {options.map((opt) => {
          const selected = value === opt.value;
          const id = `${name}-${opt.value}`;
          return (
            <label
              key={opt.value}
              htmlFor={id}
              className="flex cursor-pointer items-center gap-3 text-[16px]"
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
                  border: "1px solid #0A0A0A",
                  backgroundColor: selected ? "#0A0A0A" : "transparent",
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
