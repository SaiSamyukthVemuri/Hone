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
} from "./whole-session-copy-actions";

// Is there a visit date worth showing at all? Only a parseable timestamp gets a
// line; the FORMATTING itself belongs to FormattedDateTime.
function hasVisitDate(iso: string | null | undefined): boolean {
  return typeof iso === "string" && !Number.isNaN(Date.parse(iso));
}

// The source visit's date, rendered through Hone's canonical instant renderer.
//
// WHY NOT toLocaleDateString HERE: a session's started_at is an INSTANT, and
// this is a Client Component: Next renders it on the server too. A
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
// TWO ROUTES, ONE AUTHORITY. Both routes run the SAME governed pipeline,
// loadSource() (server-derived source + fingerprint) -> buildCopyDrafts ->
// submitCommit() -> draftToCopyInput -> the server normalizer ->
// copy_session_setup. There is exactly ONE call site for the read action and
// exactly ONE for the commit action, so the fast path and the preview path
// cannot drift into two copy implementations.
//
//   * START FROM LAST SESSION (primary), one interaction. The reusable setup
//     the previous visit already recorded is brought forward and the page lands
//     the practitioner directly in TODAY'S editor for the first copied area.
//     Nothing is previewed because nothing is invented: the payload is a pure
//     function of the source the server chose.
//   * PREVIEW FIRST (secondary), the original draft-review flow, unchanged.
//     The preview is EPHEMERAL (component state only); building, refreshing,
//     cancelling or removing a card performs NO clinical write.
//
// SAFETY, identical on both routes: the SOURCE session and its fingerprint are
// SERVER-derived; the browser only echoes them back at commit so the server can
// reject a stale source. The copy is SETUP-ONLY, minutes performed, hairs,
// observations, reaction, tolerance, notes and every other outcome are never
// copied, so today's clinical facts start blank and record only what happens
// today.
//
// THREE OUTCOMES, NOT TWO. A commit either succeeded, definitively failed, or
// its result is UNKNOWN because the response never arrived. Collapsing the third
// into the second is a real defect: the write may already have landed, so a
// retry must RE-SUBMIT THE SAME GOVERNED REQUEST rather than start over. See
// CommitOutcome and the ambiguous-recovery notes on startFromLastSession.

type Phase = "idle" | "preview";

const NOTHING_TO_COPY = "There's nothing from a previous visit to copy here.";
const NO_AREAS = "Last session has no areas to copy.";

// Truthful copy for an UNKNOWN outcome. It deliberately does NOT claim that
// nothing was written: at this point nobody knows, and saying "nothing was
// saved" about a copy that actually landed would be a lie on a clinical screen.
const AMBIGUOUS_MESSAGE =
  "We couldn't confirm whether the setup was added. Try again to check safely.";

// The server-derived source plus the drafts built from it. EPHEMERAL: holding
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

// Everything needed to re-submit the EXACT same governed request. Held in memory
// only while an attempt's outcome is unknown. Re-submitting this verbatim is what
// lets copy_session_setup recognise the retry: same target + same idempotency key
// + same request hash is an at-most-once REPLAY that returns the ids the first
// attempt created.
type RetryEnvelope = {
  drafts: CopyAreaDraft[];
  sourceSessionId: string;
  sourceFingerprint: string;
  idempotencyKey: string;
};

