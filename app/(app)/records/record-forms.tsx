"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecordActionResult } from "./actions";

// PR #205: add-record forms for the Record Keeping logbook. Plain
// uncontrolled forms posting to the server actions; explicit saved /
// error feedback; iPad-friendly tap targets. No payment, public, or
// portal surface.

type Action = (formData: FormData) => Promise<RecordActionResult>;

const INPUT_CLS =
  "rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950";
const LABEL_CLS =
  "text-[11px] uppercase tracking-wider text-neutral-500";

function AddRecordForm({
  action,
  submitLabel,
  children,
}: {
  action: Action;
  submitLabel: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        setError(null);
        setSaved(false);
        startTransition(async () => {
          const res = await action(fd);
          if (res.ok) {
            form.reset();
            setSaved(true);
            router.refresh();
          } else {
            setError(res.error);
          }
        });
      }}
      className="flex flex-col gap-3"
    >
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        {saved && (
          <span className="text-sm text-green-700 dark:text-green-400" role="status">
            Record saved.
          </span>
        )}
        {error && (
          <span className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  placeholder,
  wide = false,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  wide?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? "sm:col-span-2" : ""}`}>
      <span className={LABEL_CLS}>
        {label}
        {required ? "" : " (optional)"}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        placeholder={placeholder}
        className={INPUT_CLS}
      />
    </label>
  );
}

function NotesField({ name = "notes" }: { name?: string }) {
  return (
    <label className="flex flex-col gap-1 sm:col-span-2">
      <span className={LABEL_CLS}>Notes (optional)</span>
      <textarea name={name} rows={2} className={INPUT_CLS} />
    </label>
  );
}

export function AddSterileItemForm({ action }: { action: Action }) {
  return (
    <AddRecordForm action={action} submitLabel="Add sterile item record">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date purchased" name="date_purchased" type="date" required />
        <Field
          label="Item description"
          name="item_description"
          required
          placeholder="e.g. Ballet F3 stainless probes"
        />
        <Field label="Manufacturer" name="manufacturer_name" placeholder="e.g. Ballet" />
        <Field label="Amount purchased" name="amount_purchased" placeholder="e.g. 50" />
        <Field label="Lot #" name="lot_number" placeholder="e.g. 460941" />
        <Field label="Expiry date" name="expiry_date" type="date" />
        <NotesField />
      </div>
    </AddRecordForm>
  );
}

export function AddDisinfectantForm({ action }: { action: Action }) {
  return (
    <AddRecordForm action={action} submitLabel="Add disinfectant record">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date prepared" name="date_prepared" type="date" required />
        <Field
          label="Disinfectant name"
          name="disinfectant_name"
          required
          placeholder="e.g. CaviCide"
        />
        <Field label="Concentration" name="concentration" placeholder="e.g. ready to use / 1:10" />
        <Field label="Date discarded" name="date_discarded" type="date" />
        <Field
          label="Operator"
          name="operator_name"
          placeholder="Defaults to you"
        />
        <NotesField />
      </div>
    </AddRecordForm>
  );
}

export function AddExposureIncidentForm({ action }: { action: Action }) {
  return (
    <AddRecordForm action={action} submitLabel="Add exposure incident">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Incident date" name="incident_date" type="date" required />
        <Field
          label="Exposed person's full name"
          name="exposed_person_full_name"
          required
        />
        <Field label="Address" name="exposed_person_address" wide />
        <Field label="Phone" name="exposed_person_phone" />
        <Field label="Staff involved" name="staff_involved_name" />
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={LABEL_CLS}>How the exposure occurred</span>
          <textarea name="exposure_details" rows={3} className={INPUT_CLS} />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={LABEL_CLS}>Action taken</span>
          <textarea name="action_taken" rows={3} className={INPUT_CLS} />
        </label>
        <NotesField />
      </div>
    </AddRecordForm>
  );
}

// Explicit "Procedure risks explained and aftercare information
// provided" mark on a client procedure record. Never auto-set;
// reversible in case of a mis-tap.
export function AftercareExplainedToggle({
  sessionId,
  explainedAt,
  action,
}: {
  sessionId: string;
  explainedAt: string | null;
  action: Action;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const explained = !!explainedAt;
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={explained}
      onClick={() => {
        const fd = new FormData();
        fd.set("session_id", sessionId);
        fd.set("explained", explained ? "false" : "true");
        startTransition(async () => {
          await action(fd);
          router.refresh();
        });
      }}
      className={
        explained
          ? "rounded-md border border-green-300 bg-green-50 px-3 py-2 text-xs font-medium text-green-900 hover:bg-green-100 disabled:opacity-50 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200"
          : "rounded-md border border-neutral-300 px-3 py-2 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
      }
    >
      {explained
        ? "✓ Risks explained and aftercare provided"
        : "Mark: procedure risks explained and aftercare information provided"}
    </button>
  );
}
