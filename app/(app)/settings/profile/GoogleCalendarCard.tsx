"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import type { ConnectionMetadata } from "@/lib/google-calendar/connection";
import type { ConnectionReadiness } from "@/lib/google-calendar/readiness";
import type { GoogleCalendarListEntry } from "@/lib/google-calendar/oauth";
import {
  startGoogleCalendarConnectAction,
  startGoogleCalendarEventScopeUpgradeAction,
  disconnectGoogleCalendarAction,
  listWritableCalendarsAction,
  selectWriteCalendarAction,
  designateSelfAsCalendarOwnerAction,
} from "./google-calendar-actions";

// Google Calendar connection card on Settings → Profile.
//
// Phase A = the OAuth CONNECTION foundation. Phase B2.2 adds the incremental
// calendar.events scope upgrade + reconnect UX. Readiness is DERIVED server-side
// (passed in as `readiness`), never stored. NOTHING here syncs events: even a
// fully "outbound_scope_ready" connection shows the dormant banner
// ("Event synchronization is still disabled"). No token/scope/state is exposed.

type Props = {
  connection: ConnectionMetadata | null;
  readiness: ConnectionReadiness;
  isOwner: boolean;
};

const STATUS_MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  connected: { tone: "ok", text: "Google Calendar connected." },
  event_scope_granted: { tone: "ok", text: "Calendar event access granted. Your connection is ready for future event sync — synchronization is still disabled." },
  event_scope_not_granted: { tone: "warn", text: "Connected, but calendar event access was not granted. You can grant it any time — nothing was changed." },
  account_mismatch: { tone: "warn", text: "That Google account is different from the one already connected. Disconnect first to switch accounts." },
  denied: { tone: "warn", text: "Connection cancelled — no access was granted." },
  error: { tone: "warn", text: "Something went wrong. Nothing was saved — please try again." },
  insufficient_scope: { tone: "warn", text: "The required calendar permission wasn't granted. Please reconnect and allow calendar access." },
  reconnect_required: { tone: "warn", text: "Google didn't return a usable token. Please reconnect." },
};

const READINESS_LABEL: Record<ConnectionReadiness, string> = {
  disconnected: "Not connected",
  error: "Connection error",
  reconnect_required: "Reconnect required",
  connected_phase_a: "Connected (not the studio write calendar)",
  scope_upgrade_required: "Event access not granted",
  outbound_scope_ready: "Ready for future event sync",
};