// The outcome of ONE commit attempt.
//   committed: the server answered: here is what exists (possibly a replay).
//   failed   : the server answered with a DEFINITIVE domain refusal. Every RPC
//               refusal path creates zero rows, so nothing was written.
//   unknown  , no answer arrived. The write may or may not have landed; only a
//               replay of the same request can settle it.
type CommitOutcome =
  | { kind: "committed"; createdBlockIds: string[]; idempotentReplay: boolean }
  | { kind: "failed"; error: string }
  | { kind: "unknown" };

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
  // True while an attempt's outcome is unknown. Drives the truthful copy and the
  // retry affordance; cleared by any DEFINITIVE outcome.
  const [ambiguous, setAmbiguous] = useState(false);
  const [loading, startLoad] = useTransition();
  const [committing, startCommit] = useTransition();
  const [fastStarting, startFast] = useTransition();

  // At-most-once guard for the fast path. A ref is written SYNCHRONOUSLY, so a
  // genuine double-click whose two handlers run in the same tick: before React
  // has re-rendered the button as disabled: issues exactly ONE request.
  const fastInFlightRef = useRef(false);

  // The retry envelope for an attempt whose outcome is unknown. A ref, not
  // state: it is read inside the transition callback, where a ref is always the
  // current value. Null whenever the last outcome was definitive.
  const pendingRetryRef = useRef<RetryEnvelope | null>(null);

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
  // A thrown error means the RESPONSE never arrived (dropped connection, server
  // action that never answered). That is reported as `unknown`, NOT as a
  // failure: the server action returns mapped result objects for every business
  // refusal, so a throw carries no information about whether the write landed.
  async function submitCommit(env: RetryEnvelope): Promise<CommitOutcome> {
    try {
      const res = await commitWholeSessionCopyAction({
        clientId,
        sessionId,
        drafts: env.drafts.map(draftToCopyInput),
        idempotencyKey: env.idempotencyKey,
        sourceSessionId: env.sourceSessionId,
        sourceFingerprint: env.sourceFingerprint,
      });
      return res.ok
        ? {
            kind: "committed",
            createdBlockIds: res.createdBlockIds,
            idempotentReplay: res.idempotentReplay,
          }
        : { kind: "failed", error: res.error };
    } catch {
      // Never surfaces the underlying error text: the server action's own
      // mapped messages are the only vocabulary this panel speaks.
      return { kind: "unknown" };
    }
  }

  // Land in today's editor for the first area the batch created. Identical for a
  // fresh commit and for a replay, because the RPC returns the same ids for both.
  function landIn(createdBlockIds: string[]) {
    const landing = landingBlockId(createdBlockIds);
    if (landing) router.replace(fastChartUrl(clientId, sessionId, landing));
    else router.refresh();
  }

  // PRIMARY: bring the reusable setup forward and land in today's editor. One
  // interaction, no preview, no confirm, no scroll-and-reopen.
  function startFromLastSession() {
    if (fastInFlightRef.current) return; // at-most-once per click burst
    fastInFlightRef.current = true;
    setError(null);
    startFast(async () => {
      try {
        // AMBIGUOUS RECOVERY. When a previous attempt's outcome is unknown, the
        // stored envelope is re-submitted VERBATIM and the source is NOT re-read.
        //
        // Re-reading here is precisely the bug this replaces: if the first
        // attempt DID land, today's chart is no longer empty, so
        // whole_session_copy_source_descriptor reports eligible=false /
        // not_empty, and the panel would announce "there's nothing from a
        // previous visit to copy here" about a copy that had just succeeded,
        // while never reaching the retained idempotency key that would have
        // settled it.
        let env = pendingRetryRef.current;
        if (!env) {
          const loaded = await loadSource();
          if (!loaded.ok) {
            setError(loaded.error);
            return;
          }
          env = {
            drafts: loaded.drafts,
            sourceSessionId: loaded.sourceSessionId,
            sourceFingerprint: loaded.sourceFingerprint,
            // Minted once per fresh attempt and then RETAINED by the envelope,
            // so a retry re-submits under the same key and the 0157 ledger can
            // recognise it (unique on target_session_id + idempotency_key).
            idempotencyKey: crypto.randomUUID(),
          };
        }

        const outcome = await submitCommit(env);

        if (outcome.kind === "unknown") {
          // Keep the envelope so the next press is a REPLAY of this exact
          // request rather than a fresh copy. No automatic retry: the
          // practitioner decides, so there is no retry loop.
          pendingRetryRef.current = env;
          setAmbiguous(true);
          return;
        }

        // Definitive either way: the envelope has served its purpose.
        pendingRetryRef.current = null;
        setAmbiguous(false);

        if (outcome.kind === "failed") {
          // Fail CLOSED and truthfully: a changed source is reported, never
          // silently copied stale. A definitive refusal wrote nothing, so the
          // next press legitimately starts fresh and re-reads the source.
          setError(outcome.error);
          return;
        }
        // Whether this was the first commit or a replay of one whose response
        // was lost, createdBlockIds is authoritative and names the same areas.
        landIn(outcome.createdBlockIds);
      } finally {
        fastInFlightRef.current = false;
      }
    });
  }

  // SECONDARY: build (or refresh) the preview. READ-ONLY: no clinical rows are
  // created. A fresh idempotency key is minted per build because preview drafts
  // are EDITABLE: the payload is not a pure function of the source, so it must
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

  // All of these are pure client-state changes: they write nothing.
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
    setAmbiguous(false);
    setPhase("idle");
  }

  // The reviewed-preview write. Sends the reviewed, setup-only draft (validated
  // server-side) plus the server's source id + fingerprint.
  //
  // This route needs no separate retry envelope: it never re-reads the source on
  // commit, and its idempotency key + reviewed drafts live in component state,
  // so pressing the button again after an unknown outcome re-submits the SAME
  // request and replays for the same reason the fast path does.
  function commit() {
    if (drafts.length === 0 || !sourceSessionId || !sourceFingerprint) return;
    setError(null);
    startCommit(async () => {
      const outcome = await submitCommit({
        drafts,
        idempotencyKey,
        sourceSessionId,
        sourceFingerprint,
      });
      if (outcome.kind === "unknown") {
        setAmbiguous(true);
        return;
      }
      setAmbiguous(false);
      if (outcome.kind === "failed") {
        setError(outcome.error);
        return;
      }
      // Reviewed copies land in today's editor too: the reopen loop is gone on
      // BOTH routes.
      const created = outcome.createdBlockIds;
      cancel();
      landIn(created);
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
            {fastStarting
              ? "Checking…"
              : ambiguous
                ? "Try again to check"
                : "Start from last session"}
          </button>
          <button
            type="button"
            onClick={buildPreview}
            // Disabled while an outcome is unknown: previewing would re-read the
            // source, and if the copy DID land the descriptor would report
            // "nothing to copy", the misleading state this recovery exists to
            // prevent. Settle the outcome first.
            disabled={busy || ambiguous}
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
        {ambiguous && (
          <span
            role="status"
            data-testid="copy-previous-ambiguous"
            className="text-amber-700 dark:text-amber-400"
          >
            {AMBIGUOUS_MESSAGE}
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
        <span className="font-medium">Preview: copy from last session</span>
        {hasVisitDate(sourceStartedAt) && (
          <span className="text-xs text-neutral-500" data-testid="copy-previous-source-date">
            From the visit on <VisitDate iso={sourceStartedAt} />
          </span>
        )}
        <span className="text-neutral-600 dark:text-neutral-400">
          {drafts.length} area{drafts.length === 1 ? "" : "s"} ready. This is a
          preview only, nothing is saved yet. Edit anything below; machine
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

      {ambiguous && (
        <span
          role="status"
          data-testid="copy-previous-ambiguous"
          className="text-amber-700 dark:text-amber-400"
        >
          {AMBIGUOUS_MESSAGE}
        </span>
      )}

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
          {committing
            ? "Adding…"
            : ambiguous
              ? "Try again to check"
              : "Add these areas to today's chart"}
        </button>
        <button
          type="button"
          onClick={buildPreview}
          disabled={loading || committing || ambiguous}
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
