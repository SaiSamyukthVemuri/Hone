"use client";

import { useState, useTransition } from "react";
import { updateStudioPolicyAction } from "./actions";
import { MarkdownLiteTextarea } from "./PostcareEditingHelpers";

// Per-studio cancellation / no-show policy editor (C2a-core).
//
// Owner-authored content. Saved text will be shown to clients above
// the card-on-file consent block in a future release; this PR does
// not collect cards, does not write payment_consents, and does not
// enable card collection.
//
// Both textareas are standard controlled inputs (Postcare PR #92 had
// a placeholder-confusion bug; here we render the example wording in
// a separate selectable block above the field instead of using the
// HTML placeholder for it).
//
// Save behaviour: the server action bumps policy_version +
// policy_updated_at only when the saved text actually differs from
// the row's current text. A no-op save does not advance the version.
//
// Hard rules baked into the form:
//   - Saving does NOT enable card collection.
//   - Saving does NOT charge anyone.
//   - Saving does NOT change require_card_on_file.

type Props = {
  initial: {
    cancellation_policy_text: string;
    no_show_policy_text: string;
    policy_version: string | null;
    policy_updated_at: string | null;
  };
};

const CANCELLATION_EXAMPLE =
  "Example: I ask for at least 24 hours notice for cancellation. Less than 24 hours notice may result in a fee equal to 50% of the booked service price.";

const NO_SHOW_EXAMPLE =
  "Example: A no-show is when a client does not arrive for a booked appointment without prior notice. No-shows may result in a fee equal to the full booked service price.";

export function PolicySettingsForm({ initial }: Props) {
  const [cancellation, setCancellation] = useState(
    initial.cancellation_policy_text,
  );
  const [noShow, setNoShow] = useState(initial.no_show_policy_text);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<
    { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setHint({ kind: "idle" });
    const fd = new FormData();
    fd.set("cancellation_policy_text", cancellation);
    fd.set("no_show_policy_text", noShow);
    startTransition(async () => {
      try {
        await updateStudioPolicyAction(fd);
        setHint({ kind: "saved" });
        window.setTimeout(() => setHint({ kind: "idle" }), 1500);
      } catch (err) {
        setHint({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to save.",
        });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-medium">
          Cancellation and no-show policy
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          These policies are shown to clients in the portal when they sign
          the card-on-file authorization. Saving these policies does not
          collect a card or charge anyone.
        </p>
        {/* Formatting help mirrors PostcareSettingsForm so practitioners
            who edited postcare already know the shortcuts and tokens.
            The same lib/email/markdown-lite.ts renderer will format the
            text when it is shown to clients (deferred render, gated on
            card-on-file). MarkdownLiteTextarea wraps the textarea with
            a Bold / Italic / Bullet toolbar and Cmd+B / Cmd+I keyboard
            shortcuts; storage is unchanged (still the same markdown-lite
            string the renderer already understands). */}
        <div className="mt-1 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          <p className="font-medium text-neutral-800 dark:text-neutral-200">
            Formatting
          </p>
          <p className="mt-1">
            Use the toolbar buttons or keyboard shortcuts: Cmd+B / Ctrl+B
            for bold, Cmd+I / Ctrl+I for italic. <code>- bullet</code> at
            the start of a line makes a list.{" "}
            <code>[label](https://example.com)</code> makes a link. All
            other HTML is escaped before sending.
          </p>
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Cancellation policy</span>
        <MarkdownLiteTextarea
          rows={5}
          value={cancellation}
          onChange={setCancellation}
          placeholder="Describe how much notice you need and any cancellation fee."
          ariaLabel="Cancellation policy"
        />
        <details className="mt-1 text-xs text-neutral-500">
          <summary className="cursor-pointer select-none">
            Example wording
          </summary>
          <p className="mt-2 whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-3 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
            {CANCELLATION_EXAMPLE}
          </p>
        </details>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">No-show policy</span>
        <MarkdownLiteTextarea
          rows={5}
          value={noShow}
          onChange={setNoShow}
          placeholder="Describe what counts as a no-show and any associated fee."
          ariaLabel="No-show policy"
        />
        <details className="mt-1 text-xs text-neutral-500">
          <summary className="cursor-pointer select-none">
            Example wording
          </summary>
          <p className="mt-2 whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-3 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
            {NO_SHOW_EXAMPLE}
          </p>
        </details>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Saving…" : "Save policies"}
        </button>
        {hint.kind === "saved" && (
          <span className="text-xs text-green-600 dark:text-green-400">
            Saved.
          </span>
        )}
        {hint.kind === "error" && (
          <span className="text-xs text-red-700">{hint.message}</span>
        )}
        {initial.policy_version && (
          <span className="text-xs text-neutral-500">
            Version: {initial.policy_version}
          </span>
        )}
      </div>

      <p className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        These policies are practitioner-authored. Hone does not draft
        legal language for you. What you write here is what your clients
        see and agree to before their card is saved on file.
      </p>
    </form>
  );
}
