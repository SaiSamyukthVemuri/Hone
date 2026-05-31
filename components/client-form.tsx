"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  COMMON_ALLERGIES,
  COMMON_SKIN_CONDITIONS,
  FITZPATRICK_TYPES,
} from "@/lib/constants";
import { appendComment } from "@/lib/comments";

export type ClientFormValues = {
  name: string;
  pronouns: string;
  date_of_birth: string;
  phone: string;
  email: string;
  address: string;
  fitzpatrick_type: string;
  skin_notes: string;
  allergies: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
};

export const EMPTY_CLIENT_FORM: ClientFormValues = {
  name: "",
  pronouns: "",
  date_of_birth: "",
  phone: "",
  email: "",
  address: "",
  fitzpatrick_type: "",
  skin_notes: "",
  allergies: "",
  emergency_contact_name: "",
  emergency_contact_phone: "",
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
          autoCapitalize="none"
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
        <span className="text-sm font-medium">Address</span>
        <textarea
          rows={2}
          value={values.address}
          onChange={(e) => update("address", e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

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

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Skin notes</span>
        <ChipRow
          options={COMMON_SKIN_CONDITIONS}
          onAppend={(chip) =>
            update("skin_notes", appendComment(values.skin_notes, chip))
          }
        />
        <textarea
          value={values.skin_notes}
          onChange={(e) => update("skin_notes", e.target.value)}
          rows={4}
          placeholder="Tap a chip or type a note"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Allergies</span>
        <ChipRow
          options={COMMON_ALLERGIES}
          onAppend={(chip) =>
            update("allergies", appendComment(values.allergies, chip))
          }
        />
        <textarea
          value={values.allergies}
          onChange={(e) => update("allergies", e.target.value)}
          rows={3}
          placeholder="Tap a chip or type a note"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </div>

      <fieldset className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
        <legend className="px-1 text-sm font-medium">
          Emergency contact{" "}
          <span className="text-neutral-500">(optional)</span>
        </legend>
        <div className="grid gap-5 md:grid-cols-2">
          <Field
            label="Name"
            placeholder="e.g. Partner, mother, friend"
            value={values.emergency_contact_name}
            onChange={(v) => update("emergency_contact_name", v)}
            onKeyDown={blockEnterSubmit}
          />
          <Field
            label="Phone"
            type="tel"
            inputMode="tel"
            placeholder="555-555-5555"
            value={values.emergency_contact_phone}
            onChange={(v) => update("emergency_contact_phone", v)}
            onKeyDown={blockEnterSubmit}
          />
        </div>
      </fieldset>

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

function ChipRow({
  options,
  onAppend,
}: {
  options: ReadonlyArray<string>;
  onAppend: (chip: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onAppend(c)}
          className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          + {c}
        </button>
      ))}
    </div>
  );
}

function Field({
  label,
  type = "text",
  required = false,
  placeholder,
  autoFocus = false,
  inputMode,
  autoCapitalize,
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
  autoCapitalize?: "off" | "none" | "on" | "sentences" | "words" | "characters";
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
        autoCapitalize={autoCapitalize}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
      />
    </label>
  );
}
