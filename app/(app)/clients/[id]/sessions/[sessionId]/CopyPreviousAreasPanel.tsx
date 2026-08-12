"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  buildCopyDrafts,
  draftToCopyInput,
  type CopyAreaDraft,
} from "@/lib/sessions/whole-session-copy";
import { fastChartUrl, landingBlockId } from "@/lib/sessions/fast-chart-start";
import { CopyDraftCard } from "@/components/copy-draft-card";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  getWholeSessionCopySourceAction,
  commitWholeSessionCopyAction,
  type WholeSessionCopyCommitResult,
} from "./whole-session-copy-actions";

// Is there a visit date worth showing at all? Only a parseable timestamp gets a
// line; the FORMATTING itself belongs to FormattedDateTime.
function hasVisitDate(iso: string | null | undefined): boolean {
  return typeof iso === "string" && !Number.isNaN(Date.parse(iso));
}

// The source visit's date, rendered through Hone's canonical instant renderer.
//
// WHY NOT toLocaleDateString HERE: a session's started_at is an INSTANT, and
// this is a Client Component — Next renders it on the server too. A
// runtime-default locale therefore produces one string in Node and a different
// one in an fr-CA browser, which is a React hydration mismatch on a clinical
// screen (caught by the fr-CA charting probe in e2e/point-of-care-memory.spec.ts).
// FormattedDateTime is the existing answer: SSR renders nothing, the browser
// fills in its own local rendering on mount. See lib/clinical-notes/clinical-date.ts
// for the same hazard on CIVIL dates, which are pinned to en-CA + UTC instead.
function VisitDate({ iso }: { iso: string | null }) {
  return <FormattedDateTime iso={iso ?? ""} format="date" />;
}

// Whole-session "Copy areas and settings from last session" (migration 0157),
// with the repeat-client FAST PATH ("Start from last session") as the primary
// action.
//
// TWO ROUTES, ONE AUTHORITY. Both routes run the SAME governed pipeline —
// loadSource() (server-derived source + fingerprint) -> buildCopyDrafts ->
// commitDrafts() -> draftToCopyInput -> the server normalizer ->
// copy_session_setup. There is exactly ONE call site for the read action and
// exactly ONE for the commit action, so the fast path and the preview path
// cannot drift into two copy implementations.
//
//   * START FROM LAST SESSION (primary) — one interaction. The reusable setup
//     the previous visit already recorded is brought forward and the page lands
//     the practitioner directly in TODAY'S editor for the first copied area.
//     Nothing is previewed because nothing is invented: the payload is a pure
//     function of the source the server chose.
//   * PREVIEW FIRST (secondary) — the original draft-review flow, unchanged.
//     The preview is EPHEMERAL (component state only); building, refreshing,
//     cancelling or removing a card performs NO clinical write.
//
// SAFETY, identical on both routes: the SOURCE session and its fingerprint are
// SERVER-derived; the browser only echoes them back at commit so the server can
// reject a stale source. The copy is SETUP-ONLY — minutes performed, hairs,
// observations, reaction, tolerance, notes and every other outcome are never
// copied, so today's clinical facts start blank and record only what happens
// today.

type Phase = "idle" | "preview";

const NOTHING_TO_COPY = "There's nothing from a previous visit to copy here.";
const NO_AREAS = "Last session has no areas to copy.";
const TRANSPORT_ERROR = "Couldn't reach the server. Check your connection and try again.";

// The server-derived source plus the drafts built from it. EPHEMERAL — holding
// this performs no write.
type LoadedSource =
  | {
      ok: true;
      drafts: CopyAreaDraft[];
      sourceSessionId: string;
      sourceFingerprint: string;
      sourceStartedAt: string | null;
    }
  | { ok: false; error: string };

