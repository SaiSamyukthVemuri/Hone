"use client";

import { useState, useTransition } from "react";
import {
  rotateCalendarFeedTokenAction,
  clearCalendarFeedTokenAction,
} from "./actions";

// Calendar feed card on Settings → Profile.
//
// Migration 0116: the raw feed token is HASH-ONLY at rest, so the card never
// receives the raw token from the DB. It gets `initialActive` (whether a feed
// hash exists) and shows the actual URL only from the token a generate/rotate
// action just returned. Renders:
//   - never created (!active): "Generate calendar feed URL" CTA.
//   - active, link just shown (fresh token): URL + Copy + Regenerate + Disable.
//   - active, link not in view (existing feed, raw not stored): "active — the
//     link is shown only once; regenerate to get a new one" + Regenerate +
//     Disable. The existing subscription keeps working.
//
// The card is explicit that this is one-way and read-only, and that anyone
// holding the URL can view appointments (no login required by the poller).

type Props = {
  appOrigin: string;
  initialActive: boolean;
};

function feedUrl(appOrigin: string, token: string): string {
  return `${appOrigin}/calendar-feed/${token}.ics`;
}

export function CalendarFeedCard({ appOrigin, initialActive }: Props) {
  // `token` is the raw token from a just-run generate/rotate (shown once);
  // `active` is whether a feed exists at all (hash present).
  const [token, setToken] = useState<string | null>(null);
  const [active, setActive] = useState(initialActive);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function generate() {
    setError(null);
    startTransition(async () => {
      const r = await rotateCalendarFeedTokenAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setToken(r.token);
      setActive(true);
      setConfirmRotate(false);
    });
  }

  function rotate() {
    if (!confirmRotate) {
      setConfirmRotate(true);
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await rotateCalendarFeedTokenAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setToken(r.token);
      setActive(true);
      setConfirmRotate(false);
    });
  }

  function disable() {
    setError(null);
    startTransition(async () => {
      const r = await clearCalendarFeedTokenAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setToken(null);
      setActive(false);
      setConfirmRotate(false);
    });
  }

  function copy() {
    if (!token) return;
    void navigator.clipboard
      .writeText(feedUrl(appOrigin, token))
      .then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
        () => setError("Copy failed. Select and copy the URL manually."),
      );
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium">Calendar feed</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Subscribe to this private calendar URL in Google Calendar or
          Apple Calendar to see your Hone appointments. This is one-way
          and read-only. Hone does not import events from Google.
        </p>
      </div>
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
        Anyone with this URL can view the appointments in this feed.
        Keep it private. If you share or leak it, regenerate the URL
        below to revoke the old one.
      </div>

      {!active && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            No calendar feed URL yet.
          </p>
          <div>
            <button
              type="button"
              onClick={generate}
              disabled={pending}
              className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {pending ? "Generating…" : "Generate calendar feed URL"}
            </button>
          </div>
        </div>
      )}

      {active && (
        <div className="flex flex-col gap-3">
          {token ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
              <span className="text-xs uppercase tracking-wider text-neutral-500">
                Your calendar feed URL
              </span>
              <code className="break-all text-xs text-neutral-800 dark:text-neutral-200">
                {feedUrl(appOrigin, token)}
              </code>
              <span className="text-xs text-neutral-500">
                Copy this now — for your security Hone stores only a hashed
                copy, so the link is shown only this once.
              </span>
            </div>
          ) : (
            <p className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
              Your calendar feed is active and any existing subscription keeps
              working. For your security the link is shown only once, when you
              generate or regenerate it — Hone does not store the link itself.
              Regenerate to get a new link (this replaces the old one), or
              disable the feed.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {token && (
              <button
                type="button"
                onClick={copy}
                disabled={pending}
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
              >
                {copied ? "Copied" : "Copy feed URL"}
              </button>
            )}
            {!confirmRotate && (
              <button
                type="button"
                onClick={rotate}
                disabled={pending}
                className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
              >
                Regenerate feed URL
              </button>
            )}
            {confirmRotate && (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={rotate}
                  disabled={pending}
                  className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100"
                >
                  {pending ? "Regenerating…" : "This will break the old subscribed URL"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRotate(false)}
                  disabled={pending}
                  className="text-xs text-neutral-500 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-700 dark:decoration-neutral-700 dark:hover:decoration-neutral-300"
                >
                  Cancel
                </button>
              </span>
            )}
            <button
              type="button"
              onClick={disable}
              disabled={pending}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
            >
              Disable feed
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}

      <p className="text-xs text-neutral-500">
        Events in the feed are titled &ldquo;Hone appointment&rdquo;
        and include the client name and type (electrolysis, laser, or
        consultation) in the description. No intake answers, allergies,
        medical history, private notes, pricing, or payment information
        is included.
      </p>
    </section>
  );
}
