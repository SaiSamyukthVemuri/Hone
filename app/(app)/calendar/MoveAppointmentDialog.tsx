"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  formatTimeForStudio,
  localDateString,
  localLongDate,
  localTimeString,
  utcInstantFromLocal,
} from "@/lib/booking/tz";
import {
  loadMoveSlotsAction,
  moveAppointmentAction,
  type MoveSlot,
  type MovePractitionerOption,
} from "./move-appointment-actions";

// Practitioner Move appointment, ONE shared responsive dialog + state machine used by
// mobile, tablet, and desktop (responsive by Tailwind; no separate mobile/desktop paths).
// Mobile: full-width bottom sheet (<= 90dvh, safe-area padding, sticky header/footer,
// 44px tap targets, 2-col time grid). Tablet/desktop: centered modal (wider time grid,
// keyboard-operable, focus trapped, Escape closes when idle, focus returns to the opener).
//
// Two modes share the same state machine + the same server action:
//   * "available_slot" (default), pick a generated available time (server-verified).
//   * "custom_time" (OWNER ONLY), enter a studio-local time that may be outside regular
//     operating hours; still conflict-safe (the DB reservations/constraints reject
//     overlaps). The custom option renders ONLY when the SERVER says the caller is an
//     owner (canUseCustomTime from loadMoveSlotsAction); the action re-authorizes on submit.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export type MoveDialogAppointment = {
  id: string;
  startsAt: string; // ISO UTC
  endsAt: string; // ISO UTC
  durationMinutes: number;
  clientName: string | null;
  serviceName: string | null;
  practitionerName?: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onMoved: (r: { startsAt: string; endsAt: string; notificationStatus: string; message: string }) => void;
  appointment: MoveDialogAppointment;
  studioTimezone: string;
  timeFormat: "12h" | "24h";
};

