"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { Service } from "@/lib/types/database";
import {
  formatServiceLabel,
  groupServicesByModality,
} from "@/lib/booking/format";
import { isConsultationService } from "@/lib/booking/consultation";
import {
  pushAvailabilityHistory,
  popAvailabilityHistory,
} from "@/lib/booking/availability-history";
import { MARKETING_CONSENT_FIELD } from "@/lib/booking/marketing-consent";
import { REFERRAL_SOURCE_OPTIONS } from "@/lib/booking/referral-source";
import {
  fetchNextAvailableDateAction,
  fetchPublicSlotsAction,
  publicBookAppointmentAction,
} from "./actions";

// Public booking new/existing split. The first-step choice is
// strictly local state and never hits the server: until the visitor
// picks one, no slot lookup, no client lookup, no email lookup, and
// no full booking form is rendered. The choice drives:
//   * which services the picker offers (consultation only for new
//     clients; all active services for existing clients),
//   * which clinical/repeat fields are required (new clients still
//     answer the existing intake/areas question; existing clients
//     get a single optional "anything to know" note),
//   * which value is posted to the server action as client_type so
//     the matching guard rails run there too.
// The server is the source of truth for both rules; this state only
// shapes the surface the visitor sees.
type ClientType = "new" | "existing" | null;

type Slot = { start: string; end: string; startLabel: string };

type Props = {
  slug: string;
  studioName: string;
  studioAddress: string | null;
  services: Service[];
  defaultDate: string;
  minDate: string;
  maxDate: string;
};

type Confirmation = {
  when: string;
  dateLocal: string;
  service: Service | null;
  email: string;
};

// Render a local YYYY-MM-DD as "Tuesday, May 26" (or, with year, "Tuesday, May 26, 2026"
// if the date is not in the current year). Pure client-side formatting; no timezone
// conversion since the input is already a studio-local date and we construct a Date
// from explicit year/month/day so the runtime's local timezone offset does not shift it.
// Merge the optional "areas wanted treated" answer with the catch-all
// "anything else" notes into the single appointments.notes column the
// server already accepts. Both prefixes are labeled so the practitioner
// can see which line came from which field in the saved note. Either
// side may be blank.
function combineAreasAndNotes(areas: string, notes: string): string {
  const trimmedAreas = areas.trim();
  const trimmedNotes = notes.trim();
  const parts: string[] = [];
  if (trimmedAreas) parts.push(`Areas: ${trimmedAreas}`);
  if (trimmedNotes) parts.push(`Notes: ${trimmedNotes}`);
  return parts.join("\n");
}

