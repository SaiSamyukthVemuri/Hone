"use client";

import { useState, useTransition } from "react";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  getIntakeLinkAction,
  resendIntakeEmailAction,
} from "./actions";

type IntakeRow = {
  id: string;
  status: "in_progress" | "submitted" | "reviewed";
  started_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  requested_at: string | null;
  requested_by_name: string | null;
  isLatest: boolean;
};

type Props = {
  clientId: string;
  rows: IntakeRow[];
  clientHasEmail: boolean;
};

// Read-only list of every non-deleted intake for the client, newest
// first. The first row is tagged "Current"; later rows are visible so
// the practitioner can audit reissues and reach prior submitted
// intakes via the View action. Copy link / Resend email are exposed
// ONLY for in_progress rows; submitted/reviewed rows show neither.
export function IntakeHistoryList({ clientId, rows, clientHasEmail }: Props) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
        Intake history
      </h2>
      <ul className="mt-3 flex flex-col gap-3">
        {rows.map((row) => (
          <IntakeHistoryRow
            key={row.id}
            row={row}
            clientId={clientId}
            clientHasEmail={clientHasEmail}
          />
        ))}
      </ul>
    </section>
  );
}

function IntakeHistoryRow({
  row,
  clientId,
  clientHasEmail,
}: {
  row: IntakeRow;
  clientId: string;
  clientHasEmail: boolean;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resentAt, setResentAt] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  function fetchLink() {
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("intake_id", row.id);
    setError(null);
    startTransition(async () => {
      const res = await getIntakeLinkAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setLink(res.intakeUrl);
    });
  }

  function copy() {
    if (!link) return;
    void navigator.clipboard.writeText(link).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setError("Copy failed."),
    );
  }

  function resend() {
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("intake_id", row.id);
    setError(null);
    startTransition(async () => {
      const res = await resendIntakeEmailAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResentAt(Date.now());
      setTimeout(() => setResentAt(null), 3000);
    });
  }

  const statusLabel: Record<IntakeRow["status"], string> = {
    in_progress: "In progress",
    submitted: "Submitted",
    reviewed: "Reviewed",
  };

  return (
    <li className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusChipClass(row.status)}`}
          >
            {statusLabel[row.status]}
          </span>
          {row.isLatest && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
              Current
            </span>
          )}
        </div>
        <a
          href={`/clients/${clientId}/intake?intake=${row.id}`}
          className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
        >
          View →
        </a>
      </div>
      <div className="flex flex-col gap-0.5 text-xs text-neutral-600 dark:text-neutral-400">
        <span>
          Started <FormattedDateTime iso={row.started_at} />
          {row.requested_at && row.requested_by_name
            ? ` · requested by ${row.requested_by_name}`
            : row.requested_at
              ? " · practitioner-requested"
              : ""}
        </span>
        {row.submitted_at && (
          <span>
            Submitted <FormattedDateTime iso={row.submitted_at} />
          </span>
        )}
        {row.reviewed_at && (
          <span>
            Reviewed <FormattedDateTime iso={row.reviewed_at} />
            {row.reviewed_by_name ? ` by ${row.reviewed_by_name}` : ""}
          </span>
        )}
      </div>
      {row.status === "in_progress" && (
        <div className="flex flex-col gap-2 pt-1">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={fetchLink}
              disabled={isPending}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
            >
              {link ? "Regenerate link" : "Get link"}
            </button>
            {link && (
              <button
                type="button"
                onClick={copy}
                disabled={isPending}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            )}
            <button
              type="button"
              onClick={resend}
              disabled={isPending || !clientHasEmail}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
              title={
                clientHasEmail
                  ? undefined
                  : "No email on file for this client"
              }
            >
              Resend email
            </button>
          </div>
          {link && (
            <p className="break-all text-[11px] text-neutral-500">{link}</p>
          )}
          {resentAt !== null && (
            <p className="text-[11px] text-emerald-700">Email sent.</p>
          )}
          {error && (
            <p className="text-[11px] text-red-700" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function statusChipClass(status: IntakeRow["status"]): string {
  switch (status) {
    case "reviewed":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200";
    case "submitted":
      return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200";
    case "in_progress":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
  }
}