export function CopyPreviousAreasPanel({
  clientId,
  sessionId,
  sourceStartedAt: knownSourceStartedAt = null,
}: {
  clientId: string;
  sessionId: string;
  // The canonical source visit date, already resolved by the page's descriptor
  // read. Shown on the idle card so the practitioner knows WHICH visit the fast
  // path will bring forward without having to open a preview to find out.
  sourceStartedAt?: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [drafts, setDrafts] = useState<CopyAreaDraft[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const [sourceSessionId, setSourceSessionId] = useState<string | null>(null);
  const [sourceFingerprint, setSourceFingerprint] = useState<string | null>(null);
  const [sourceStartedAt, setSourceStartedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [committing, startCommit] = useTransition();
  const [fastStarting, startFast] = useTransition();

  // At-most-once guard for the fast path. A ref is written SYNCHRONOUSLY, so a
  // genuine double-click whose two handlers run in the same tick — before React
  // has re-rendered the button as disabled — issues exactly ONE request.
  const fastInFlightRef = useRef(false);

  // Idempotency keys for the fast path, keyed by the source revision they were
  // minted for. The fast payload is a PURE function of (source session, source
  // fingerprint) — nothing is edited on this route — so a retry after a lost
  // response re-derives a byte-identical request, matches the ledger's stored
  // request hash, and REPLAYS (same created ids, zero new rows) instead of
  // being rejected as ambiguous. A source that changed produces a different
  // fingerprint and therefore a fresh key, so a changed source can never replay
  // under a key minted for the old one. This reuses the existing 0157 ledger
  // (unique on target_session_id + idempotency_key); it adds no new persistence.
  const fastKeysRef = useRef<Map<string, string>>(new Map());
  function fastStartKey(source: string, fingerprint: string): string {
    const signature = `${source}:${fingerprint}`;
    const existing = fastKeysRef.current.get(signature);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    fastKeysRef.current.set(signature, minted);
    return minted;
  }

  // The ONE read path. READ-ONLY: it creates nothing. The DB derives the
  // canonical eligible previous session and its fingerprint; the browser gets
  // neither choice nor authority over which session is copied.
  async function loadSource(): Promise<LoadedSource> {
    const res = await getWholeSessionCopySourceAction({ clientId, sessionId });
    if (!res.ok) return { ok: false, error: res.error };
    if (!res.eligible || !res.sourceSessionId || !res.sourceFingerprint) {
      return { ok: false, error: NOTHING_TO_COPY };
    }
    const built = buildCopyDrafts(res.source);
    if (built.length === 0) return { ok: false, error: NO_AREAS };
    return {
      ok: true,
      drafts: built,
      sourceSessionId: res.sourceSessionId,
      sourceFingerprint: res.sourceFingerprint,
      sourceStartedAt: res.sourceStartedAt,
    };
  }

  // The ONE write path. Both routes funnel through here, so the setup-only
  // payload, the server-side normalization and the atomic RPC are identical
  // whichever button was pressed.
  //
  // A TRANSPORT failure (dropped connection, server action never answered) is
  // turned into an ordinary failed result rather than an unhandled rejection, so
  // the practitioner always sees something instead of a button that silently did
  // nothing. Retrying is safe: the fast path reuses its source-derived
  // idempotency key, so a request that DID land replays rather than duplicating.
  async function commitDrafts(args: {
    drafts: readonly CopyAreaDraft[];
    idempotencyKey: string;
    sourceSessionId: string | null;
    sourceFingerprint: string | null;
  }): Promise<WholeSessionCopyCommitResult> {
    try {
      return await commitWholeSessionCopyAction({
        clientId,
        sessionId,
        drafts: args.drafts.map(draftToCopyInput),
        idempotencyKey: args.idempotencyKey,
        sourceSessionId: args.sourceSessionId,
        sourceFingerprint: args.sourceFingerprint,
      });
    } catch {
      // Never surfaces the underlying error text — the server action's own
      // mapped messages are the only vocabulary this panel speaks.
      return { ok: false, error: TRANSPORT_ERROR };
    }
  }

  // PRIMARY: bring the reusable setup forward and land in today's editor. One
  // interaction — no preview, no confirm, no scroll-and-reopen.
  function startFromLastSession() {
    if (fastInFlightRef.current) return; // at-most-once per click burst
    fastInFlightRef.current = true;
    setError(null);
    startFast(async () => {
      try {
        const loaded = await loadSource();
        if (!loaded.ok) {
          setError(loaded.error);
          return;
        }
        const res = await commitDrafts({
          drafts: loaded.drafts,
          idempotencyKey: fastStartKey(loaded.sourceSessionId, loaded.sourceFingerprint),
          sourceSessionId: loaded.sourceSessionId,
          sourceFingerprint: loaded.sourceFingerprint,
        });
        if (!res.ok) {
          // Fail CLOSED and truthfully — a changed source is reported, never
          // silently copied stale. Pressing the button again re-reads the
          // source, so recovery is one tap.
          setError(res.error);
          return;
        }
        // The RPC already returns the authoritative created ids (and the SAME
        // ids on an idempotent replay), so the landing area needs no derivation
        // and no schema change. Routing with it re-renders the chart from the
        // server AND tells it which editor to open.
        const landing = landingBlockId(res.createdBlockIds);
        if (landing) router.replace(fastChartUrl(clientId, sessionId, landing));
        else router.refresh();
      } finally {
        fastInFlightRef.current = false;
      }
    });
  }

  // SECONDARY: build (or refresh) the preview. READ-ONLY: no clinical rows are
  // created. A fresh idempotency key is minted per build because preview drafts
  // are EDITABLE — the payload is not a pure function of the source, so it must
  // not share a key with a differently-edited request.
  function buildPreview() {
    setError(null);
    startLoad(async () => {
      const loaded = await loadSource();
      if (!loaded.ok) {
        setError(loaded.error);
        return;
      }
      setDrafts(loaded.drafts);
      setSourceSessionId(loaded.sourceSessionId);
      setSourceFingerprint(loaded.sourceFingerprint);
      setSourceStartedAt(loaded.sourceStartedAt);
      setIdempotencyKey(crypto.randomUUID());
      setPhase("preview");
    });
  }

  // All of these are pure client-state changes — they write nothing.
  function removeDraft(key: string) {
    setDrafts((d) => d.filter((x) => x.key !== key));
  }
  function updateDraft(next: CopyAreaDraft) {
    setDrafts((d) => d.map((x) => (x.key === next.key ? next : x)));
  }
  function cancel() {
    setDrafts([]);
    setIdempotencyKey("");
    setSourceSessionId(null);
    setSourceFingerprint(null);
    setSourceStartedAt(null);
    setError(null);
    setPhase("idle");
  }

  // The reviewed-preview write. Sends the reviewed, setup-only draft (validated
  // server-side) plus the server's source id + fingerprint.
  function commit() {
    if (drafts.length === 0) return;
    setError(null);
    startCommit(async () => {
      const res = await commitDrafts({
        drafts,
        idempotencyKey,
        sourceSessionId,
        sourceFingerprint,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Reviewed copies land in today's editor too — the reopen loop is gone on
      // both routes.
      const landing = landingBlockId(res.createdBlockIds);
      cancel();
      if (landing) router.replace(fastChartUrl(clientId, sessionId, landing));
      else router.refresh();
    });
  }

  if (phase === "idle") {
    const busy = fastStarting || loading;
    return (
      <div className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <span className="font-medium">Start from last session</span>
        {/* The prose stays date-free on purpose: the visit date is an instant
            that only the browser can render, so interpolating it into a
            sentence would leave a gap in the server-rendered pass. It gets its
            own line below instead. */}
        <span className="text-neutral-600 dark:text-neutral-400">
          Brings forward the treatment areas and machine settings from the
          previous visit, then opens today&apos;s chart ready to edit.
          Today&apos;s minutes, hairs, observations and notes start blank.
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={startFromLastSession}
            disabled={busy}
            data-testid="copy-previous-fast-start"
            className="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {fastStarting ? "Starting…" : "Start from last session"}
          </button>
          <button
            type="button"
            onClick={buildPreview}
            disabled={busy}
            data-testid="copy-previous-preview"
            className="rounded-md border border-neutral-300 px-4 py-2 font-medium hover:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
          >
            {loading ? "Loading…" : "Preview first"}
          </button>
        </div>
        {hasVisitDate(knownSourceStartedAt) && (
          <span
            className="text-xs text-neutral-500"
            data-testid="copy-previous-idle-source-date"
          >
            From the visit on <VisitDate iso={knownSourceStartedAt} />
          </span>
        )}
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
        {hasVisitDate(sourceStartedAt) && (
          <span className="text-xs text-neutral-500" data-testid="copy-previous-source-date">
            From the visit on <VisitDate iso={sourceStartedAt} />
          </span>
        )}
        <span className="text-neutral-600 dark:text-neutral-400">
          {drafts.length} area{drafts.length === 1 ? "" : "s"} ready. This is a
          preview only — nothing is saved yet. Edit anything below; machine
          settings copy over, but today&apos;s minutes start blank. Remove any you
          don&apos;t want, then confirm.
        </span>
      </div>

      <ul className="flex flex-col gap-3">
        {drafts.map((d) => (
          <CopyDraftCard
            key={d.key}
            draft={d}
            onChange={updateDraft}
            onRemove={() => removeDraft(d.key)}
          />
        ))}
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
