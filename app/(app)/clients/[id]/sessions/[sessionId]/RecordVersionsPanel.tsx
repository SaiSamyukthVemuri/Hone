"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { amendSessionAction, correctSessionAction } from "./correction-actions";

// Clinical Record — Phase 2. Rendered only for a NATIVE, FINALIZED session when the
// studio-scoped `clinical_corrections_enabled` flag is on. Three tabs:
//   * History — original version, correction versions, and amendments in order; the
//     current authoritative version is marked; the original is always listed. No raw
//     snapshot JSON is ever shown.
//   * Amend   — appends information that was missing (does NOT change the original).
//   * Correct — creates a NEW version by fixing a recorded value (before/after, with
//     an optimistic-concurrency token). The original is preserved.

type VersionRow = {
  version_no: number;
  version_type: "original" | "correction";
  finalized_at: string;
  corrected_by_display_name: string | null;
  correction_reason: string | null;
  is_current: boolean;
};
type AmendmentRow = {
  id: string;
  amendment_type: string;
  reason: string;
  body: string | null;
  authored_by_display_name: string | null;
  authored_at: string;
  applies_to_version: number | null;
};
// The correctable session-level fields, with their current values (the "before").
type SessionFields = {
  session_notes: string | null;
  next_session_note: string | null;
  modality: string | null;
};

type Props = {
  sessionId: string;
  clientId: string;
  recordVersion: number;
  currentSnapshotId: string | null;
  versions: VersionRow[];
  amendments: AmendmentRow[];
  sessionFields: SessionFields;
};

const AMENDMENT_TYPES: { value: string; label: string }[] = [
  { value: "late_note", label: "Late clinical note" },
  { value: "clarification", label: "Clarification" },
  { value: "missing_detail", label: "Missing detail" },
  { value: "other", label: "Other" },
];

const CORRECTABLE_FIELDS: { key: keyof SessionFields; label: string }[] = [
  { key: "session_notes", label: "Session notes" },
  { key: "next_session_note", label: "Next-visit note" },
  { key: "modality", label: "Modality" },
];

