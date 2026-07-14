"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import type { ConnectionMetadata } from "@/lib/google-calendar/connection";
import type { ConnectionReadiness } from "@/lib/google-calendar/readiness";
import type { GoogleCalendarListEntry } from "@/lib/google-calendar/oauth";
import { hasRequiredEventScopes } from "@/lib/google-calendar/destination-scopes";
import {
  startGoogleCalendarConnectAction,
  startGoogleCalendarEventScopeUpgradeAction,
  chooseDestinationModeAction,
  provisionDedicatedCalendarAction,
  listOwnedCalendarsAction,
  selectOwnedCalendarAction,
  disconnectGoogleCalendarAction,
} from "./google-calendar-actions";

// Google Calendar connection card on Settings → Profile / Integrations.
//
// Phase A = OAuth connection foundation. B2.4 = DUAL DESTINATION setup (owner-only):
// the owner picks WHERE Hone will add appointments — a dedicated Hone-created
// calendar (calendar.app.created) or an existing calendar they own
// (calendar.events.owned) — then grants the destination-specific scope and finishes
// the target. Readiness is DERIVED server-side (passed as `readiness`), never
// stored. NOTHING here syncs events: even an "outbound_scope_ready" connection shows
// the dormant banner. No token/scope/state is ever exposed to the browser.

type Props = {
  connection: ConnectionMetadata | null;
  readiness: ConnectionReadiness;
  isOwner: boolean;
  // In-app page to return to after connect/disconnect/upgrade. Validated
  // server-side against the open-redirect allowlist; defaults to the profile
  // surface. The owner Integrations page passes "/settings/integrations".
  returnPath?: string;
};

const STATUS_MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  connected: { tone: "ok", text: "Google Calendar connected." },
  event_scope_granted: {
    tone: "ok",
    text: "Calendar permission granted. Finish setting up the destination below — synchronization stays off.",
  },
  event_scope_not_granted: {
    tone: "warn",
    text: "The calendar permission wasn't granted, so nothing changed. You can try again any time.",
  },
  destination_changed: {
    tone: "warn",
    text: "The destination changed during authorization, so nothing was saved. Please try again.",
  },
  account_mismatch: {
    tone: "warn",
    text: "That Google account is different from the one already connected. Disconnect first to switch accounts.",
  },
  denied: { tone: "warn", text: "Connection cancelled — no access was granted." },
  error: { tone: "warn", text: "Something went wrong. Nothing was saved — please try again." },
  insufficient_scope: {
    tone: "warn",
    text: "The required calendar permission wasn't granted. Please reconnect and allow calendar access.",
  },
  reconnect_required: { tone: "warn", text: "Google didn't return a usable token. Please reconnect." },
};

const READINESS_LABEL: Record<ConnectionReadiness, string> = {
  disconnected: "Not connected",
  error: "Connection error",
  reconnect_required: "Reconnect required",
  connected_no_destination: "Connected — choose a destination",
  dedicated_permission_required: "Permission required (dedicated calendar)",
  dedicated_provisioning_pending: "Permission granted — create the calendar",
  existing_permission_required: "Permission required (your calendar)",
  existing_selection_pending: "Permission granted — choose your calendar",
  needs_attention: "Needs attention",
  outbound_scope_ready: "Ready for future event sync",
};