export function GoogleCalendarCard({ connection, readiness, isOwner }: Props) {
  const params = useSearchParams();
  const gcal = params.get("gcal");
  const banner = gcal ? STATUS_MESSAGES[gcal] : null;

  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [calendars, setCalendars] = useState<GoogleCalendarListEntry[] | null>(null);
  const [chosenCalendar, setChosenCalendar] = useState<string>("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const status = connection?.connectionStatus ?? "disconnected";
  const isConnected = status === "connected";
  const needsReconnect = readiness === "reconnect_required" || status === "error";
  const needsEventScope = readiness === "scope_upgrade_required";
  const outboundReady = readiness === "outbound_scope_ready";

  function go(action: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      window.location.href = r.url;
    });
  }
  const connect = () => go(startGoogleCalendarConnectAction);
  const grantEventAccess = () => go(startGoogleCalendarEventScopeUpgradeAction);

  function disconnect() {
    setError(null);
    startTransition(async () => {
      const r = await disconnectGoogleCalendarAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setConfirmDisconnect(false);
      window.location.href = "/settings/profile";
    });
  }

  function loadCalendars() {
    setError(null);
    startTransition(async () => {
      const r = await listWritableCalendarsAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setCalendars(r.calendars);
      setChosenCalendar(connection?.writeCalendarId ?? r.calendars[0]?.id ?? "");
    });
  }

  function saveCalendar() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("calendar_id", chosenCalendar);
      const r = await selectWriteCalendarAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setCalendars(null);
      window.location.href = "/settings/profile";
    });
  }

  function makeStudioOwner() {
    setError(null);
    startTransition(async () => {
      const r = await designateSelfAsCalendarOwnerAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      window.location.href = "/settings/profile";
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-300 p-5 dark:border-neutral-700">
      <div>
        <h3 className="text-sm font-semibold">Google Calendar</h3>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Connect your Google account so Hone can sync with your calendar in a later
          release. This is <strong>separate</strong> from the read-only calendar feed
          above — the feed is a one-way subscription that never imports events into Hone.
        </p>
      </div>

      {banner && (
        <p
          role="status"
          className={
            banner.tone === "ok"
              ? "rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
              : "rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          }
        >
          {banner.text}
        </p>
      )}

      {isConnected ? (
        <div className="flex flex-col gap-2 text-sm">
          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900/50">
            <p className="font-medium text-neutral-900 dark:text-neutral-100">
              Google Calendar is connected. Event synchronization is still disabled.
            </p>
            <p className="mt-0.5 text-neutral-600 dark:text-neutral-400">
              Hone is not reading or writing calendar events. Nothing changes on your
              Google Calendar or in Hone booking until sync is turned on for your studio.
            </p>
          </div>

          {/* Event-scope upgrade CTA — shown when this connection is the studio's
              designated write target but is missing the calendar.events grant. */}
          {needsEventScope && (
            <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/30">
              <p className="text-sm text-amber-900 dark:text-amber-200">
                Additional Google Calendar permission is required before Hone can create or
                update events. This grants only calendar event access; it does not turn on
                synchronization.
              </p>
              <button
                type="button"
                onClick={grantEventAccess}
                disabled={pending}
                className="w-fit rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
              >
                {pending ? "Redirecting…" : "Grant calendar event access"}
              </button>
            </div>
          )}
          {outboundReady && (
            <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
              Connected and ready for future event sync. Synchronization is still disabled.
            </p>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-neutral-700 dark:text-neutral-300">
            <dt className="text-neutral-500">Google account</dt>
            <dd>{connection?.googleAccountEmail ?? "—"}</dd>
            <dt className="text-neutral-500">Write calendar</dt>
            <dd className="tabular-nums">{connection?.writeCalendarId ?? "—"}</dd>
            <dt className="text-neutral-500">Studio calendar owner</dt>
            <dd>{connection?.isStudioCalendarOwner ? "Yes (this calendar)" : "No"}</dd>
            <dt className="text-neutral-500">Event-scope readiness</dt>
            <dd>{READINESS_LABEL[readiness]}</dd>
            <dt className="text-neutral-500">Access granted</dt>
            <dd className="break-words text-xs">{(connection?.grantedScopes ?? []).join(", ") || "—"}</dd>
            <dt className="text-neutral-500">Last authorization error</dt>
            <dd>{connection?.lastErrorCode ?? "—"}</dd>
            <dt className="text-neutral-500">Last authorized</dt>
            <dd>
              {connection?.lastSuccessfulAuthAt
                ? new Date(connection.lastSuccessfulAuthAt).toLocaleString()
                : "—"}
            </dd>
          </dl>

          {calendars ? (
            <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <label className="text-sm">
                <span className="mb-1 block text-neutral-500">Write calendar</span>
                <select
                  value={chosenCalendar}
                  onChange={(e) => setChosenCalendar(e.target.value)}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {calendars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.summary} ({c.accessRole})
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveCalendar}
                  disabled={pending || !chosenCalendar}
                  className="w-fit rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                >
                  {pending ? "Saving…" : "Save calendar"}
                </button>
                <button
                  type="button"
                  onClick={() => setCalendars(null)}
                  className="w-fit rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={loadCalendars}
                disabled={pending}
                className="w-fit rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
              >
                Change write calendar
              </button>
              {isOwner && !connection?.isStudioCalendarOwner && (
                <button
                  type="button"
                  onClick={makeStudioOwner}
                  disabled={pending}
                  className="w-fit rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
                >
                  Set as studio calendar
                </button>
              )}
              <button
                type="button"
                onClick={connect}
                disabled={pending}
                className="w-fit rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
              >
                Reconnect
              </button>
              {confirmDisconnect ? (
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={pending}
                  className="w-fit rounded-md border border-red-400 px-3 py-1.5 text-sm text-red-700 disabled:opacity-50 dark:border-red-700 dark:text-red-300"
                >
                  {pending ? "Disconnecting…" : "Confirm disconnect"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={pending}
                  className="w-fit rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700"
                >
                  Disconnect
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {needsReconnect && connection?.googleAccountEmail && (
            <p className="text-sm text-amber-800 dark:text-amber-300">
              {status === "revoked"
                ? `Google access was revoked for ${connection.googleAccountEmail}. Reconnect to restore it.`
                : `Reconnect needed for ${connection.googleAccountEmail}.`}
            </p>
          )}
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Hone will ask Google only for your account identity and the list of your
            calendars (to pick one). No event read or write access is requested when you
            first connect, and no events are synced.
          </p>
          <button
            type="button"
            onClick={connect}
            disabled={pending}
            className="w-fit rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {pending ? "Connecting…" : needsReconnect ? "Reconnect Google Calendar" : "Connect Google Calendar"}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