export function RecordVersionsPanel({
  sessionId,
  clientId,
  recordVersion,
  currentSnapshotId,
  versions,
  amendments,
  sessionFields,
}: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<"history" | "amend" | "correct">("history");

  const timeline = useMemo(() => {
    const items: { kind: "version" | "amendment"; at: string; node: React.ReactNode }[] = [];
    for (const v of versions) {
      items.push({
        kind: "version",
        at: v.finalized_at,
        node: (
          <div key={`v${v.version_no}`} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-neutral-800 px-2 py-0.5 text-xs font-semibold text-white dark:bg-neutral-200 dark:text-neutral-900">
                {v.version_type === "original" ? "Original" : `Correction v${v.version_no}`}
              </span>
              {v.is_current && (
                <span className="inline-flex items-center rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">
                  Current
                </span>
              )}
              <span className="text-xs text-neutral-500">{new Date(v.finalized_at).toLocaleString()}</span>
            </div>
            {v.version_type === "correction" && (
              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                {v.corrected_by_display_name ? `${v.corrected_by_display_name} · ` : ""}
                Reason: {v.correction_reason}
              </p>
            )}
          </div>
        ),
      });
    }
    for (const a of amendments) {
      items.push({
        kind: "amendment",
        at: a.authored_at,
        node: (
          <div key={`a${a.id}`} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white">
                Amendment · {a.amendment_type.replace(/_/g, " ")}
              </span>
              {a.applies_to_version != null && (
                <span className="text-xs text-neutral-500">on v{a.applies_to_version}</span>
              )}
              <span className="text-xs text-neutral-500">{new Date(a.authored_at).toLocaleString()}</span>
            </div>
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              {a.authored_by_display_name ? `${a.authored_by_display_name} · ` : ""}Reason: {a.reason}
            </p>
            {a.body && (
              <p className="whitespace-pre-wrap text-sm text-neutral-900 dark:text-neutral-100">{a.body}</p>
            )}
          </div>
        ),
      });
    }
    return items.sort((x, y) => x.at.localeCompare(y.at));
  }, [versions, amendments]);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-300 p-5 dark:border-neutral-700">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
          Corrections & amendments
        </h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          The finalized record is preserved. An amendment adds missing information; a
          correction creates a new version that supersedes the current one — the
          original is always kept.
        </p>
      </div>

      <div className="flex gap-2 text-sm">
        {(["history", "amend", "correct"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              tab === t
                ? "rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-white dark:bg-white dark:text-neutral-900"
                : "rounded-md border border-neutral-300 px-3 py-1.5 text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
            }
          >
            {t === "history" ? "Version history" : t === "amend" ? "Amend record" : "Correct a mistake"}
          </button>
        ))}
      </div>

      {tab === "history" && (
        <ol className="flex flex-col gap-3">
          {timeline.map((it, i) => (
            <li key={i} className="border-l-2 border-neutral-200 pl-3 dark:border-neutral-800">
              {it.node}
            </li>
          ))}
        </ol>
      )}

      {tab === "amend" && (
        <AmendForm
          sessionId={sessionId}
          clientId={clientId}
          currentSnapshotId={currentSnapshotId}
          onDone={() => {
            setTab("history");
            router.refresh();
          }}
        />
      )}

      {tab === "correct" && (
        <CorrectForm
          sessionId={sessionId}
          clientId={clientId}
          recordVersion={recordVersion}
          sessionFields={sessionFields}
          onDone={() => {
            setTab("history");
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

function AmendForm({
  sessionId,
  clientId,
  currentSnapshotId,
  onDone,
}: {
  sessionId: string;
  clientId: string;
  currentSnapshotId: string | null;
  onDone: () => void;
}) {
  const [type, setType] = useState("late_note");
  const [reason, setReason] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    if (!currentSnapshotId) {
      setError("No finalized version to amend.");
      return;
    }
    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("applies_to_snapshot_id", currentSnapshotId);
    fd.set("amendment_type", type);
    fd.set("reason", reason);
    fd.set("body", body);
    startTransition(async () => {
      const r = await amendSessionAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Appends information that was missing. This does <strong>not</strong> change or
        overwrite anything already recorded.
      </p>
      <label className="text-sm">
        <span className="mb-1 block text-neutral-500">Type</span>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
        >
          {AMENDMENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-neutral-500">Reason (required)</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-neutral-500">Information to append</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>
      {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={pending || reason.trim().length === 0 || body.trim().length === 0}
        className="w-fit rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Adding…" : "Add amendment"}
      </button>
    </div>
  );
}

function CorrectForm({
  sessionId,
  clientId,
  recordVersion,
  sessionFields,
  onDone,
}: {
  sessionId: string;
  clientId: string;
  recordVersion: number;
  sessionFields: SessionFields;
  onDone: () => void;
}) {
  const [field, setField] = useState<keyof SessionFields>("session_notes");
  const before = sessionFields[field] ?? "";
  const [after, setAfter] = useState<string>(before);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("expected_record_version", String(recordVersion));
    fd.set("reason", reason);
    fd.set("payload", JSON.stringify({ session: { [field]: after === "" ? null : after } }));
    startTransition(async () => {
      const r = await correctSessionAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Fixes a value that was recorded incorrectly. This creates a{" "}
        <strong>new version</strong> — the current version{" "}
        <span className="tabular-nums">v{recordVersion}</span> is preserved.
      </p>
      <label className="text-sm">
        <span className="mb-1 block text-neutral-500">Field to correct</span>
        <select
          value={field}
          onChange={(e) => {
            const k = e.target.value as keyof SessionFields;
            setField(k);
            setAfter(sessionFields[k] ?? "");
          }}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
        >
          {CORRECTABLE_FIELDS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="text-sm">
          <span className="mb-1 block text-neutral-500">Before (current)</span>
          <p className="min-h-[42px] whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-300">
            {before || <span className="text-neutral-400">—</span>}
          </p>
        </div>
        <label className="text-sm">
          <span className="mb-1 block text-neutral-500">After (corrected)</span>
          <textarea
            value={after}
            onChange={(e) => setAfter(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      </div>
      <label className="text-sm">
        <span className="mb-1 block text-neutral-500">Correction reason (required)</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>
      {error && <p className="text-xs text-red-700" role="alert">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={pending || reason.trim().length === 0 || after === before}
        className="w-fit rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Creating new version…" : "Correct & create new version"}
      </button>
    </div>
  );
}
