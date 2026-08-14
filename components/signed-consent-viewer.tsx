"use client";

import { useState } from "react";
import type { PractitionerSignatureSummary } from "@/lib/consent/queries";
import { reviewSignedRecord } from "@/lib/consent/signed-record";
import { FormattedDateTime } from "@/components/formatted-date-time";

// P1-A: the practitioner "View signed form" record. Renders the COMPLETE
// immutable signed consent: the exact form copy the client agreed to, the
// photo-consent choice, the typed signature, and the signed timestamp, never
// reducing it to a "Signed" badge and never exposing raw JSON. If the stored
// record is malformed/incomplete, it shows a visible review warning instead of
// implying the consent is valid.

type Props = {
  record: PractitionerSignatureSummary;
  formType: string;
  currentVersion: number;
};

export function SignedConsentViewer({ record, formType, currentVersion }: Props) {
  const [open, setOpen] = useState(false);
  const isPhoto = formType === "photo_consent";
  const review = reviewSignedRecord(record, formType);
  const outdated = record.template_version < currentVersion;

  // Human photo-consent line: prefer the label snapshotted at sign time; fall
  // back to a plain phrasing of the stored response.
  const photoLine =
    record.response_label_snapshot ??
    (record.response === "denied"
      ? "Client did NOT consent to photo use."
      : record.response === "accepted"
        ? "Client consented to photo use."
        : null);

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-[11px] font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900 dark:text-blue-300"
      >
        {open ? "Hide signed form" : "View signed form"}
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-neutral-300 bg-white p-3 text-sm dark:border-neutral-700 dark:bg-neutral-950">
          {!review.ok && (
            <p
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
            >
              ⚠ {review.warning}
            </p>
          )}

          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-neutral-900 dark:text-neutral-100">
              {record.template_title_snapshot}
            </p>
            <span className="text-[11px] text-neutral-500">
              v{record.template_version}
              {outdated && (
                <span className="text-amber-700 dark:text-amber-300">
                  {" · "}re-sign needed (current v{currentVersion})
                </span>
              )}
            </span>
          </div>

          {isPhoto && photoLine && (
            <p
              className={
                record.response === "denied"
                  ? "rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                  : "rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200"
              }
            >
              Photo consent: {photoLine}
            </p>
          )}

          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
              Form the client agreed to
            </p>
            <p className="whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-[13px] text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-200">
              {record.template_body_snapshot}
            </p>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] text-neutral-700 dark:text-neutral-300">
            <dt className="text-neutral-500">Signed by</dt>
            <dd>{record.signature_name}</dd>
            <dt className="text-neutral-500">Signed</dt>
            <dd>
              <FormattedDateTime iso={record.signed_at} />
            </dd>
            {record.template_hash && (
              <>
                <dt className="text-neutral-500">Integrity</dt>
                <dd className="tabular-nums text-[11px] text-neutral-500">
                  {record.template_hash.slice(0, 16)}…
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
