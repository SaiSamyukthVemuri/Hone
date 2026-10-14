"use client";

import { useActionState, useId } from "react";

import type {
  SenderNumberSearchResult,
} from "./actions";

// The number-lookup control — the first reachable step of the SMS sender
// lifecycle, and deliberately ONLY that step.
//
// WHY A SEPARATE CARD FROM THE STATUS PANEL. The status card is a server
// component with nothing to press, and it says so about itself. Controls belong
// to their own slices with their own authority and their own proof, so this one
// arrives as a sibling rather than as handlers grafted onto that file. The next
// control (choose, then buy) renders into this same surface.
//
// WHAT THE COPY MUST NOT IMPLY. Looking a number up neither reserves nor buys
// it. A surface that lists numbers and offers no way to take one will be read as
// "pick one" unless it says otherwise, so it says otherwise -- twice, once
// before the search and once alongside the results, because the second is the
// moment the assumption actually forms.

export type SenderNumberSearchAction = (
  prev: SenderNumberSearchResult | null,
  formData: FormData,
) => Promise<SenderNumberSearchResult>;

export function SenderNumberSearch({
  action,
}: {
  action: SenderNumberSearchAction;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const ids = useId();
  const countryId = `${ids}-country`;
  const areaCodeId = `${ids}-area-code`;

  return (
    <div
      // The nav entry's href carries this fragment. An anchor that does not
      // exist scrolls nowhere and the search result looks broken, so the id and
      // the registration are one change.
      id="sms-sender-numbers"
      data-testid="sms-sender-number-search"
      className="rounded-lg border border-neutral-300 p-5 dark:border-neutral-700"
    >
      <h3 className="text-sm font-semibold">Find a number</h3>
      <p className="mt-1 text-sm text-neutral-500">
        See which phone numbers your studio could use for text messages.
        Looking does not reserve or buy anything.
      </p>

      <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={countryId} className="text-sm font-medium">
            Country
          </label>
          <input
            id={countryId}
            name="country"
            required
            maxLength={2}
            placeholder="CA"
            autoComplete="off"
            // Two letters, ISO-3166 alpha-2. The shipped orchestration
            // validates this itself and answers `invalid_input`; the attribute
            // is a courtesy so the owner is told before a round trip, never the
            // authority.
            pattern="[A-Za-z]{2}"
            className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-sm uppercase dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={areaCodeId} className="text-sm font-medium">
            Area code
          </label>
          <input
            id={areaCodeId}
            name="areaCode"
            inputMode="numeric"
            maxLength={5}
            placeholder="Optional"
            autoComplete="off"
            pattern="[0-9]{2,5}"
            className="w-28 rounded-md border border-neutral-300 px-2 py-1 text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-neutral-900 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-neutral-100"
        >
          {pending ? "Searching…" : "Find numbers"}
        </button>
      </form>

      {/* One live region for every outcome. A refusal and a result arriving in
          different regions means a screen reader announces one of them and not
          the other, depending on which node React happens to reuse. */}
      <div aria-live="polite" className="mt-4">
        {pending ? null : state === null ? null : state.ok ? (
          <div data-testid="sender-number-results">
            <p className="text-sm text-neutral-500">
              {state.candidates.length === 1
                ? "1 number available"
                : `${state.candidates.length} numbers available`}{" "}
              in {state.searchedCountry}
              {state.searchedAreaCode ? ` · area code ${state.searchedAreaCode}` : ""}.
              None of these is reserved for your studio.
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {state.candidates.map((c) => (
                <li
                  key={c.phoneNumber}
                  data-testid="sender-number-candidate"
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
                >
                  <span className="font-medium tabular-nums">{c.formatted}</span>
                  <span className="text-neutral-500">
                    {[c.locality, c.region].filter(Boolean).join(", ") ||
                      c.country}
                  </span>
                  {/* Said out loud rather than shown as a tick: a number that
                      cannot send SMS is useless as a sender, and the owner
                      should not have to infer that from a missing glyph. */}
                  {c.smsCapable ? null : (
                    <span className="text-neutral-500">Cannot send texts</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p data-testid="sender-number-error" className="text-sm text-neutral-500">
            {state.message}
          </p>
        )}
      </div>
    </div>
  );
}
