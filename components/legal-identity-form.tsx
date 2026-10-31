"use client";

import { useState, useTransition } from "react";
import { saveLegalIdentityAction } from "@/app/(app)/clients/[id]/legal-identity-actions";

// HON-58: the legal name entered by staff, for clinical and insurer output.
// Shown only to a signed-in owner or practitioner (the edit page is a
// practitioner page, and the table itself refuses anyone else).
export type LegalIdentityValues = { given: string; middle: string; family: string };

const FIELD =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100";

export function LegalIdentityForm({ clientId, initial }: { clientId: string; initial: LegalIdentityValues }) {
  const [values, setValues] = useState(initial);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("legal_given_name", values.given);
    fd.set("legal_middle_name", values.middle);
    fd.set("legal_family_name", values.family);
    startTransition(async () => {
      try {
        const result = await saveLegalIdentityAction(fd);
        setMessage(result.ok ? { kind: "ok", text: "Legal name saved." } : { kind: "error", text: result.error });
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
        {message && (
          <span role="status" className={message.kind === "ok" ? "text-sm text-green-700" : "text-sm text-red-700"}>
            {message.text}
          </span>
        )}
      </div>
    </form>
  );
}
