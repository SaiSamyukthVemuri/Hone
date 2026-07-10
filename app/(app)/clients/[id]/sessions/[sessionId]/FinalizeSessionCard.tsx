"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { finalizeSessionAction } from "./finalize-actions";

// Clinical Record — Phase 1. Rendered only when the studio-scoped
// `clinical_finalization_enabled` flag is on. Three states:
//   * legacy:    a neutral "Legacy record" label. Legacy sessions are NEVER
//                finalizable and are NOT presented as active native drafts.
//   * native draft: a validation summary + explicit "Finalize & sign" (requires
//                an accuracy confirmation); warns the record becomes read-only.
//   * finalized: a read-only badge with finalized date/practitioner/version and
//                the "original preserved; corrections/amendments come later"
//                message. No reopen / void / correction / amendment action exists.
// This does NOT change treatment-memory reads (a later phase).

type Props = {
  sessionId: string;
  clientId: string;
  recordStatus: "draft" | "finalized" | "void";
  recordOrigin: "native" | "legacy";
  recordVersion: number;
  finalizedAt: string | null;
  finalizedByName: string | null;
  snapshotVersion: number | null;
  // Validation summary context.
  areasCount: number;
  passesCount: number;
  photosCount: number;
  aftercareExplained: boolean;
};

export function FinalizeSessionCard({
  sessionId,
  clientId,
  recordStatus,
  recordOrigin,
  recordVersion,
  finalizedAt,
  finalizedByName,
  snapshotVersion,
  areasCount,
  passesCount,
  photosCount,
  aftercareExplained,
}: Props) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (recordStatus === "finalized" || recordStatus === "void") {
    return (
      <section className="flex flex-col gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-5 dark:border-emerald-800 dark:bg-emerald-950/30">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-white">
            Finalized
          </span>
          {finalizedAt && (
            <span className="text-xs text-emerald-900 dark:text-emerald-200">
              {new Date(finalizedAt).toLocaleString()}
            </span>
          )}
          {finalizedByName && (
            <span className="text-xs text-emerald-900 dark:text-emerald-200">
              · by {finalizedByName}
            </span>
          )}
          {snapshotVersion != null && (
            <span className="text-xs text-emerald-800/80 dark:text-emerald-300/80">
              · record v{snapshotVersion}
            </span>
          )}
        </div>
        <p className="text-sm text-emerald-900 dark:text-emerald-100">
          Finalized clinical record — read-only. The original record is
          preserved. Corrections and amendments will be added without changing
          it.
        </p>
      </section>
    );
  }

  // Legacy records (created before rollout) are never finalizable and must not be
  // presented as active native drafts. Neutral, non-actionable label only.
  if (recordOrigin === "legacy") {
    return (
      <section className="flex flex-col gap-1 rounded-lg border border-neutral-300 bg-neutral-50 p-5 dark:border-neutral-700 dark:bg-neutral-900/40">
        <span className="inline-flex w-fit items-center rounded-full bg-neutral-500 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-white">
          Legacy record
        </span>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          This visit predates clinical finalization. Its data is preserved
          unchanged; it is not a new draft and cannot be finalized here.
        </p>
      </section>
    );
  }

  function finalize() {
    setError(null);
    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("record_version", String(recordVersion));
    startTransition(async () => {
      const r = await finalizeSessionAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-300 p-5 dark:border-neutral-700">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
          Finalize clinical record
        </h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Finalizing captures a permanent, read-only snapshot of this visit.
          Corrections and amendments (a later phase) will preserve the original.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-neutral-500">Treatment areas</dt>
        <dd className="text-neutral-900 dark:text-neutral-100">{areasCount}</dd>
        <dt className="text-neutral-500">Passes / readings</dt>
        <dd className="text-neutral-900 dark:text-neutral-100">{passesCount}</dd>
        <dt className="text-neutral-500">Photos</dt>
        <dd className="text-neutral-900 dark:text-neutral-100">{photosCount}</dd>
        <dt className="text-neutral-500">Aftercare</dt>
        <dd className="text-neutral-900 dark:text-neutral-100">
          {aftercareExplained ? "Explained" : "Not marked"}
        </dd>
      </dl>

      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
        After finalizing, this record becomes <strong>read-only</strong>. You can
        still add corrections and amendments later — they never change the
        original.
      </div>

      <label className="flex items-start gap-2 text-sm text-neutral-800 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        <span>I confirm this accurately reflects the treatment performed.</span>
      </label>

      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={finalize}
          disabled={!confirmed || pending}
          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Finalizing…" : "Finalize & sign"}
        </button>
      </div>
    </section>
  );
}
