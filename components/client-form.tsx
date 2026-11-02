"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import {
  COMMON_ALLERGIES,
  FITZPATRICK_TYPES,
} from "@/lib/constants";
import { appendComment } from "@/lib/comments";
import { buildClientFormData } from "@/lib/clients/client-form-payload";
import {
  SAVE_CONFIRM_TIMEOUT_MS,
  SAVE_UNCONFIRMED_MESSAGE,
  runClientSave,
} from "@/lib/clients/client-form-submit";
import {
  adoptCurrent,
  type ProfileBaseline,
  type ProfileConflict,
} from "@/lib/clients/profile-baseline";

export type ClientFormValues = {
  name: string;
  /** HON-58: the name the client goes by; blank means none. */
  preferred_name: string;
  pronouns: string;
  date_of_birth: string;
  phone: string;
  email: string;
  address: string;
  fitzpatrick_type: string;
  allergies: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
};

export const EMPTY_CLIENT_FORM: ClientFormValues = {
  name: "",
  preferred_name: "",
  pronouns: "",
  date_of_birth: "",
  phone: "",
  email: "",
  address: "",
  fitzpatrick_type: "",
  allergies: "",
  emergency_contact_name: "",
  emergency_contact_phone: "",
};

// The save action returns void on success (it calls redirect()) or
// { ok: false, error } when validation fails. Server actions in
// Next.js production redact thrown errors to an opaque crash; this
// return-shape lets the form render a clean error banner instead.
//
// HON-58: `possibleDuplicates` (staff create, and an edit that changes the
// name, phone or date of birth) means nothing was saved because the studio
// already has clients with the same phone, or the same name and date of
// birth. The form names EVERY one and offers to save anyway, confirming each
// listed client (Team L1).
export type ClientFormActionResult = {
  ok: false;
  error: string;
  possibleDuplicates?: ReadonlyArray<{
    reason: "phone" | "name_dob";
    clientId: string;
    clientName: string;
    archived: boolean;
  }>;
  /** Edit only: a changed field was changed by someone else after this page loaded (current vs yours). */
  conflicts?: ReadonlyArray<ProfileConflict>;
};

