"use client";

// Practitioner-only client personal notes editor.
//
// Renders two freeform text areas — Personal notes (always visible)
// and Private warnings (collapsed by default inside a <details>).
// The Private warnings collapse is the load-bearing piece of the UX:
// it stays closed when a client can see the practitioner's screen.
//
// Bound directly to updateClientPersonalNotesAction via <form action>.
// useFormStatus() drives the Save button's pending label. The action's
// return value is captured via React 19's useActionState so success
// and error states render without a transition wrapper.
//
// This component is rendered ONLY on the authenticated client profile
// page (app/(app)/clients/[id]/page.tsx) under the "personal" tab.
// It must NOT be imported by app/book/*, lib/email/*, app/intake/*,
// app/cancel/*, app/reschedule/*, app/api/cron/*, or
// app/api/stripe/*. The import audit in PR #27 enforces this contract.

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

const MAX_NOTE_LENGTH = 20000;

export type PersonalNotesAction = (
  prev: PersonalNotesActionState,
  formData: FormData,
) => Promise<PersonalNotesActionState>;

export type PersonalNotesActionState =
  | { status: "idle" }
  | { status: "saved"; at: number }
  | { status: "error"; message: string };

const INITIAL_STATE: PersonalNotesActionState = { status: "idle" };

export function ClientPersonalNotesEditor({
  clientId,
  initial,
  action,
}: {
  clientId: string;
  initial: {
    personal_notes: string;
    private_warnings: string;
  };
  // The underlying server action (returns { ok } | { ok: false, error }).
  // The page wraps it into a useActionState-compatible reducer so we can
  // surface saved/error state without changing the action's shape.
  action: (formData: FormData) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
}) {
  const [state, formAction] = useActionState(
    async (
      _prev: PersonalNotesActionState,
      formData: FormData,
    ): Promise<PersonalNotesActionState> => {
      const r = await action(formData);
      if (!r.ok) return { status: "error", message: r.error };
      return { status: "saved", at: Date.now() };
    },
    INITIAL_STATE,
  );

  // <details> with `open` set only when there is existing content makes
  // the section discoverable for editing while still defaulting to
  // closed for empty/new clients. Practitioners can collapse it at any
  // time; the textarea inside keeps its value across collapse/expand.
  const hasWarnings = initial.private_warnings.length > 0;

  return (
    <form
      action={formAction}
      className="flex flex-col gap-5 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <input type="hidden" name="client_id" value={clientId} />

      <section className="flex flex-col gap-2">
        <header className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Personal notes
          </h2>
          <p className="text-xs text-neutral-500">
            Private relationship notes for your own memory. These are not
            shown to clients.
          </p>
        </header>
        <textarea
          name="personal_notes"
          defaultValue={initial.personal_notes}
          rows={10}
          maxLength={MAX_NOTE_LENGTH}
          placeholder="Kids&rsquo; names, pets, partner or job, vacations, conversation follow-ups, preferences, things to ask about next time…"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </section>

      <details
        className="group rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 open:bg-white dark:border-neutral-700 dark:bg-neutral-900 dark:open:bg-neutral-950"
        open={false}
      >
        <summary className="flex cursor-pointer items-baseline justify-between gap-2 text-sm">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">
            Private warnings
          </span>
          <span className="text-[11px] text-neutral-500 group-open:hidden">
            Tap to open
          </span>
          <span className="hidden text-[11px] text-neutral-500 group-open:inline">
            Tap to close
          </span>
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            Sensitive practitioner-only notes. Keep this closed when a
            client can see your screen.
          </p>
          <textarea
            name="private_warnings"
            defaultValue={initial.private_warnings}
            rows={6}
            maxLength={MAX_NOTE_LENGTH}
            placeholder="Repeated lateness, ignored aftercare, uncomfortable interaction, boundaries, safety notes…"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          {hasWarnings && (
            <p className="text-[11px] text-neutral-500">
              Existing private warnings are saved on this client.
            </p>
          )}
        </div>
      </details>

      <footer className="flex items-center justify-end gap-3">
        {state.status === "error" && (
          <p
            role="alert"
            className="text-xs text-red-700 dark:text-red-400"
          >
            {state.message}
          </p>
        )}
        {state.status === "saved" && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            Saved.
          </p>
        )}
        <SaveButton />
      </footer>
    </form>
  );
}

// Sits inside the <form action={formAction}> so useFormStatus() picks up
// the in-flight state of the server action.
function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      {pending ? "Saving…" : "Save"}
    </button>
  );
}