type Mode = "available_slot" | "custom_time";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function MoveAppointmentDialog({ open, onClose, onMoved, appointment, studioTimezone, timeFormat }: Props) {
  const tz = studioTimezone;
  const currentLocalDate = useMemo(() => localDateString(new Date(appointment.startsAt), tz), [appointment.startsAt, tz]);
  const todayLocal = useMemo(() => localDateString(new Date(), tz), [tz]);

  const [date, setDate] = useState(currentLocalDate);
  const [slots, setSlots] = useState<MoveSlot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MoveSlot | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [loadingSlots, startLoad] = useTransition();
  // The critical mutation lock is EXPLICIT: a synchronous useState + a one-shot ref
  // NOT useTransition. useTransition's pending flag is deferred, which left a window
  // where the footer had not yet repainted the disabled "Moving…" state (the reported
  // "button vanishes ~1s then returns" + invisibly-clickable submit). setSubmitting(true)
  // + submittingRef establish the visible loading state, the disabled controls, and
  // duplicate-submit protection on the SAME tick as the first tap.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  // Custom-time mode (owner only). `canUseCustomTime` is authoritative from the server.
  const [mode, setMode] = useState<Mode>("available_slot");
  const [canUseCustomTime, setCanUseCustomTime] = useState(false);
  const [customTime, setCustomTime] = useState(""); // studio-local "HH:MM"
  const [ackOverride, setAckOverride] = useState(false);

  // Item 7: owner-only reassignment. All server-authoritative from loadMoveSlotsAction.
  const [reassignEnabled, setReassignEnabled] = useState(false);
  const [eligible, setEligible] = useState<MovePractitionerOption[]>([]);
  const [target, setTarget] = useState<string>(""); // "" = none chosen (reassignment required)
  const [currentPractitionerId, setCurrentPractitionerId] = useState<string>("");
  // Latest-request-wins: a stale slot/eligible response (appt fixed; date/target vary)
  // must never overwrite the current list. Bumped on every load.
  const loadReq = useRef(0);

  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const currentDayLabel = useMemo(() => localLongDate(new Date(appointment.startsAt), tz), [appointment.startsAt, tz]);
  const currentTimeLabel = useMemo(() => formatTimeForStudio(new Date(appointment.startsAt), tz, timeFormat), [appointment.startsAt, tz, timeFormat]);
  const newDayLabel = useMemo(() => (selected ? localLongDate(new Date(selected.start), tz) : null), [selected, tz]);

  // Studio-tz instant for the custom date+time (DST-correct), for the confirm summary.
  const customInstant = useMemo(() => {
    if (!DATE_RE.test(date) || !TIME_RE.test(customTime)) return null;
    const d = utcInstantFromLocal(date, customTime, tz);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [date, customTime, tz]);
  const customDayLabel = customInstant ? localLongDate(customInstant, tz) : null;
  const customTimeLabel = customInstant ? formatTimeForStudio(customInstant, tz, timeFormat) : null;

  // Load authorized available times for a given local date. Preserves the current
  // selection only when the new list still contains it (else clears the incompatible time).
  const load = useCallback(
    // forTarget === null → the initial load (also resolves the default target);
    // a string → an explicit target (owner date/practitioner change).
    (forDate: string, forTarget: string | null) => {
      setLoadError(null);
      const req = ++loadReq.current;
      startLoad(async () => {
        const res = await loadMoveSlotsAction({
          appointmentId: appointment.id,
          localDate: forDate,
          targetPractitionerId: forTarget,
        });
        if (req !== loadReq.current) return; // stale: a newer load superseded this
        if (!res.ok) {
          setSlots([]);
          setLoadError(res.error);
          setSelected(null);
          return;
        }
        setSlots(res.slots);
        setCanUseCustomTime(res.canUseCustomTime); // server-authoritative owner flag
        setReassignEnabled(res.reassignEnabled);
        setEligible(res.eligiblePractitioners);
        setCurrentPractitionerId(res.currentPractitionerId);
        // Default target on the FIRST load only: keep the current practitioner when
        // still active + eligible; otherwise leave it empty so the owner must
        // deliberately choose a replacement (never a silent first pick).
        if (forTarget === null && res.reassignEnabled) {
          setTarget(res.currentPractitionerValid ? res.currentPractitionerId : "");
        }
        setSelected((prev) => (prev && res.slots.some((s) => s.start === prev.start) ? prev : null));
      });
    },
    [appointment.id],
  );

  // On open: reset to the appointment's current date + default (available) mode and
  // load its times; capture the opener.
  useEffect(() => {
    if (!open) return;
    openerRef.current = (document.activeElement as HTMLElement) ?? null;
    submittingRef.current = false;
    setSubmitting(false);
    setDate(currentLocalDate);
    setSelected(null);
    setMoveError(null);
    setMode("available_slot");
    setCustomTime("");
    setAckOverride(false);
    setCanUseCustomTime(false);
    setReassignEnabled(false);
    setEligible([]);
    setTarget("");
    setCurrentPractitionerId("");
    load(currentLocalDate, null);
    const t = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus trap + Escape (idle only). This effect re-runs whenever `submitting`
  // flips, so its cleanup must NOT move focus (that would yank focus out of the
  // dialog mid-submit); focus return lives in its own open-scoped effect below.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (nodes.length === 0) {
          // Everything is disabled (e.g. mid-submit): keep focus inside the dialog
          // instead of letting Tab escape to content behind the modal.
          e.preventDefault();
          panelRef.current.focus();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  // Return focus to the opener ONLY when the dialog actually closes/unmounts,
  // keyed on `open` alone so a mid-flight `submitting` change never steals focus.
  useEffect(() => {
    if (!open) return;
    return () => {
      openerRef.current?.focus?.();
    };
  }, [open]);

  // Fully clear the submit lock once closed. The success path intentionally leaves
  // `submitting` set while the dialog closes (so no enabled button flashes before it
  // disappears); this resets it AFTER close (while the dialog renders null) so a
  // later reopen never paints a stale "Moving appointment…" frame.
  useEffect(() => {
    if (open) return;
    submittingRef.current = false;
    setSubmitting(false);
  }, [open]);

  const onPickDate = (d: string) => {
    setDate(d);
    setMoveError(null);
    // In available mode a slot chosen on the previous date is never valid for the new
    // date; clear it synchronously and reload. In custom mode the date is independent
    // of the generated slot list, so no reload/clear is needed.
    if (mode === "available_slot") {
      setSelected(null);
      load(d, target);
    }
  };

  // Item 7: owner picks a reassignment target. Changing it synchronously clears the
  // selected slot + any stale target-specific error, then reloads that target's
  // slots (latest-request-wins inside `load`), forcing a deliberate re-confirmation.
  const onPickTarget = (t: string) => {
    if (submitting || t === target) return;
    setTarget(t);
    setSelected(null);
    setMoveError(null);
    setLoadError(null);
    if (t) load(date, t);
    else setSlots([]); // no target chosen → offer no times (reassignment required)
  };

  // Mode switches clear incompatible state so stale state from one mode can never
  // submit through the other (§13).
  const switchToAvailable = () => {
    if (submitting || mode === "available_slot") return;
    setMode("available_slot");
    setCustomTime("");
    setAckOverride(false);
    setMoveError(null);
    load(date, target); // reload current available slots
  };
  const switchToCustom = () => {
    if (submitting || mode === "custom_time" || !canUseCustomTime) return;
    setMode("custom_time");
    setSelected(null); // clear generated slot
    setMoveError(null); // clear generated-slot conflict errors
  };

  // Item 7: when reassignment is enabled the current target MUST be a resolved
  // eligible practitioner (fail closed: an empty/failed lookup leaves target "").
  const targetChosen = !reassignEnabled || eligible.some((p) => p.id === target);
  const canConfirm =
    targetChosen &&
    (mode === "available_slot"
      ? !!selected && !loadingSlots
      : DATE_RE.test(date) && TIME_RE.test(customTime) && ackOverride);

  // Which operation the current selection represents (drives the summary + button).
  const isReassign = reassignEnabled && !!target && target !== currentPractitionerId;
  const timeChanged =
    mode === "available_slot"
      ? !!selected && selected.start !== appointment.startsAt
      : !!customInstant && customInstant.getTime() !== new Date(appointment.startsAt).getTime();
  const currentName =
    eligible.find((p) => p.id === currentPractitionerId)?.displayName ?? appointment.practitionerName ?? null;
  const targetName = eligible.find((p) => p.id === target)?.displayName ?? null;
  const currentInvalid = reassignEnabled && !!currentPractitionerId && !eligible.some((p) => p.id === currentPractitionerId);
  const opVerb = isReassign
    ? timeChanged
      ? "Move and reassign appointment"
      : "Reassign appointment"
    : "Move appointment";
  const opBusy = isReassign
    ? timeChanged
      ? "Saving changes…"
      : "Reassigning…"
    : "Moving appointment…";
  const confirmTitle = isReassign
    ? timeChanged
      ? "Confirm move and reassign"
      : "Confirm reassign"
    : "Confirm move";

  const confirmMove = () => {
    // Synchronous one-shot guard: a duplicate tap can NEVER start a second request,
    // even before React commits the disabled state.
    if (submittingRef.current || !canConfirm) return;
    let localTime: string;
    let ack = false;
    if (mode === "available_slot") {
      if (!selected) return;
      localTime = localTimeString(new Date(selected.start), tz); // 24h HH:MM in the studio tz
    } else {
      if (!DATE_RE.test(date) || !TIME_RE.test(customTime) || !ackOverride) return;
      localTime = customTime;
      ack = true;
    }
    const submitMode = mode;
    // Establish the lock SYNCHRONOUSLY, before any async work: this tick renders the
    // disabled "Moving appointment…" state and blocks a second submit.
    submittingRef.current = true;
    setSubmitting(true);
    setMoveError(null);
    // Keep focus inside the dialog when the just-tapped button becomes disabled.
    panelRef.current?.focus();
    void (async () => {
      // The try wraps ONLY the network mutation, never onMoved(). A throwing success
      // callback (e.g. router.refresh) must not convert a COMMITTED move into a false
      // failure + a stale-time retry.
      let res: Awaited<ReturnType<typeof moveAppointmentAction>>;
      try {
        res = await moveAppointmentAction({
          appointmentId: appointment.id,
          expectedStartsAt: appointment.startsAt,
          expectedEndsAt: appointment.endsAt,
          localDate: date,
          localTime,
          mode: submitMode,
          outsideAvailabilityConfirmed: ack,
          // Item 7: the proposed reassignment target (owner only). The action
          // ignores it for members/Legacy and resolves the same practitioner to
          // NULL = time-only; it independently re-validates before the command.
          targetPractitionerId: reassignEnabled ? target : null,
        });
      } catch {
        submittingRef.current = false;
        setSubmitting(false);
        setMoveError("We couldn't move the appointment. Please try again.");
        return;
      }
      if (res.ok) {
        // Success: the parent closes the dialog (it renders null). Leave the lock set;
        // no further state update runs on this path.
        onMoved(res);
        return;
      }
      // Any failure keeps the dialog OPEN: restore the enabled button for one deliberate
      // retry, preserving the entered date/time + acknowledgement.
      submittingRef.current = false;
      setSubmitting(false);
      setMoveError(res.error);
      if (res.code === "conflict" && submitMode === "available_slot") {
        setSelected(null);
        load(date, target); // the offered slot is gone; refresh the CURRENT target's times
      } else if (res.code === "stale" && submitMode === "available_slot") {
        load(date, target);
      }
      // custom mode keeps its entered time + acknowledgement; the error marks it invalid.
    })();
  };

  if (!open) return null;

  const segClass = (active: boolean) =>
    `min-h-[44px] rounded-lg border px-3 py-2 text-sm font-medium transition ${
      active
        ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
        : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Move appointment">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => { if (!submitting) onClose(); }}
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl outline-none dark:bg-neutral-950 sm:max-h-[85vh] sm:w-[540px] sm:rounded-2xl"
      >
        {/* Header: a normal shrink-0 flex child (never position:sticky), so it is
            always painted; only the middle body scrolls. */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950">
          <h2 className="font-serif text-lg font-semibold">Move appointment</h2>
          <button type="button" onClick={() => { if (!submitting) onClose(); }} disabled={submitting} aria-label="Close" className="min-h-[44px] min-w-[44px] rounded-lg px-2 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-900">✕</button>
        </div>

        {/* Scrollable body: the ONLY scroll region. min-h-0 lets it shrink so the
            header + footer keep their height and stay painted. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Current appointment */}
          <section className="rounded-xl bg-neutral-50 p-4 text-sm dark:bg-neutral-900">
            <div className="font-medium">{appointment.clientName ?? "Client"} · {appointment.serviceName ?? "Appointment"}</div>
            <div className="mt-1 text-neutral-600 dark:text-neutral-400">Currently {currentDayLabel} at {currentTimeLabel}</div>
            <div className="mt-0.5 text-neutral-500">{appointment.durationMinutes} min{appointment.practitionerName ? ` · ${appointment.practitionerName}` : ""}</div>
          </section>

          {/* Item 7: owner-only practitioner selector (capacity ON). Members + Legacy
              never see it. Active, service-eligible practitioners only; display names
              only. Changing it reloads that practitioner's times + clears the pick. */}
          {reassignEnabled && (
            <div className="mt-5">
              <label className="block">
                <span className="text-sm font-medium">Practitioner</span>
                <select
                  value={target}
                  onChange={(e) => onPickTarget(e.target.value)}
                  disabled={submitting}
                  aria-label="Practitioner"
                  className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-3 text-base focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {(currentInvalid || target === "") && <option value="">Choose a practitioner…</option>}
                  {eligible.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                      {p.id === currentPractitionerId ? " (current)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {currentInvalid && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300" data-testid="reassignment-required">
                  This appointment&apos;s practitioner is no longer active or eligible. Choose a practitioner to reassign it.
                </p>
              )}
              {isReassign && targetName && (
                <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400" data-testid="reassign-from-to">
                  Reassigning {currentName ? <>from {currentName} </> : null}→{" "}
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">{targetName}</span>
                </p>
              )}
            </div>
          )}

          {/* Owner-only mode selector. Rendered ONLY when the server says the caller
              is an owner; a non-owner never sees the custom-time option. */}
          {canUseCustomTime && (
            <div className="mt-5" role="group" aria-label="How to choose the time">
              <span className="text-sm font-medium">How to choose the time</span>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" onClick={switchToAvailable} aria-pressed={mode === "available_slot"} disabled={submitting} className={segClass(mode === "available_slot")}>
                  Available times
                </button>
                <button type="button" onClick={switchToCustom} aria-pressed={mode === "custom_time"} disabled={submitting} className={segClass(mode === "custom_time")}>
                  Custom time
                </button>
              </div>
            </div>
          )}

          {/* Choose date (shared by both modes) */}
          <label className="mt-5 block">
            <span className="text-sm font-medium">New date</span>
            <input
              type="date"
              value={date}
              min={todayLocal}
              onChange={(e) => onPickDate(e.target.value)}
              disabled={submitting}
              className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-3 text-base focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          {mode === "available_slot" ? (
            /* Available-times mode */
            <div className="mt-5">
              <span className="text-sm font-medium">New time</span>
              {loadingSlots ? (
                <p className="mt-3 text-sm text-neutral-500">Loading available times…</p>
              ) : loadError ? (
                <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  {loadError}{" "}
                  <button type="button" onClick={() => load(date, target)} className="underline">Try again</button>
                </div>
              ) : slots && slots.length === 0 ? (
                <p className="mt-3 text-sm text-neutral-500">No available times on this date.</p>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {(slots ?? []).map((s) => {
                    const isSel = selected?.start === s.start;
                    return (
                      <button
                        key={s.start}
                        type="button"
                        onClick={() => { setSelected(s); setMoveError(null); }}
                        disabled={submitting}
                        aria-pressed={isSel}
                        className={`min-h-[44px] rounded-lg border px-2 py-2 text-sm transition ${isSel ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"}`}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Custom-time mode (owner override) */
            <div className="mt-5">
              <label className="block">
                <span className="text-sm font-medium">Custom time</span>
                <input
                  type="time"
                  step={900}
                  value={customTime}
                  onChange={(e) => { setCustomTime(e.target.value); setMoveError(null); }}
                  disabled={submitting}
                  aria-label="Custom time"
                  className="mt-1 block w-full rounded-lg border border-neutral-300 px-3 py-3 text-base focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <p className="mt-1 text-xs text-neutral-500">Studio time zone: {tz}</p>
              <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                Custom time can be outside regular operating hours. Existing appointments, buffers and blocked time still apply.
              </p>
              <label className="mt-3 flex min-h-[44px] items-center gap-3">
                <input
                  type="checkbox"
                  checked={ackOverride}
                  onChange={(e) => { setAckOverride(e.target.checked); setMoveError(null); }}
                  disabled={submitting}
                  className="h-5 w-5 flex-shrink-0 rounded border-neutral-400 disabled:opacity-50"
                />
                <span className="text-sm">I understand this time overrides regular availability.</span>
              </label>
            </div>
          )}

          {/* Confirm summary */}
          {mode === "available_slot" && selected && (
            <section className="mt-5 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
              <div className="font-medium" data-testid="confirm-title">{confirmTitle}</div>
              <div className="mt-2 flex flex-col gap-1 text-neutral-600 dark:text-neutral-400">
                <span>From: {currentDayLabel} at {currentTimeLabel}</span>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">To: {newDayLabel} at {selected.label}</span>
                {isReassign && targetName && (
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">
                    Practitioner: {currentName ? `${currentName} → ` : ""}{targetName}
                  </span>
                )}
                <span>Duration unchanged: {appointment.durationMinutes} min</span>
              </div>
            </section>
          )}
          {mode === "custom_time" && customInstant && (
            <section className="mt-5 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium" data-testid="confirm-title">{confirmTitle}</div>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">Custom-time override</span>
              </div>
              <div className="mt-2 flex flex-col gap-1 text-neutral-600 dark:text-neutral-400">
                <span>{appointment.clientName ?? "Client"} · {appointment.serviceName ?? "Appointment"}</span>
                <span>From: {currentDayLabel} at {currentTimeLabel}</span>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">To: {customDayLabel} at {customTimeLabel}</span>
                {isReassign && targetName && (
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">
                    Practitioner: {currentName ? `${currentName} → ` : ""}{targetName}
                  </span>
                )}
                <span>Duration unchanged: {appointment.durationMinutes} min</span>
              </div>
            </section>
          )}

          {moveError && (
            <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">{moveError}</div>
          )}
        </div>

        {/* Footer: a normal shrink-0 flex child (never position:sticky), opaque with a
            top border + safe-area bottom padding. Because it is a flex sibling of the
            scroll body (not sticky inside an overflow-clipped container) it stays
            continuously painted on iOS Safari before, during and after submission. */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-neutral-200 bg-white px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] dark:border-neutral-800 dark:bg-neutral-950 sm:pb-4">
          <button type="button" onClick={() => { if (!submitting) onClose(); }} disabled={submitting} className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900">Keep current time</button>
          <button type="button" onClick={confirmMove} disabled={!canConfirm || submitting} aria-busy={submitting} className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-neutral-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
            {submitting && (
              <span aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-neutral-900/40 dark:border-t-neutral-900" />
            )}
            {submitting ? opBusy : opVerb}
          </button>
        </div>
      </div>
    </div>
  );
}
