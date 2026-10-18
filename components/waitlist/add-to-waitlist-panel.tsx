"use client";

import { useActionState, useId, useState } from "react";

import type { WaitlistProfileActionResult } from "@/app/(app)/settings/waitlist/profile-actions";
import {
  AVAILABILITY_PREFERENCES,
  AVAILABILITY_PREFERENCE_LABEL,
} from "@/lib/waitlist/join-profile";

export type AddEntryFormAction = (
  prev: WaitlistProfileActionResult | null,
  formData: FormData,
) => Promise<WaitlistProfileActionResult>;

// ===========================================================================
// WAIT-04A — the two ways a person reaches the queue other than the form
// ===========================================================================
//
// TWO COMMANDS, TWO TABS, ONE PANEL — and they are separated because the CLAIM
// each makes about queue position is different, not because the fields differ:
//
//   ADD SOMEONE     -> `create_practitioner_waitlist_entry`. They joined TODAY.
//                      The command owns `joined_at` and this form cannot supply
//                      one. Someone the studio adds now goes to the back, which
//                      is the honest position for a person who asked now.
//
//   FROM MY RECORDS -> `import_legacy_waitlist_entry`. They joined BEFORE Hone.
//                      The date is supplied, the row takes its true place ahead
//                      of later joiners, and `joined_at_provenance` records that
//                      a human asserted it rather than the form observing it.
//
// SEPARATING THEM IS THE SAFEGUARD. A single form with an optional date would
// make queue-position forgery a matter of typing in a field — 0193's own
// comment names that outcome — and would let a mis-set date quietly place a
// brand-new enquiry ahead of people who have genuinely been waiting.
//
// "I DON'T HAVE A DATE" IS A FIRST-CLASS ANSWER, not a blank field. It writes
// `unknown`, and the queue then refuses to render that row as a wait at all.
// An operator who has no date must be able to say so without inventing one.

type Tab = "add" | "import";

export function AddToWaitlistPanel({
  addAction,
  importAction,
  initialAddState = null,
  initialImportState = null,
  initialTab = "add",
}: {
  addAction: AddEntryFormAction;
  importAction: AddEntryFormAction;
  initialAddState?: WaitlistProfileActionResult | null;
  initialImportState?: WaitlistProfileActionResult | null;
  /** A real prop, not a test hook: a deep link may open the panel on either tab. */
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [addState, addFormAction, addPending] = useActionState(addAction, initialAddState);
  const [importState, importFormAction, importPending] = useActionState(
    importAction,
    initialImportState,
  );
  const ids = useId();

  const state = tab === "add" ? addState : importState;

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      data-testid="add-to-waitlist"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">Add someone to the waitlist</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          For enquiries that arrived by phone, email or in person — and for people
          who were already waiting before you started using Hone.
        </p>
      </div>

      <div className="flex gap-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "add"}
          onClick={() => setTab("add")}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            tab === "add"
              ? "border-neutral-900 dark:border-neutral-100"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
          data-testid="add-tab-new"
        >
          They asked today
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "import"}
          onClick={() => setTab("import")}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            tab === "import"
              ? "border-neutral-900 dark:border-neutral-100"
              : "border-neutral-300 dark:border-neutral-700"
          }`}
          data-testid="add-tab-import"
        >
          They were already waiting
        </button>
      </div>

      {tab === "add" ? (
        <form action={addFormAction} className="flex flex-col gap-3" data-testid="add-form">
          <NameEmailPhone idPrefix={`${ids}-add`} />
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-add-pref`} className="text-xs text-neutral-500">
              Availability, if they said (optional)
            </label>
            <select
              id={`${ids}-add-pref`}
              name="preference"
              defaultValue=""
              className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              data-testid="add-preference"
            >
              <option value="">Not stated</option>
              {AVAILABILITY_PREFERENCES.map((p) => (
                <option key={p} value={p}>
                  {AVAILABILITY_PREFERENCE_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <p className="text-sm text-neutral-500" data-testid="add-queue-note">
            They will join the back of the queue, dated today.
          </p>
          <SubmitRow pending={addPending} label="Add to waitlist" testId="add-submit" />
        </form>
      ) : (
        <form action={importFormAction} className="flex flex-col gap-3" data-testid="import-form">
          <NameEmailPhone idPrefix={`${ids}-import`} />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs text-neutral-500">When did they join?</legend>
            {/* NEITHER OPTION IS PRE-SELECTED. The choice decides where this
                person lands relative to everyone already waiting, so it is the
                one field on this form that must be answered deliberately. */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="provenance"
                value="operator_supplied"
                data-testid="import-has-date"
              />
              I have their join date
            </label>
            <div className="flex flex-col gap-1 pl-6">
              <label htmlFor={`${ids}-import-date`} className="text-xs text-neutral-500">
                Join date
              </label>
              <input
                id={`${ids}-import-date`}
                type="date"
                name="joined_at"
                className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                data-testid="import-date"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="provenance"
                value="unknown"
                data-testid="import-no-date"
              />
              I don&rsquo;t have a date for them
            </label>
          </fieldset>
          <p className="text-sm text-neutral-500" data-testid="import-queue-note">
            With a date they take their real place in the queue. Without one they are
            listed without a join date, and the queue will not show a waiting time
            it cannot stand behind.
          </p>
          <SubmitRow pending={importPending} label="Add from my records" testId="import-submit" />
        </form>
      )}

      {state && !state.ok && (
        <p className="text-sm text-red-600" role="alert" data-testid="add-error">
          {state.message}
        </p>
      )}
    </section>
  );
}

function NameEmailPhone({ idPrefix }: { idPrefix: string }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Field id={`${idPrefix}-name`} name="name" label="Name" testId="field-name" required />
      <Field
        id={`${idPrefix}-email`}
        name="email"
        label="Email"
        type="email"
        testId="field-email"
        required
      />
      <Field
        id={`${idPrefix}-phone`}
        name="phone"
        label="Phone (optional)"
        type="tel"
        testId="field-phone"
      />
    </div>
  );
}

function Field({
  id,
  name,
  label,
  type = "text",
  testId,
  required,
}: {
  id: string;
  name: string;
  label: string;
  type?: string;
  testId: string;
  required?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-neutral-500">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        data-testid={testId}
      />
    </div>
  );
}

function SubmitRow({
  pending,
  label,
  testId,
}: {
  pending: boolean;
  label: string;
  testId: string;
}) {
  return (
    <div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700"
        data-testid={testId}
      >
        {pending ? "Saving…" : label}
      </button>
    </div>
  );
}