// Add one calendar day to a YYYY-MM-DD studio-local date string. Used to
// advance the next-available scan past the date the user already saw as
// empty. Stays in local-date space (no UTC conversion) so DST has no
// effect: tomorrow's local-calendar date is the same regardless of time
// of day or zone offsets.
function addOneDayLocal(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return localDate;
  }
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + 1);
  const yy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function formatLocalDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return localDate;
  }
  const date = new Date(y, m - 1, d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

export function PublicBookForm({
  slug,
  studioName,
  studioAddress,
  services,
  defaultDate,
  minDate,
  maxDate,
}: Props) {
  // Pre-compute the service buckets each path needs. Done once at
  // mount and re-runs only if `services` actually changes (which
  // would only happen on a fresh server-rendered page load).
  const consultationServices = useMemo(
    () => services.filter((s) => isConsultationService(s)),
    [services],
  );
  // Existing clients see the full active service list (consultations
  // and treatments). Studios that want returning clients to skip
  // consultation altogether can manage that by curating which
  // services they mark active; the public path does not need to make
  // that choice here.
  const existingClientServices = services;

  const [clientType, setClientType] = useState<ClientType>(null);
  // The picker's option set is whichever bucket matches the current
  // clientType. Until a type is chosen we still resolve a deterministic
  // first-id so the standard "default to the first service" pattern
  // works; the form is hidden in that state so the value is harmless.
  const visibleServices =
    clientType === "new"
      ? consultationServices
      : clientType === "existing"
        ? existingClientServices
        : services;
  const groups = useMemo(
    () => groupServicesByModality(visibleServices),
    [visibleServices],
  );
  const firstServiceId = groups[0]?.services[0]?.id ?? "";
  const [serviceId, setServiceId] = useState(firstServiceId);
  const [date, setDate] = useState(defaultDate);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [picked, setPicked] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  // Separate fields client-side; combined into the single `notes` form
  // value at submit time. `areasWanted` answers "what areas are you
  // wanting treated?", primarily for consultation context. `notes` is
  // the catch-all "anything else?" line. Both stored in
  // appointments.notes (no schema change).
  const [areasWanted, setAreasWanted] = useState("");
  const [notes, setNotes] = useState("");
  // PR #163. "How did you hear about us?" attribution. Empty string
  // means the visitor did not answer; the action layer treats it as
  // null. Allowed values come from lib/booking/referral-source.ts so
  // a new option added there appears here without a second edit.
  const [referralSource, setReferralSource] = useState("");
  // SMS consent (PR Twilio v1). Defaults to false; opt-in only. The
  // checkbox is not required; phone stays required as before. Consent
  // is only honored when the submitted phone normalizes equal to the
  // stored phone for an existing client (server-side gate in
  // publicBookAppointmentAction). New clients always accept the
  // checkbox value verbatim. The helper copy below names STOP so the
  // client knows how to opt out before they consent.
  const [smsConsent, setSmsConsent] = useState(false);
  // Optional marketing/analytics consent (PR: booking consent capture).
  // Opt-in only, defaults false, never prechecked; separate from SMS +
  // treatment + payment consents. Declining does NOT block booking.
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Confirmation | null>(null);
  const [loadingSlots, startLoading] = useTransition();
  const [submitting, startSubmitting] = useTransition();
  // Next-available lookup state. Distinct from loadingSlots so the slot
  // panel can keep its existing "Loading slots…" message while the
  // dedicated "Next available" button shows its own pending text. When
  // the lookup resolves with date===null we surface a calm exhausted-
  // horizon message.
  const [findingNext, startFindingNext] = useTransition();
  const [nextSearched, setNextSearched] = useState(false);
  const [noneInHorizon, setNoneInHorizon] = useState(false);
  // PR A (prev/next availability nav): client-side stack of the dates the
  // visitor jumped AWAY FROM via "Next available", so they can step back to a
  // prior suggested day. Purely local state — no DB, no new server action.
  // Stepping back re-runs the normal slot fetch for that day (fresh slots +
  // normal validation, never a stale/cached slot). Reset when the service
  // changes, since availability is service-specific.
  const [dateHistory, setDateHistory] = useState<string[]>([]);

  // Keep the picker's selected serviceId pinned to the currently
  // visible bucket. When clientType flips between new and existing,
  // the visibleServices set changes; if the previously-selected id
  // is no longer in that set, fall back to the first service in the
  // new bucket (or the empty-string sentinel when the bucket is
  // empty, which the form treats as "no service available"). Side
  // effect of changing serviceId triggers the slot-fetch effect
  // below, which clears the picked slot and refreshes the list.
  useEffect(() => {
    if (clientType == null) return;
    const stillVisible = visibleServices.some((s) => s.id === serviceId);
    if (stillVisible) return;
    setServiceId(visibleServices[0]?.id ?? "");
    // visibleServices is derived from `services` + `clientType` and is
    // stable across renders that don't change either input, so this
    // effect runs only on real clientType transitions or service-list
    // refreshes.
  }, [clientType, visibleServices, serviceId]);

  // Single source of truth for the slots fetch: re-runs only when slug,
  // serviceId, date, or clientType actually change. Race-safe via a
  // cancellation flag.
  //
  // No-network-before-choice guard: while clientType === null the
  // ClientTypeChooser is rendered, but this effect still runs because
  // hooks must be called unconditionally. We short-circuit BEFORE
  // calling fetchPublicSlotsAction so the first-step page load makes
  // zero public booking API calls and any stale slot list / picked
  // slot from a previous choice is cleared at the same time. The
  // request-cancellation flag handles the unrelated race where slug,
  // serviceId, or date change while a fetch is in flight.
  useEffect(() => {
    if (clientType == null || !serviceId || !date) {
      setSlots([]);
      setPicked(null);
      setError(null);
      setNextSearched(false);
      setNoneInHorizon(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setPicked(null);
    // Reset next-available state when the underlying query changes.
    // A previous "no availability in horizon" verdict was specific to the
    // old service/date pair; clear it so the new pair gets a fresh probe.
    setNextSearched(false);
    setNoneInHorizon(false);
    startLoading(async () => {
      const r = await fetchPublicSlotsAction({ slug, serviceId, date });
      if (cancelled) return;
      if (!r.ok) {
        setError(r.error);
        setSlots([]);
        return;
      }
      setSlots(r.slots);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, serviceId, date, clientType]);

  // Availability is service-specific, so a prior service's "next available"
  // history is meaningless after a service switch — reset it. (Runs on mount
  // too, which is a no-op since it starts empty.) Not tied to `date`, so a
  // normal next/previous jump never wipes the stack.
  useEffect(() => {
    setDateHistory([]);
  }, [serviceId]);

  function onService(v: string) {
    setServiceId(v);
  }
  function onDate(v: string) {
    setDate(v);
  }

  // Server-side "Next available" jump. One server round-trip walks
  // forward from today/selected-date through the booking horizon and
  // returns the first date with bookable future slots. The slot-fetch
  // useEffect above re-runs automatically when `date` changes.
  //
  // Two render surfaces share this handler (PR #131):
  //   1. The empty-slot path ("Next available" button). Shown when
  //      the currently displayed date has zero slots; the original
  //      behaviour.
  //   2. The populated-slot path ("Next available day" button).
  //      Shown when slots ARE available but the visitor wants to
  //      jump forward to the next bookable day after the currently
  //      displayed one.
  // Both surfaces start the lookup from addOneDayLocal(date), so
  // "next available day" always advances from whatever date is on
  // screen right now (including a manually picked date or the
  // result of a previous Next-day click). The server clamps to
  // today and to studio.public_booking_horizon_months; the same
  // MAX_NEXT_AVAILABLE_SCAN_DAYS=200 belt-and-braces cap applies.
  function onFindNext() {
    // Same no-network-before-choice guard as the slot-fetch effect:
    // until the visitor picks a client type, neither button is
    // rendered, but a stale event handler or test harness could
    // still invoke this. Bail before the action call so the public
    // surface stays silent.
    if (clientType == null) return;
    if (!serviceId) return;
    setError(null);
    setNextSearched(false);
    setNoneInHorizon(false);
    // Start the lookup from the day AFTER the currently-selected
    // date. Regardless of which surface invoked us, we advance from
    // the date in state, so clicking the populated-path button
    // multiple times keeps walking forward, and manually picking a
    // calendar date and then clicking starts the next search from
    // that manual date.
    const startFrom = addOneDayLocal(date);
    startFindingNext(async () => {
      const r = await fetchNextAvailableDateAction({
        slug,
        serviceId,
        fromDate: startFrom,
      });
      setNextSearched(true);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.date == null) {
        setNoneInHorizon(true);
        return;
      }
      // Remember the day we're leaving so "Back to previous result" can return
      // to it. `date` here is the currently-displayed day (pre-jump).
      setDateHistory((h) => pushAvailabilityHistory(h, date));
      setDate(r.date);
    });
  }

  // Step back to the previously-suggested availability. Pops the history stack
  // and re-selects that date; the slot-fetch effect above then refreshes that
  // day's slots (so a returned day is always shown with live, validated slots —
  // never a stale one). No booking happens here.
  function onPrevious() {
    const { previous, rest } = popAvailabilityHistory(dateHistory);
    if (previous == null) return;
    setError(null);
    setNextSearched(false);
    setNoneInHorizon(false);
    setDateHistory(rest);
    setDate(previous);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (clientType == null) {
      // Should be impossible from the rendered UI (the form is only
      // shown after a choice), but guard anyway so a stale state
      // never silently drops the client_type field on submit.
      setError("Please choose new or existing client first.");
      return;
    }
    if (!picked) {
      setError("Pick a time first.");
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("client_type", clientType);
    fd.set("service_id", serviceId);
    fd.set("starts_at", picked.start);
    fd.set("name", name);
    fd.set("email", email);
    fd.set("phone", phone);
    // Existing clients answer one optional "anything to know" note;
    // new clients keep the existing two-field "areas wanted" + "notes"
    // shape because consultations need that context up front. Both
    // paths flatten into the single appointments.notes column.
    fd.set(
      "notes",
      clientType === "existing"
        ? notes.trim()
        : combineAreasAndNotes(areasWanted, notes),
    );
    fd.set("sms_consent", smsConsent ? "true" : "false");
    fd.set(MARKETING_CONSENT_FIELD, marketingConsent ? "true" : "false");
    // PR #163. Optional "How did you hear about us?" answer. Empty
    // string means the visitor did not answer; the action layer
    // normalises that to null. Allowed values are validated
    // server-side via parseReferralSource from
    // lib/booking/referral-source.ts.
    fd.set("referral_source", referralSource);
    startSubmitting(async () => {
      const r = await publicBookAppointmentAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Snapshot the selected service + date + email at success time so the
      // confirmation card stays stable even if local form state is later
      // cleared on unmount or a re-render.
      const bookedService =
        services.find((s) => s.id === serviceId) ?? null;
      setDone({
        when: picked.startLabel,
        dateLocal: date,
        service: bookedService,
        email,
      });
    });
  }

  if (done) {
    return (
      <ConfirmationView
        confirmation={done}
        studioName={studioName}
        studioAddress={studioAddress}
      />
    );
  }

  if (services.length === 0) {
    return (
      <p className="text-sm text-[#6B6B6B]">
        This studio isn&rsquo;t accepting bookings yet. Please reach out
        directly.
      </p>
    );
  }

  // First-step: client-side new/existing choice. Until a type is
  // picked the full booking form (service + date + slots + identity)
  // is NOT rendered, which means no slot fetch and no email lookup
  // are triggered. Picking a button does not call the server. The
  // identity-leak surface stays minimal: until submit, we never
  // disclose whether an email exists.
  if (clientType == null) {
    return (
      <ClientTypeChooser
        studioName={studioName}
        onChoose={setClientType}
      />
    );
  }

  // Existing-client path now routes to the secure client portal
  // rather than rendering the full public booking form. The pilot
  // wants returning clients to manage and (eventually) book through
  // the portal so they do not re-type name / phone / SMS consent on
  // every visit. The server action's existing-client guard from
  // PR #120 stays in place as defence in depth (the action will
  // refuse client_type=existing without an active match), but no
  // UI path here submits to it; the existing-client branch of the
  // form is intentionally unreachable from the rendered surface.
  // Full removal of the unreachable existing-client form fields is
  // deferred to a follow-up cleanup PR.
  if (clientType === "existing") {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[13px]" style={{ color: "#6B6B6B" }}>
            Booking as an{" "}
            <strong className="font-medium text-[#0A0A0A]">
              existing client
            </strong>
            .
          </p>
          <button
            type="button"
            onClick={() => setClientType(null)}
            className="text-[13px] underline"
            style={{ color: "#6B6B6B" }}
          >
            Change
          </button>
        </div>
        <div
          className="flex flex-col gap-4 p-6"
          style={{
            backgroundColor: "#FAFAF7",
            border: "1px solid #E5E2D9",
          }}
        >
          <h2
            className="font-[var(--font-fraunces)] text-[22px] font-bold leading-tight md:text-[26px]"
            style={{ letterSpacing: "-0.02em" }}
          >
            Already a {studioName} client?
          </h2>
          <p className="text-[15px] leading-relaxed text-[#0A0A0A]">
            Sign in to your secure client portal to manage your upcoming
            appointments.
          </p>
          <a
            href={`/portal/login?studio=${encodeURIComponent(slug)}`}
            className="self-start px-6 py-3 text-[13px] font-medium uppercase"
            style={{
              backgroundColor: "#0A0A0A",
              color: "#FAFAF7",
              letterSpacing: "0.1em",
            }}
          >
            Sign in to client portal
          </a>
          <p className="text-[12px]" style={{ color: "#6B6B6B" }}>
            Use the email {studioName} has on file.
          </p>
        </div>
      </div>
    );
  }

  // New-client + no consultation service published: surface a calm
  // generic message and let the visitor switch back to existing. We
  // do NOT fall through to showing every active service; the spec
  // is explicit that new clients must not see non-consultation
  // services. The studio name is interpolated only as the page
  // anchor; the message itself does not expose service catalogue
  // state beyond "consultation is not set up".
  if (clientType === "new" && consultationServices.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[15px] leading-[1.6]">
          Online consultation booking is not set up yet. Please contact{" "}
          {studioName}.
        </p>
        <button
          type="button"
          onClick={() => setClientType(null)}
          className="self-start text-[13px] underline"
          style={{ color: "#6B6B6B" }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-8">
      {/* Small client-type bar so the visitor can see (and undo)
          their choice. Plain underlined Change link rather than a
          full segmented control so it does not compete with the
          form. */}
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px]" style={{ color: "#6B6B6B" }}>
          Booking as a{" "}
          <strong className="font-medium text-[#0A0A0A]">
            {clientType === "new" ? "new client" : "existing client"}
          </strong>
          .
        </p>
        <button
          type="button"
          onClick={() => setClientType(null)}
          className="text-[13px] underline"
          style={{ color: "#6B6B6B" }}
        >
          Change
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Service" required>
          <select
            value={serviceId}
            onChange={(e) => onService(e.target.value)}
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          >
            {groups.map((group) =>
              groups.length === 1 && group.modality === null ? (
                // Single ungrouped bucket: skip the optgroup wrapper so the
                // dropdown reads as a flat list without an "Other" heading.
                group.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {formatServiceLabel(s)}
                  </option>
                ))
              ) : (
                <optgroup key={group.modality ?? "_other"} label={group.label}>
                  {group.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {formatServiceLabel(s)}
                    </option>
                  ))}
                </optgroup>
              ),
            )}
          </select>
        </Field>
        <Field label="Date" required>
          <input
            type="date"
            value={date}
            min={minDate}
            max={maxDate}
            onChange={(e) => onDate(e.target.value)}
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <span
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          {`Available times for ${formatLocalDate(date)}`}
        </span>
        {loadingSlots ? (
          <p className="text-sm text-[#6B6B6B]">Loading slots…</p>
        ) : slots.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[#6B6B6B]">
              {`No availability on ${formatLocalDate(date)}.`}
            </p>
            {noneInHorizon ? (
              <p className="text-sm text-[#6B6B6B]">
                No availability within the current booking window. Please
                check back later or contact the studio.
              </p>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onFindNext}
                  disabled={findingNext}
                  className="px-3 py-1.5 text-xs font-medium uppercase disabled:opacity-50"
                  style={{
                    border: "1px solid #0A0A0A",
                    backgroundColor: "transparent",
                    color: "#0A0A0A",
                    letterSpacing: "0.1em",
                  }}
                >
                  {findingNext ? "Finding…" : "Next available"}
                </button>
                {nextSearched && (
                  <span className="text-xs text-[#6B6B6B]">
                    Tap a time to confirm.
                  </span>
                )}
              </div>
            )}
            {dateHistory.length > 0 && (
              <button
                type="button"
                onClick={onPrevious}
                disabled={findingNext}
                className="self-start px-3 py-1.5 text-xs font-medium uppercase disabled:opacity-50"
                style={{
                  border: "1px solid #0A0A0A",
                  backgroundColor: "transparent",
                  color: "#0A0A0A",
                  letterSpacing: "0.1em",
                }}
              >
                Back to previous result
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => {
                const sel = picked?.start === s.start;
                return (
                  <button
                    key={s.start}
                    type="button"
                    onClick={() => setPicked(s)}
                    className={`px-4 py-2 text-sm transition ${
                      sel
                        ? "bg-[#0A0A0A] text-[#FAFAF7]"
                        : "bg-white text-[#0A0A0A] hover:bg-[#F5F2EB]"
                    }`}
                    style={{ border: "1px solid #0A0A0A" }}
                  >
                    {s.startLabel}
                  </button>
                );
              })}
            </div>

            {/* PR #131. "Next available day" jump from a date that
                already HAS slots. The pilot friction Chloe surfaced
                was that once any slot appeared, the existing "Next
                available" button disappeared, so a client whose
                preferred times don't fit had to click calendar dates
                one by one. We reuse the same onFindNext handler
                (which already starts from addOneDayLocal(date) and
                hits the same fetchNextAvailableDateAction with the
                same studio.public_booking_horizon_months horizon and
                MAX_NEXT_AVAILABLE_SCAN_DAYS=200 server-side cap), so
                the search semantics are identical to the existing
                button. The only difference is the surface: this one
                renders when slots.length > 0. The boundary message
                below is the spec's "No later availability is
                currently published. Please contact the studio." line
                shown when the server returns date: null. */}
            {noneInHorizon ? (
              <p className="text-sm text-[#6B6B6B]">
                No later availability is currently published. Please
                contact the studio.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs" style={{ color: "#6B6B6B" }}>
                  Do these times not work? Check the next available day.
                </p>
                <button
                  type="button"
                  onClick={onFindNext}
                  disabled={findingNext}
                  className="self-start px-3 py-1.5 text-xs font-medium uppercase disabled:opacity-50"
                  style={{
                    border: "1px solid #0A0A0A",
                    backgroundColor: "transparent",
                    color: "#0A0A0A",
                    letterSpacing: "0.1em",
                  }}
                >
                  {findingNext ? "Finding next day..." : "Next available day"}
                </button>
              </div>
            )}
            {dateHistory.length > 0 && (
              <button
                type="button"
                onClick={onPrevious}
                disabled={findingNext}
                className="self-start px-3 py-1.5 text-xs font-medium uppercase disabled:opacity-50"
                style={{
                  border: "1px solid #0A0A0A",
                  backgroundColor: "transparent",
                  color: "#0A0A0A",
                  letterSpacing: "0.1em",
                }}
              >
                Back to previous result
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Your name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
        <Field label="Email" required>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
      </div>

      <Field label="Phone" required>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          className="w-full bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </Field>

      {/* SMS consent. Opt-in only; not required. The server-side
          consent rule only stamps sms_consent_at when this is true
          AND (new client OR submitted phone normalizes to the stored
          phone for an existing client). Helper line names STOP so the
          client knows the exit before they consent. */}
      <label className="flex items-start gap-3 text-[14px] leading-[1.5]">
        <input
          type="checkbox"
          checked={smsConsent}
          onChange={(e) => setSmsConsent(e.target.checked)}
          className="mt-1 h-4 w-4 flex-none"
        />
        <span>
          <span className="block">
            Text me appointment confirmations and reminders.
          </span>
          <span
            className="mt-1 block text-[12px]"
            style={{ color: "#6B6B6B" }}
          >
            You can reply STOP at any time. Email will still be used
            for appointment messages.
          </span>
        </span>
      </label>

      {/* Optional marketing/analytics consent. Opt-in only; never
          prechecked; separate from SMS + treatment + payment consents.
          Declining does NOT block booking. Value is captured into
          booking_tracking_consents (migration 0106); no provider is wired
          and no data is sent from this form. Compacted UI: a short visible
          label so this optional item does not overshadow the booking task,
          with the full privacy explanation moved into a collapsed <details>
          (the checkbox, its default-unchecked state, and the submitted value
          are unchanged). */}
      <div className="text-[14px] leading-[1.5]">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={marketingConsent}
            onChange={(e) => setMarketingConsent(e.target.checked)}
            className="mt-1 h-4 w-4 flex-none"
          />
          <span>Optional: help this studio measure ad performance.</span>
        </label>
        <details className="ml-7 mt-1 text-[12px]" style={{ color: "#6B6B6B" }}>
          <summary className="cursor-pointer">What does this mean?</summary>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
            <li>
              The studio may use privacy-safe marketing and analytics tools.
            </li>
            <li>Hone does not send clinical or treatment details.</li>
            <li>You can book even if you leave this unchecked.</li>
          </ul>
        </details>
      </div>

      {/* Areas-wanted question is for new clients only. Existing
          clients have already discussed treatment areas during their
          consultation and intake, so a returning visitor sees just
          one optional "anything to know" line. The submit handler
          flattens both into the single appointments.notes column. */}
      {clientType === "new" && (
        <Field
          label="What areas are you wanting treated?"
          helperText="For example: upper lip, chin, underarms, bikini line."
        >
          <textarea
            rows={2}
            value={areasWanted}
            onChange={(e) => setAreasWanted(e.target.value)}
            className="w-full resize-none bg-transparent py-2 text-[16px] outline-none"
            style={{ borderBottom: "1px solid #0A0A0A" }}
          />
        </Field>
      )}

      {/* Existing-client path early-returns above with the portal
          sign-in card, so only the new-client branch reaches this
          field; the previous existing-client label is no longer
          reachable from the UI. */}
      <Field label="Anything else?">
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full resize-none bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </Field>

      {/* PR #163. Booking attribution. Optional dropdown that captures
          "How did you hear about us?" at booking time. Helper text
          stays low-key so it does not feel like a required question.
          Allowed values + display labels live in
          lib/booking/referral-source.ts so this list, the action's
          validation, and the practitioner-facing display all read
          from one place. */}
      <Field
        label="How did you hear about us?"
        helperText="Optional. Helps the studio understand where new clients come from."
      >
        <select
          name="referral_source"
          value={referralSource}
          onChange={(e) => setReferralSource(e.target.value)}
          className="w-full bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        >
          <option value="">Select an option (optional)</option>
          {REFERRAL_SOURCE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={submitting}
          className="px-8 py-4 text-[14px] font-medium uppercase disabled:opacity-50"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FAFAF7",
            letterSpacing: "0.1em",
          }}
        >
          {submitting ? "Booking…" : "Book appointment"}
        </button>
        {error && (
          <span className="text-[13px] text-red-600">{error}</span>
        )}
      </div>
    </form>
  );
}

// First-step new/existing choice. Renders a heading, a short
// explanation, and two buttons. No network call on click, no email
// lookup, no slot fetch: the parent simply flips clientType and
// re-renders into the full booking form. Studio name is the only
// dynamic piece in the copy.
function ClientTypeChooser({
  studioName,
  onChoose,
}: {
  studioName: string;
  onChoose: (type: "new" | "existing") => void;
}) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <h2
          className="font-[var(--font-fraunces)] text-[28px] font-bold leading-tight md:text-[34px]"
          style={{ letterSpacing: "-0.02em" }}
        >
          Are you new to {studioName}?
        </h2>
        <p className="text-[15px] leading-[1.6]" style={{ color: "#3F3F3F" }}>
          New clients start with a consultation so {studioName} can review
          your goals, health history, and treatment plan before booking
          treatment time.
        </p>
      </div>
      {/* PR #138 Part 1. Move backgroundColor + border off the
          inline style attribute so the hover variants below
          actually win. Inline style has higher CSS specificity than
          Tailwind utilities; the prior version kept bg pinned to
          beige via inline style while the hover utility tried to
          flip it to dark, so on hover the bg stayed beige AND the
          text flipped to beige -> invisible text. Moving every
          state-dependent style into Tailwind classes lets the
          default + hover + focus-visible states all paint
          correctly. focus-visible:ring keeps keyboard navigation
          readable. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <button
          type="button"
          onClick={() => onChoose("new")}
          className="flex flex-col items-start gap-1 border border-[#0A0A0A] bg-[#FAFAF7] px-6 py-4 text-left text-[#0A0A0A] transition hover:bg-[#0A0A0A] hover:text-[#FAFAF7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0A0A0A] focus-visible:ring-offset-2"
        >
          <span className="text-[15px] font-medium uppercase tracking-[0.1em]">
            I&rsquo;m a new client
          </span>
          <span className="text-[12px] opacity-80">
            Start with a consultation.
          </span>
        </button>
        <button
          type="button"
          onClick={() => onChoose("existing")}
          className="flex flex-col items-start gap-1 border border-[#0A0A0A] bg-[#FAFAF7] px-6 py-4 text-left text-[#0A0A0A] transition hover:bg-[#0A0A0A] hover:text-[#FAFAF7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0A0A0A] focus-visible:ring-offset-2"
        >
          <span className="text-[15px] font-medium uppercase tracking-[0.1em]">
            I&rsquo;m an existing client
          </span>
          <span className="text-[12px] opacity-80">
            For returning {studioName} clients. Use the email {studioName}{" "}
            has on file.
          </span>
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  helperText,
  children,
}: {
  label: string;
  required?: boolean;
  helperText?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
      >
        {label}
        {required && (
          <span
            aria-hidden
            className="ml-1 text-red-600 normal-case"
            style={{ letterSpacing: "0" }}
          >
            *
          </span>
        )}
      </span>
      {children}
      {helperText && (
        <span className="text-xs text-[#6B6B6B]">{helperText}</span>
      )}
    </label>
  );
}

// Public booking confirmation surface. Pure display — no actions, no
// fetches, no side effects. The booking has already been created and
// the confirmation email already dispatched by the server action by
// the time this renders.
function ConfirmationView({
  confirmation,
  studioName,
  studioAddress,
}: {
  confirmation: Confirmation;
  studioName: string;
  studioAddress: string | null;
}) {
  const formattedDate = formatLocalDate(confirmation.dateLocal);
  const serviceName = confirmation.service?.name ?? null;
  const durationMinutes =
    confirmation.service?.default_duration_minutes ?? null;
  return (
    <div className="flex flex-col gap-8">
      <div>
        <span
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          Confirmed
        </span>
        <h2
          className="font-[var(--font-fraunces)] mt-3 text-[32px] font-bold leading-tight md:text-[40px]"
          style={{ letterSpacing: "-0.025em" }}
        >
          Your appointment is booked
        </h2>
      </div>

      {/* Appointment summary card. Service + date + time + studio, in
          that scan order. */}
      <dl
        className="flex flex-col gap-3 p-6"
        style={{
          backgroundColor: "#FAFAF7",
          border: "1px solid #E5E2D9",
        }}
      >
        {serviceName && (
          <ConfirmationRow label="Service">
            {serviceName}
            {durationMinutes != null && (
              <span style={{ color: "#6B6B6B" }}> · {durationMinutes} min</span>
            )}
          </ConfirmationRow>
        )}
        <ConfirmationRow label="When">
          <span className="font-medium">{formattedDate}</span>
          <span style={{ color: "#6B6B6B" }}> · {confirmation.when}</span>
        </ConfirmationRow>
        <ConfirmationRow label="Where">
          <span className="font-medium">{studioName}</span>
          {studioAddress && (
            <>
              <br />
              <span style={{ color: "#6B6B6B" }}>{studioAddress}</span>
            </>
          )}
        </ConfirmationRow>
      </dl>

      {/* What happens next — three short lines. */}
      <div className="flex flex-col gap-3">
        <h3
          className="text-[12px] font-medium uppercase"
          style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
        >
          What happens next
        </h3>
        <ul className="flex flex-col gap-2 text-[16px] leading-relaxed text-[#0A0A0A]">
          <li>
            We sent a confirmation to{" "}
            <strong>{confirmation.email}</strong>, with a calendar invite.
          </li>
          <li>
            The email includes links to cancel or reschedule if your plans
            change.
          </li>
          <li>
            If your studio asks for a health intake, you&rsquo;ll receive
            that link too.
          </li>
        </ul>
      </div>

      {/* Subtle payment reassurance. Phase 1 booking does not collect
          cards; making this explicit prevents the "did I miss a step?"
          worry. Kept small + muted. */}
      <p className="text-[13px]" style={{ color: "#6B6B6B" }}>
        No payment was collected for this booking.
      </p>
    </div>
  );
}

function ConfirmationRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
      <dt
        className="flex-none text-[11px] font-medium uppercase sm:w-20"
        style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
      >
        {label}
      </dt>
      <dd className="text-[15px] text-[#0A0A0A]">{children}</dd>
    </div>
  );
}