type Props = {
  initialValues?: ClientFormValues;
  submitLabel: string;
  pendingLabel: string;
  cancelHref: string;
  hiddenFields?: Record<string, string>;
  /** Edit only: the stored values this page loaded. Sent back so only real changes are written, conditionally. */
  baseline?: ProfileBaseline;
  // HON-58: the probable-duplicate "save anyway" button. Create saves a new
  // record; the edit page saves the existing one and says so.
  saveAnywayLabel?: string;
  action: (formData: FormData) => Promise<ClientFormActionResult | void>;
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
  baseline: initialBaseline,
  saveAnywayLabel = "Save as a new client anyway",
  action,
}: Props) {
  const [values, setValues] = useState<ClientFormValues>(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [possibleDuplicates, setPossibleDuplicates] =
    useState<ClientFormActionResult["possibleDuplicates"]>(undefined);
  const [pending, startTransition] = useTransition();
  const [baseline, setBaseline] = useState<ProfileBaseline | undefined>(initialBaseline);
  const [conflicts, setConflicts] = useState<ReadonlyArray<ProfileConflict> | undefined>(undefined);
  const [clearPreferred, setClearPreferred] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);

  // Bounded pending state: if the save never reports back (offline, navigation never commits), leave a neutral
  // line, never a success and never a false failure.
  useEffect(() => {
    if (!pending) {
      setUnconfirmed(false);
      return;
    }
    const t = setTimeout(() => setUnconfirmed(true), SAVE_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pending]);

  function update<K extends keyof ClientFormValues>(
    key: K,
    value: ClientFormValues[K],
  ) {
    setValues((v) => ({ ...v, [key]: value }));
    // HON-58: an edit may change who this matches; ask again on the next save.
    setPossibleDuplicates(undefined);
  }

  function submit(
    confirmPossibleDuplicateIds: ReadonlyArray<string> | null,
    override?: { baseline?: ProfileBaseline },
  ) {
    setError(null);
    setConflicts(undefined);
    if (!values.name.trim()) {
      setError("Name is required.");
      return;
    }
    if (baseline && baseline.preferred_name && !values.preferred_name.trim() && !clearPreferred) {
      setError("To remove the preferred name, press Remove preferred name. Otherwise type a name.");
      return;
    }
    const sent = override?.baseline ?? baseline;
    const fd = buildClientFormData(
      values,
      {
        ...hiddenFields,
        ...(sent ? { baseline: JSON.stringify(sent) } : {}),
        ...(clearPreferred ? { clear_preferred_name: "yes" } : {}),
      },
      confirmPossibleDuplicateIds,
    );
    startTransition(async () => {
      const outcome = await runClientSave(action, fd);
      if (outcome.kind === "redirect") {
        // The server confirmed the save and asked the router to move on. Hand the redirect back to the
        // router untouched: showing an error here is the false "could not save" flash.
        throw outcome.redirect;
      }
      if (outcome.kind === "refused") {
        setError(outcome.result.error);
        setPossibleDuplicates(outcome.result.possibleDuplicates);
        setConflicts(outcome.result.conflicts);
        return;
      }
      if (outcome.kind === "failed") {
        // Server actions redact thrown errors in production; a genuine failure shows a generic line and
        // keeps every typed value.
        setError("Couldn't save the client. Please try again.");
      }
    });
  }

  // Review of a conflict: keep what is stored now for the conflicting fields, or apply my change on top of it.
  function keepCurrent() {
    if (!conflicts || !baseline) return;
    setValues((v) => {
      const next = { ...v } as Record<string, string>;
      for (const c of conflicts) next[c.key] = c.current;
      return next as unknown as ClientFormValues;
    });
    setBaseline(adoptCurrent(baseline, conflicts));
    setConflicts(undefined);
    setError(null);
  }
  function applyMine() {
    if (!conflicts || !baseline) return;
    const next = adoptCurrent(baseline, conflicts);
    setBaseline(next);
    const guards = conflicts.filter((c) => c.guard);
    if (guards.length > 0) {
      // A field this page did not change moved underneath it (it feeds the duplicate check). Show the new
      // value and let the staff member look again before saving; never write the old one back.
      setValues((v) => {
        const nv = { ...v } as Record<string, string>;
        for (const c of guards) nv[c.key] = c.current;
        return nv as unknown as ClientFormValues;
      });
      setConflicts(undefined);
      setError("A field you did not change was updated by someone else. Check it, then press Save again.");
      return;
    }
    submit(null, { baseline: next });
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit(null);
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

      <Field
        label="Preferred name"
        placeholder="Optional: the name the client goes by"
        value={values.preferred_name}
        onChange={(v) => {
          update("preferred_name", v);
          if (v.trim()) setClearPreferred(false);
        }}
        onKeyDown={blockEnterSubmit}
      />
      {baseline?.preferred_name ? (
        <button
          type="button"
          data-testid="remove-preferred-name"
          onClick={() => {
            update("preferred_name", "");
            setClearPreferred(true);
          }}
          className="-mt-3 self-start text-sm text-neutral-600 underline underline-offset-2 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          Remove preferred name
        </button>
      ) : null}

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
          helperText="Portal login requires each active client to have a unique email address."
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

      {/* RETIRED EDITOR (Chloe Session 1A). `clients.skin_notes` used to be an
          editable textarea with quick-tap condition chips, and it visually
          outranked the real clinical record: it sat on the profile Overview
          well above the append-only "Consultation & skin/hair" card and on the
          appointment detail page, which showed no clinical notes at all.
          Production reflected that hierarchy exactly: legacy skin_notes carried
          text for several clients while ZERO skin/hair-analysis notes existed.

          Every edit to that column destroyed the prior clinical text with no
          author, no date and no revision lineage. The canonical record,
          client_clinical_notes kind='skin_hair_analysis', is append-only,
          attributed and dated, so the editor is removed here and new skin/hair
          observations are recorded through "Add skin & hair analysis".

          The COLUMN is untouched: historical values are preserved, still
          rendered read-only under a "Legacy skin notes" heading on the profile,
          and still exported. Nothing is dropped, nulled, backfilled or copied
          into the append-only record. */}

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

      {error && !possibleDuplicates?.length && !conflicts?.length && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      {conflicts && conflicts.length > 0 && (
        <div
          role="alert"
          data-testid="client-save-conflict"
          className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          <p>{error}</p>
          <ul className="flex flex-col gap-1">
            {conflicts.map((c) => (
              <li key={c.key}>
                <span className="font-medium">{c.label}:</span> now{" "}
                <span className="font-medium">{c.current || "(empty)"}</span>, your change{" "}
                <span className="font-medium">{c.yours || "(empty)"}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={keepCurrent}
              className="rounded-md border border-amber-400 px-3 py-2 font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
            >
              Keep what is saved now
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={applyMine}
              className="rounded-md border border-amber-400 px-3 py-2 font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
            >
              Apply my change
            </button>
          </div>
        </div>
      )}
      {pending && unconfirmed && (
        <p role="status" data-testid="client-save-unconfirmed" className="text-sm text-neutral-600 dark:text-neutral-400">
          {SAVE_UNCONFIRMED_MESSAGE}
        </p>
      )}
      {error && possibleDuplicates && possibleDuplicates.length > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          <p>{error}</p>
          <div className="flex flex-wrap items-center gap-3">
            {possibleDuplicates.map((d) => (
              <Link
                key={d.clientId}
                href={`/clients/${d.clientId}`}
                className="font-medium underline underline-offset-2"
              >
                Open {d.clientName}
              </Link>
            ))}
            <button
              type="button"
              disabled={pending}
              onClick={() => submit(possibleDuplicates.map((d) => d.clientId))}
              className="rounded-md border border-amber-400 px-3 py-2 font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
            >
              {saveAnywayLabel}
            </button>
          </div>
        </div>
      )}

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
  helperText,
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
  helperText?: string;
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
      {helperText && (
        <span className="text-xs text-neutral-500">{helperText}</span>
      )}
    </label>
  );
}
