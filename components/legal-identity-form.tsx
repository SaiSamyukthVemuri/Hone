"use client";

import { useEffect, useState, useTransition } from "react";
import {
  saveLegalIdentityAction,
  type LegalNameParts,
  type LegalStoredBaseline,
} from "@/app/(app)/clients/[id]/legal-identity-actions";

// HON-58: the legal name entered by staff, for clinical and insurer output.
// Shown only to a signed-in owner or practitioner (the edit page is a
// practitioner page, and the table itself refuses anyone else).
export type LegalIdentityValues = { given: string; middle: string; family: string };

const FIELD =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100";

const toStored = (v: LegalNameParts): NonNullable<LegalStoredBaseline> => ({
  given: v.given || null,
  middle: v.middle || null,
  family: v.family || null,
});

export function LegalIdentityForm({
  clientId,
  initial,
  stored: initialStored,
}: {
  clientId: string;
  initial: LegalIdentityValues;
  /** The parts as stored when the page loaded, or null when there was no legal name yet. */
  stored: LegalStoredBaseline;
}) {
  const [values, setValues] = useState(initial);
  // The baseline the next save is conditional on: the stored value, then whatever the last save wrote.
  const [stored, setStored] = useState<LegalStoredBaseline>(initialStored);
  const [conflict, setConflict] = useState<LegalNameParts | null>(null);
  // What is stored right now: the loaded value, then whatever the last successful save wrote.
  const [saved, setSaved] = useState(initial);
  const dirty = values.given !== saved.given || values.middle !== saved.middle || values.family !== saved.family;
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // This is a separate form from the client form, so saving the client (or reloading) would silently drop a
  // legal name typed here. Ask the browser to confirm closing or reloading while it differs from what is
  // stored. Limit, stated: an in-app link click is not intercepted; the visible notice below is the cue.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("legal_given_name", values.given);
    fd.set("legal_middle_name", values.middle);
    fd.set("legal_family_name", values.family);
    fd.set("legal_baseline", stored === null ? "none" : JSON.stringify(stored));
    setConflict(null);
    const submitted = { ...values };
    startTransition(async () => {
      try {
        const result = await saveLegalIdentityAction(fd);
        if (result.ok) {
          // The server's normalised values are what is stored now: they are the new baseline.
          setSaved(result.value);
          // Keep anything typed while the request was pending: adopt the normalised values only when the draft
          // still equals what was submitted (otherwise the form stays dirty and the unsaved notice shows).
          setValues((cur) =>
            cur.given === submitted.given && cur.middle === submitted.middle && cur.family === submitted.family
              ? result.value
              : cur,
          );
          setStored(toStored(result.value));
          setMessage({ kind: "ok", text: "Legal name saved." });
        } else {
          setMessage({ kind: "error", text: result.error });
          if (result.current) setConflict(result.current);
        }
      } catch {
        setMessage({ kind: "error", text: "Couldn't save the legal name. Please try again." });
      }
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div>
        <h2 className="text-base font-semibold">Legal name</h2>
        <p className="text-xs text-neutral-500">
          Used on clinical and insurance documents. Everywhere else shows the preferred name when there is one.
          Enter it as it appears on the client&rsquo;s identification.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          Given name
          <input className={FIELD} value={values.given} onChange={(e) => setValues((v) => ({ ...v, given: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Middle name
          <input className={FIELD} value={values.middle} onChange={(e) => setValues((v) => ({ ...v, middle: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Family name
          <input className={FIELD} value={values.family} onChange={(e) => setValues((v) => ({ ...v, family: e.target.value }))} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Saving…" : "Save legal name"}
        </button>
        {dirty && !pending && (
          <span data-testid="legal-name-unsaved" role="status" className="text-sm text-amber-800 dark:text-amber-300">
            Unsaved legal name. Press Save legal name before leaving this page.
          </span>
        )}
        {message && (
          <span role="status" className={message.kind === "ok" ? "text-sm text-green-700" : "text-sm text-red-700"}>
            {message.text}
          </span>
        )}
      </div>
      {conflict && (
        <div
          role="alert"
          data-testid="legal-name-conflict"
          className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          <p>
            Saved now: <span className="font-medium">{[conflict.given, conflict.middle, conflict.family].filter(Boolean).join(" ") || "(empty)"}</span>
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setValues(conflict);
                setSaved(conflict);
                setStored(toStored(conflict));
                setConflict(null);
                setMessage(null);
              }}
              className="rounded-md border border-amber-400 px-3 py-2 font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
            >
              Keep what is saved now
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setStored(toStored(conflict));
                setConflict(null);
                setMessage(null);
              }}
              className="rounded-md border border-amber-400 px-3 py-2 font-medium hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:hover:bg-amber-900"
            >
              Apply my change
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
