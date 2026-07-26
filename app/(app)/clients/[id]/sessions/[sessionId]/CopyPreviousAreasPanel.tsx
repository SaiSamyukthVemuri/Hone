"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  buildCopyDrafts,
  draftToCopySpec,
  type CopyAreaDraft,
} from "@/lib/sessions/whole-session-copy";
import {
  getWholeSessionCopySourceAction,
  commitWholeSessionCopyAction,
} from "./whole-session-copy-actions";

// Whole-session "Copy areas and settings from last session" (migration 0157).
//
// SAFETY: the preview is EPHEMERAL — it lives only in this component's state.
// Building, refreshing, cancelling, or removing a draft card performs NO
// clinical write (no blocks, areas, entries, operations, audit or metric rows).
// Only the single explicit "Add these areas to today's chart" action writes,
// via the atomic + idempotent copy_session_setup RPC. The idempotency key is
// generated once per preview build, so a double-submit is an at-most-once no-op.

type Phase = "idle" | "preview";

export function CopyPreviousAreasPanel({
  clientId,
  sessionId,
  previousSessionId,
}: {
  clientId: string;
  sessionId: string;
  previousSessionId: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [drafts, setDrafts] = useState<CopyAreaDraft[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [committing, startCommit] = useTransition();

  // Build (or refresh) the preview from the previous session. READ-ONLY: no
  // clinical rows are created. A fresh idempotency key is minted per build.
  function buildPreview() {
    setError(null);
    startLoad(async () => {
      const res = await getWholeSessionCopySourceAction({
        clientId,
        sessionId,
        previousSessionId,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const built = buildCopyDrafts(res.source);
      if (built.length === 0) {
        setError("Last session has no areas to copy.");
        return;
      }
      setDrafts(built);
      setIdempotencyKey(crypto.randomUUID());
      setPhase("preview");
    });
  }

  // All of these are pure client-state changes — they write nothing.
  function removeDraft(key: string) {
    setDrafts((d) => d.filter((x) => x.key !== key));
  }
  function cancel() {
    setDrafts([]);
    setIdempotencyKey("");
    setError(null);
    setPhase("idle");
  }

  // The ONE explicit write. Sends the reviewed, setup-only specs to the RPC.
  function commit() {
    if (drafts.length === 0) return;
    setError(null);
    startCommit(async () => {
      const res = await commitWholeSessionCopyAction({
        clientId,
        sessionId,
        specs: drafts.map(draftToCopySpec),
        idempotencyKey,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      cancel();
      router.refresh(); // reload the chart to show the newly-created areas
    });
  }

  if (phase === "idle") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <span className="font-medium">Copy areas &amp; settings from last session</span>
        <span className="text-neutral-600 dark:text-neutral-400">
          Review each area first — nothing is added to today&apos;s chart until you
          confirm.
        </span>
        <button
          type="button"
          onClick={buildPreview}
          disabled={loading}
          data-testid="copy-previous-preview"
          className="self-start rounded-md border border-neutral-300 px-4 py-2 font-medium hover:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
        >
          {loading ? "Loading…" : "Preview last session's areas"}
        </button>
        {error && (
          <span role="alert" className="text-red-600 dark:text-red-400">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="copy-previous-preview-panel"
      className="flex flex-col gap-3 rounded-md border border-neutral-300 bg-white px-4 py-4 text-sm dark:border-neutral-700 dark:bg-neutral-950"
    >
      <div className="flex flex-col gap-1">
        <span className="font-medium">Preview — copy from last session</span>
        <span className="text-neutral-600 dark:text-neutral-400">
          {drafts.length} area{drafts.length === 1 ? "" : "s"} ready. This is a
          preview only — nothing is saved yet. Remove any you don&apos;t want,
          then confirm.
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {drafts.map((d) => {
          const areaLabel =
            d.areas.length > 0
              ? d.areas
                  .map((a) =>
                    a.laterality && a.laterality !== "not_applicable"
                      ? `${a.laterality} ${a.area}`
                      : a.area,
                  )
                  .join(", ")
              : (d.primaryArea ?? "Area");
          const setupBits = [
            d.setup.mode,
            d.setup.machineFrequency,
            d.setup.energyLevel ? `EL ${d.setup.energyLevel}` : "",
            d.setup.minutes ? `${d.setup.minutes} min` : "",
          ].filter(Boolean);
          return (
            <li
              key={d.key}
              data-testid={`copy-draft-${d.key}`}
              className="flex items-start justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{areaLabel}</span>
                {setupBits.length > 0 && (
                  <span className="text-xs text-neutral-500">
                    {setupBits.join(" · ")}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeDraft(d.key)}
                data-testid={`copy-draft-remove-${d.key}`}
                className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:border-neutral-500 dark:border-neutral-700"
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      {error && (
        <span role="alert" className="text-red-600 dark:text-red-400">
          {error}
        </span>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={commit}
          disabled={committing || drafts.length === 0}
          data-testid="copy-previous-commit"
          className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {committing ? "Adding…" : "Add these areas to today's chart"}
        </button>
        <button
          type="button"
          onClick={buildPreview}
          disabled={loading || committing}
          data-testid="copy-previous-refresh"
          className="rounded-md border border-neutral-300 px-4 py-2 hover:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={committing}
          data-testid="copy-previous-cancel"
          className="rounded-md border border-neutral-300 px-4 py-2 hover:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
