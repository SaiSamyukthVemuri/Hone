import Link from "next/link";
import { FITZPATRICK_TYPES } from "@/lib/constants";
import { createClientAction } from "./actions";

export default function NewClientPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div>
        <Link
          href="/clients"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Clients
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">New client</h1>
      </div>

      <form action={createClientAction} className="flex flex-col gap-5">
        <Field label="Name" name="name" required autoFocus />
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Pronouns" name="pronouns" placeholder="she/her" />
          <Field
            label="Date of birth"
            name="date_of_birth"
            type="date"
          />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Phone" name="phone" type="tel" inputMode="tel" />
          <Field label="Email" name="email" type="email" />
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Fitzpatrick type</span>
          <select
            name="fitzpatrick_type"
            defaultValue=""
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
            name="skin_notes"
            rows={4}
            placeholder="Sensitivities, conditions, scarring tendencies…"
            className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </label>

        <div className="mt-2 flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Save client
          </button>
          <Link
            href="/clients"
            className="rounded-md border border-neutral-300 px-5 py-3 text-base hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  placeholder,
  autoFocus = false,
  inputMode,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  inputMode?: "tel" | "email" | "text" | "numeric";
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        autoFocus={autoFocus}
        inputMode={inputMode}
        className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
      />
    </label>
  );
}