export function GoogleCalendarCard({
  connection,
  readiness,
  isOwner,
  returnPath = "/settings/profile",
}: Props) {
  const params = useSearchParams();
  const gcal = params.get("gcal");
  const banner = gcal ? STATUS_MESSAGES[gcal] : null;

  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [ownedCalendars, setOwnedCalendars] = useState<GoogleCalendarListEntry[] | null>(null);
  const [chosenCalendar, setChosenCalendar] = useState<string>("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const status = connection?.connectionStatus ?? "disconnected";
  const isConnected = status === "connected";
  const needsReconnect = readiness === "reconnect_required" || status === "error";

  const destinationMode = connection?.destinationMode ?? null;
  const scopeGranted = connection
    ? hasRequiredEventScopes(destinationMode, connection.grantedScopes)
    : false;
  const appCreatedId = connection?.appCreatedCalendarId ?? null;
  const ambiguous = !!connection?.provisioningAmbiguousAt;
  const outboundReady = readiness === "outbound_scope_ready";

  // Redirect-style actions (Connect / Grant permission return an OAuth URL).
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
  // Reload-style actions (choose mode / provision / select) return {ok} then reload.
  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const r = await action();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      window.location.href = returnPath;
    });
  }

  const connect = () => go(() => startGoogleCalendarConnectAction(returnPath));
  const grantEventAccess = () => go(() => startGoogleCalendarEventScopeUpgradeAction(returnPath));
  const chooseMode = (mode: "dedicated_app_created" | "existing_owned") =>
    run(() => chooseDestinationModeAction(mode, returnPath));
  const provision = () => run(() => provisionDedicatedCalendarAction(returnPath));
  const selectOwned = () => run(() => selectOwnedCalendarAction(chosenCalendar, returnPath));

  function disconnect() {
    setError(null);
    startTransition(async () => {
      const r = await disconnectGoogleCalendarAction(returnPath);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setConfirmDisconnect(false);
      window.location.href = returnPath;
    });
  }

  function loadOwnedCalendars() {
    setError(null);
    startTransition(async () => {
      const r = await listOwnedCalendarsAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setOwnedCalendars(r.calendars);
      setChosenCalendar(connection?.writeCalendarId ?? r.calendars[0]?.id ?? "");
    });
  }

  const btnPrimary =
    "w-fit rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900";
  const btnSecondary =
    "w-fit rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-neutral-700";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-300 p-5 dark:border-neutral-700">
      <div>
        <h3 className="text-sm font-semibold">Google Calendar</h3>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Connect your Google account so Hone can add appointments to your calendar in a
          later release. This is <strong>separate</strong> from the read-only calendar feed
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
        <div className="flex flex-col gap-3 text-sm">
          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900/50">
            <p className="font-medium text-neutral-900 dark:text-neutral-100">
              Google Calendar is connected.
            </p>
            <p className="mt-0.5 text-neutral-600 dark:text-neutral-400">
              Synchronization is off. Hone is not creating or changing appointment events.
            </p>
          </div>

          {/* ---- Owner-only DESTINATION setup ---- */}
          {isOwner && (
            <>
              {ambiguous && (
                <div
                  data-testid="gcal-needs-attention"
                  className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
                >
                  This connection needs attention: more than one Hone calendar was found
                  during setup. Please contact support so nothing is duplicated.
                </div>
              )}

              {/* Step 1 — choose a destination (only before one is chosen). */}
              {!ambiguous && destinationMode === null && (
                <fieldset
                  data-testid="gcal-destination-chooser"
                  className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
                >
                  <legend className="px-1 text-sm font-medium">
                    Where should Hone add appointments?
                  </legend>
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => chooseMode("dedicated_app_created")}
                      disabled={pending}
                      className={btnPrimary}
                    >
                      Create a Hone Appointments calendar
                    </button>
                    <p className="text-neutral-600 dark:text-neutral-400">
                      Hone creates a separate calendar for appointments. Your existing
                      personal and business calendars remain separate.
                    </p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => chooseMode("existing_owned")}
                      disabled={pending}
                      className={btnSecondary}
                    >
                      Use an existing calendar
                    </button>
                    <p className="text-neutral-600 dark:text-neutral-400">
                      Choose one of the Google calendars you own.
                    </p>
                  </div>
                </fieldset>
              )}

              {/* Step 2 — dedicated: grant permission, then create the calendar. */}
              {!ambiguous && destinationMode === "dedicated_app_created" && !outboundReady && (
                <div
                  data-testid="gcal-dedicated-setup"
                  className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/30"
                >
                  {!scopeGranted ? (
                    <>
                      <p className="text-sm text-amber-900 dark:text-amber-200">
                        Hone needs permission to create and manage a dedicated calendar.
                        This grants only that permission; it does not turn on synchronization.
                      </p>
                      <button type="button" onClick={grantEventAccess} disabled={pending} className={btnPrimary}>
                        {pending ? "Redirecting…" : "Grant permission to create a calendar"}
                      </button>
                    </>
                  ) : !appCreatedId ? (
                    <>
                      <p className="text-sm text-amber-900 dark:text-amber-200">
                        Permission granted. Create the dedicated “Hone Appointments” calendar
                        to finish. This creates an empty calendar — no events are added.
                      </p>
                      <button type="button" onClick={provision} disabled={pending} className={btnPrimary}>
                        {pending ? "Creating…" : "Create the Hone Appointments calendar"}
                      </button>
                    </>
                  ) : null}
                </div>
              )}

              {/* Step 2 — existing owned: grant permission, then pick an owned calendar. */}
              {!ambiguous && destinationMode === "existing_owned" && !outboundReady && (
                <div
                  data-testid="gcal-existing-setup"
                  className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/30"
                >
                  {!scopeGranted ? (
                    <>
                      <p className="text-sm text-amber-900 dark:text-amber-200">
                        Hone needs permission to add events to a calendar you own. This grants
                        only that permission; it does not turn on synchronization.
                      </p>
                      <button type="button" onClick={grantEventAccess} disabled={pending} className={btnPrimary}>
                        {pending ? "Redirecting…" : "Grant permission to use your calendar"}
                      </button>
                    </>
                  ) : ownedCalendars ? (
                    <div className="flex flex-col gap-2">
                      <label className="text-sm">
                        <span className="mb-1 block text-neutral-600 dark:text-neutral-300">
                          Choose a calendar you own
                        </span>
                        <select
                          value={chosenCalendar}
                          onChange={(e) => setChosenCalendar(e.target.value)}
                          className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
                        >
                          {ownedCalendars.length === 0 && <option value="">No owned calendars found</option>}
                          {ownedCalendars.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.summary}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={selectOwned}
                          disabled={pending || !chosenCalendar}
                          className={btnPrimary}
                        >
                          {pending ? "Saving…" : "Use this calendar"}
                        </button>
                        <button type="button" onClick={() => setOwnedCalendars(null)} className={btnSecondary}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-amber-900 dark:text-amber-200">
                        Permission granted. Choose which of your calendars Hone should use.
                      </p>
                      <button type="button" onClick={loadOwnedCalendars} disabled={pending} className={btnPrimary}>
                        {pending ? "Loading…" : "Choose a calendar you own"}
                      </button>
                    </>
                  )}
                </div>
              )}

              {outboundReady && (
                <p
                  data-testid="gcal-ready"
                  className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"
                >
                  Destination ready for future event sync. Synchronization is still disabled.
                </p>
              )}
            </>
          )}

          {!isOwner && (
            <p className="rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
              The appointment destination is managed by the studio owner.
            </p>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-neutral-700 dark:text-neutral-300">
            <dt className="text-neutral-500">Google account</dt>
            <dd>{connection?.googleAccountEmail ?? "—"}</dd>
            <dt className="text-neutral-500">Destination</dt>
            <dd>
              {destinationMode === "dedicated_app_created"
                ? "Dedicated Hone calendar"
                : destinationMode === "existing_owned"
                  ? "An existing calendar you own"
                  : "Not chosen"}
            </dd>
            <dt className="text-neutral-500">Selected calendar</dt>
            <dd>{connection?.selectedCalendarDisplayName ?? "—"}</dd>
            <dt className="text-neutral-500">Setup status</dt>
            <dd>{READINESS_LABEL[readiness]}</dd>
            <dt className="text-neutral-500">Last authorized</dt>
            <dd>
              {connection?.lastSuccessfulAuthAt
                ? new Date(connection.lastSuccessfulAuthAt).toLocaleString()
                : "—"}
            </dd>
          </dl>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={connect} disabled={pending} className={btnSecondary}>
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
                className={btnSecondary}
              >
                Disconnect
              </button>
            )}
          </div>
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
