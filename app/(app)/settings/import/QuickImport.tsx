"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button, buttonClasses } from "@/components/ui/button";
import { fieldControlClass } from "@/components/ui/field";
import {
  confirmImportAction,
  previewImportAction,
  type ConfirmSummary,
  type PreviewSummary,
} from "./actions";

const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "paper_card", label: "Paper cards" },
  { value: "spreadsheet", label: "Spreadsheet" },
  { value: "jane", label: "Jane" },
  { value: "fresha", label: "Fresha" },
  { value: "other", label: "Other" },
];

// UI0: the file-local BTN / BTN_PRIMARY / BTN_SECONDARY constants that used to
// live here are gone. They were one of ~seven such private button systems in
// the tree; components/ui/button.tsx now owns the shape, the 44px floor and
// the focus ring for all of them.

export function QuickImport({ template }: { template: string }) {
  const [text, setText] = useState("");
  const [sourceType, setSourceType] = useState("paper_card");
  const [preview, setPreview] = useState<PreviewSummary | null>(null);
  const [summary, setSummary] = useState<ConfirmSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setText("");
    setPreview(null);
    setSummary(null);
    setError(null);
  }

  function onPreview() {
    setError(null);
    setSummary(null);
    startTransition(async () => {
      const res = await previewImportAction(text);
      if (res.ok) setPreview(res.preview);
      else {
        setPreview(null);
        setError(res.error);
      }
    });
  }

  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const res = await confirmImportAction(text, sourceType);
      if (res.ok) {
        setSummary(res.summary);
        setPreview(null);
      } else {
        setError(res.error);
      }
    });
  }

  async function onCopyTemplate() {
    try {
      await navigator.clipboard.writeText(template);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  if (summary) {
    return <ImportSummaryView summary={summary} onDone={reset} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onCopyTemplate}>
          {copied ? "Template copied" : "Copy template"}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">Source</span>
          <select
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value)}
            className={fieldControlClass({ fullWidth: false })}
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <label htmlFor="import-text" className="sr-only">
          Paste CSV or TSV rows
        </label>
        <textarea
          id="import-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder="Paste rows from Google Sheets, Excel, or a CSV/TSV file (include the header row)…"
          className={fieldControlClass({ className: "font-mono shadow-sm" })}
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button
          onClick={onPreview}
          disabled={text.trim().length === 0}
          pending={isPending && !preview}
          busyLabel="Reading…"
        >
          Preview import
        </Button>
        {preview ? (
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={preview.readyGroups + preview.warningGroups === 0}
            pending={isPending}
            busyLabel="Importing…"
          >
            Confirm import
          </Button>
        ) : null}
        {(preview || text) && (
          <Button onClick={reset}>Cancel</Button>
        )}
      </div>

      {preview ? <PreviewView preview={preview} /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-neutral-500">{label}</div>
    </div>
  );
}

function StatusChip({ action }: { action: PreviewSummary["groups"][number]["action"] }) {
  const map = {
    create: { text: "Create", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" },
    warning: { text: "Review", cls: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
    skip_duplicate: { text: "Skip (existing)", cls: "bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400" },
  } as const;
  const m = map[action];
  return <span className={`rounded px-1.5 py-0.5 text-xs ${m.cls}`}>{m.text}</span>;
}

function PreviewView({ preview }: { preview: PreviewSummary }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
        <Stat label="Source rows" value={preview.totalSourceRows} />
        <Stat label="Clients" value={preview.groupedClients} />
        <Stat label="Ready" value={preview.readyGroups} />
        <Stat label="To review" value={preview.warningGroups} />
        <Stat label="Duplicates" value={preview.duplicateGroups} />
        <Stat label="Memories" value={preview.memoriesToCreate} />
      </div>

      {preview.capped ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          Showing the first {preview.totalSourceRows} of {preview.totalDataRows}{" "}
          rows. Import in smaller batches to bring over the rest.
        </p>
      ) : null}

      {preview.errorRows > 0 ? (
        <p className="text-xs text-red-700 dark:text-red-300">
          {preview.errorRows} row(s) have no usable name and will not be imported.
        </p>
      ) : null}

      {preview.treatmentAreas.length > 0 ? (
        <p className="text-xs text-neutral-500">
          Treatment areas detected: {preview.treatmentAreas.join(", ")}
        </p>
      ) : null}

      {preview.ignoredColumns.length > 0 ? (
        <p className="text-xs text-neutral-500">
          Ignored columns: {preview.ignoredColumns.join(", ")}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {preview.groups.map((g, i) => (
          <li
            key={`${g.fullName}-${i}`}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
          >
            <span className="font-medium">{g.fullName || "(no name)"}</span>
            <StatusChip action={g.action} />
            {g.memoryRowCount > 0 ? (
              <span className="text-xs text-neutral-500">
                {g.memoryRowCount} memory row(s)
              </span>
            ) : null}
            {g.treatmentAreas.length > 0 ? (
              <span className="text-xs text-neutral-500">
                · {g.treatmentAreas.join(", ")}
              </span>
            ) : null}
            {g.warnings.map((w, wi) => (
              <span key={wi} className="text-xs text-amber-700 dark:text-amber-300">
                · {w}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImportSummaryView({
  summary,
  onDone,
}: {
  summary: ConfirmSummary;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div
        role="status"
        className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
      >
        Import complete.
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Clients created" value={summary.clientsCreated} />
        <Stat label="Memories created" value={summary.memoriesCreated} />
        <Stat label="Duplicates skipped" value={summary.duplicatesSkipped} />
        <Stat label="Not imported" value={summary.rowsNotImported} />
      </div>
      <p className="text-xs text-neutral-500">
        Imported history is recorded as imported memory, not charted live in
        Hone.
      </p>
      {summary.createdClients.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Created clients</h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {summary.createdClients.map((c) => (
              <li key={c.id}>
                <Link href={`/clients/${c.id}`} className="underline">
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button onClick={onDone}>Import more</Button>
        <Link href="/clients" className={buttonClasses({ variant: "primary" })}>
          View clients
        </Link>
      </div>
    </div>
  );
}
