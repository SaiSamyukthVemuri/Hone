"use client";

// Practitioner-only Birthday card on the client profile Overview tab.
//
// Month + day only. No year input, no age display. The form submits a
// month and a day; the server action preserves any existing real year
// on edit, or uses a 1900 sentinel for fresh entries (see
// app/(app)/clients/[id]/birthday-actions.ts for the rationale).
//
// Practitioner-facing only. Never imported by public/email/cron/api
// surfaces (audited by grep in PR #28).

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

type Props = {
  clientId: string;
  // YYYY-MM-DD from clients.date_of_birth, or null when unset.
  dateOfBirth: string | null;
  // Studio-local today, used to compute the "today" and "this month"
  // callouts. Computed by the server component from todayInTz().
  studioToday: { month: number; day: number };
  action: (formData: FormData) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
};

const MONTHS: ReadonlyArray<string> = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseMonthDay(
  dob: string | null,
): { month: number; day: number } | null {
  if (!dob) return null;
  const parts = dob.split("-");
  if (parts.length !== 3) return null;
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

type State =
  | { status: "idle" }
  | { status: "saved" }
  | { status: "error"; message: string };
const INITIAL_STATE: State = { status: "idle" };

export function ClientBirthdayCard({
  clientId,
  dateOfBirth,
  studioToday,
  action,
}: Props) {
  const md = parseMonthDay(dateOfBirth);
  const [editing, setEditing] = useState(false);

  const [state, formAction] = useActionState(
    async (_prev: State, formData: FormData): Promise<State> => {
      const r = await action(formData);
      if (!r.ok) return { status: "error", message: r.error };
      setEditing(false);
      return { status: "saved" };
    },
    INITIAL_STATE,
  );

  // A second action wraps the same server action but always submits
  // empty month/day, which the server treats as "clear birthday". We
  // only need the action callback here, not its state.
  const [, clearAction] = useActionState(
    async (_prev: State, formData: FormData): Promise<State> => {
      const r = await action(formData);
      if (!r.ok) return { status: "error", message: r.error };
      setEditing(false);
      return { status: "saved" };
    },
    INITIAL_STATE,
  );

  const isToday =
    md != null &&
    md.month === studioToday.month &&
    md.day === studioToday.day;
  const isThisMonth =
    md != null && md.month === studioToday.month && !isToday;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <header className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Birthday
        </h2>
        <p className="text-xs text-neutral-500">
          Used only for practitioner reminders. Not shown to clients.
        </p>
      </header>

      {isToday && (
        <div className="rounded-md border-l-4 border-amber-400 bg-amber-50 px-3 py-2 dark:border-amber-500 dark:bg-amber-950/30">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-900 dark:text-amber-200">
            Birthday today
          </p>
        </div>
      )}
      {isThisMonth && (
        <div className="rounded-md border-l-4 border-emerald-400 bg-emerald-50 px-3 py-2 dark:border-emerald-500 dark:bg-emerald-950/30">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-900 dark:text-emerald-200">
            Birthday month
          </p>
          <p className="mt-0.5 text-xs text-emerald-900 dark:text-emerald-100">
            Wish them a happy birth month.
          </p>
        </div>
      )}

      {!editing ? (
        <div className="flex items-center justify-between gap-3">
          {md ? (
            <p className="text-sm text-neutral-800 dark:text-neutral-200">
              {MONTHS[md.month - 1]} {md.day}
            </p>
          ) : (
            <p className="text-xs text-neutral-500">
              Birthday not added yet.
            </p>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-neutral-500 hover:text-neutral-900 hover:underline dark:hover:text-neutral-100"
          >
            {md ? "Edit" : "Add birthday"}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="client_id" value={clientId} />
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                  Month
                </span>
                <select
                  name="birthday_month"
                  defaultValue={md?.month ?? ""}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
                >
                  <option value="">—</option>
                  {MONTHS.map((m, i) => (
                    <option key={i + 1} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                  Day
                </span>
                <select
                  name="birthday_day"
                  defaultValue={md?.day ?? ""}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
                >
                  <option value="">—</option>
                  {Array.from({ length: 31 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </select>
              </label>
              <SaveButton />
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
              >
                Cancel
              </button>
            </div>
            {state.status === "error" && (
              <p role="alert" className="text-xs text-red-700 dark:text-red-400">
                {state.message}
              </p>
            )}
          </form>

          {md && (
            <form action={clearAction}>
              <input type="hidden" name="client_id" value={clientId} />
              {/* Empty month/day → server treats as "clear birthday". */}
              <input type="hidden" name="birthday_month" value="" />
              <input type="hidden" name="birthday_day" value="" />
              <ClearButton />
            </form>
          )}
        </div>
      )}
    </section>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900"
    >
      {pending ? "Saving…" : "Save"}
    </button>
  );
}

function ClearButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-xs text-neutral-500 hover:text-red-700 hover:underline disabled:opacity-50 dark:hover:text-red-400"
    >
      {pending ? "Clearing…" : "Clear birthday"}
    </button>
  );
}
