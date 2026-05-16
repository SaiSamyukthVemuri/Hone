"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { FITZPATRICK_TYPES } from "@/lib/constants";

export type ClientFormValues = {
  name: string;
  pronouns: string;
  date_of_birth: string;
  phone: string;
  email: string;
  fitzpatrick_type: string;
  skin_notes: string;
  allergies: string;
};

export const EMPTY_CLIENT_FORM: ClientFormValues = {
  name: "",
  pronouns: "",
  date_of_birth: "",
  phone: "",
  email: "",
  fitzpatrick_type: "",
  skin_notes: "",
  allergies: "",
};

type Props = {
  initialValues?: ClientFormValues;
  submitLabel: string;
  pendingLabel: string;
  cancelHref: string;
  hiddenFields?: Record<string, string>;
  action: (formData: FormData) => Promise<void>;
};

// Blocks the browser's implicit submit-on-Enter for single-line text inputs;
// textareas keep normal Enter (newline) behavior.
function blockEnterSubmit(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") {
    e.preventDefault();
    const form = e.currentTarget.form;
    if (!form) return;
    const elements = Array.from(
      form.querySelectorAll<HTMLElement>(
        "input:not([type=hidden]), select, textarea, button",
      ),
    ).filter((el) => !(el as HTMLInputElement).disabled);
    const idx = elements.indexOf(e.currentTarget);
    const next = elements[idx + 1];
    if (next) next.focus();
  }
}

export function ClientForm({
  initialValues = EMPTY_CLIENT_FORM,
  submitLabel,
  pendingLabel,
  cancelHref,
  hiddenFields,
  action,
}: Props) {
  const [values, setValues] = useState<ClientFormValues>(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof ClientFormValues>(
    key: K,
    value: ClientFormValues[K],
  ) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!values.name.trim()) {
      setError("Name is required.");
      return;
    }
    const fd = new FormData();
    for (const [k, v] of Object.entries(values)) {
      fd.set(k, v);
    }
    if (hiddenFields) {
      for (const [k, v] of Object.entries(hiddenFields)) {
        fd.set(k, v);
      }
    }
    startTransition(async () => {
      try {
        await action(fd);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save client.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <Field
        label="Name"
        required
        autoFocus
        value={values.name}
        onChange={(v) => update("name", v)}
        onKeyDown={blockEnterSubmit}
      />

      <div className="grid gap-5 md:grid-cols-2">
        <Field
          label="Pronouns"
          placeholder="she/her, he/him, they/them, etc."
          value={values.pronouns}
          onChange={(v) => update("pronouns", v)}
          onKeyDown={blockEnterSubmit}
        />
        <Field
          label="Date of birth"
          type="date"
          value={values.date_of_birth}
          onChange={(v) => update("date_of_birth", v)}
          onKeyDown={blockEnterSubmit}
        />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <Field
          label="Phone"
          type="tel"
          inputMode="tel"
          value={values.phone}
          onChange={(v) => update("phone", v)}
          onKeyDown={blockEnterSubmit}
        />
        <Field
          label="Email"
          type="email"
          value={values.email}
          onChange={(v) => update("email", v)}
          onKeyDown={blockEnterSubmit}
        />
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Fitzpatrick type</span>
        <select
          value={values.fitzpatrick_type}
          onChange={(e) => update("fitzpatrick_type", e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        >
          <option value="">Select…</option>
          {FITZPATRICK_TYPES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Skin notes</span>
        <textarea
          value={values.skin_notes}
          onChange={(e) => update("skin_notes", e.target.value)}
          rows={4}
          placeholder="Sensitivities, conditions, scarring tendencies…"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Allergies</span>
        <textarea
          value={values.allergies}
          onChange={(e) => update("allergies", e.target.value)}
          rows={3}
          placeholder="Latex, fragrances, any product reactions…"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? pendingLabel : submitLabel}
        </button>
        <Link
          href={cancelHref}
          className="rounded-md border border-neutral-300 px-5 py-3 text-base hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function Field({
  label,
  type = "text",
  required = false,
  placeholder,
  autoFocus = false,
  inputMode,
  value,
  onChange,
  onKeyDown,
}: {
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  inputMode?: "tel" | "email" | "text" | "numeric";
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </span>
      <input
        type={type}
        required={required}
        placeholder={placeholder}
        autoFocus={autoFocus}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
      />
    </label>
  );
}
