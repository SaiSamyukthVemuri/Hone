"use client";

import { useReducer } from "react";

import { isConsultationService } from "@/lib/booking/consultation";
import { buttonClasses } from "@/components/ui/button";
import { cx } from "@/components/ui/control-base";
import { fieldControlClass } from "@/components/ui/field";
import { SectionLabel } from "@/components/ui/section-label";
import {
  ALLOWED_DAYS_PRESET_LABEL,
  BOOKING_WINDOW_PRESETS,
  TTL_PRESETS,
  WEEKDAYS_IN_DISPLAY_ORDER,
  activeAllowedDaysPreset,
  activeTtlPreset,
  activeWindowPreset,
  scopeSummary,
  sendState,
  validateDraft,
  type AllowedDaysPreset,
  type DraftFieldId,
  type InviteDraft,
  waitlistDomId,
  COMPOSER_FIELD_NAMES,
  CUSTOM_PRESET_VALUE,
  composerReducer,
  initialComposerState,
  type ComposerEvent,
  type ComposerState,
  type InviteComposerAction,
} from "@/lib/waitlist/b4-invitation-draft";
import {
  adapterMissingReason,
  type AdapterCapabilities,
} from "@/lib/waitlist/invite-to-book-contract";

// ===========================================================================
// WAIT-03 B4 — the invitation composer
// ===========================================================================
//
// ONE SCREEN, FOUR QUESTIONS, ONE SEND. Not a wizard.
//
// The earlier revision was a six-step rail — who, service, horizon, days,
// expiry, review — with a numbered progress strip across the top. Every step
// but one held a single control, so the rail was five screens of navigation
// wrapped around four decisions, and the practitioner could not see what they
// had chosen without walking back through it. Inviting one person to book is
// not a workflow; it is a short form with sensible defaults, and every field
// below already has one.
//
// WHO is not a step here either. The composer opens FROM a row, so the person
// is already chosen and is named in the heading. Choosing people inside the
// composer is what made "invite these five" and "invite the next five" look
// like one control, when they are two different commands against two different
// server contracts — and only one of them accepts a list of people at all.
//
// STATE IS A PROP. `draft` and `serviceName` are supplied by the caller, so
// this component holds none and needs no client boundary — the same rule the
// Button primitive follows with `pending`. WHICH PRESET READS AS PRESSED IS
// DERIVED from the draft's value rather than passed alongside it; see the note
// on `activeWindowPreset`.
//
// EVERY FIELD IS A REQUIREMENT ON B2, NOT A NOTE TO SELF. The earlier revision
// badged service, window and days "Not enforced yet" and let the send proceed
// anyway, which is a form that asks a question it intends to discard. The
// ruling is now the other way round: the scope is part of the invitation, the
// adapter contract demands it, and an adapter that cannot carry it refuses the
// send instead of quietly widening it.

/** The id an error message carries, and the id a control points at. ONE
 *  function, so a control can never reference an id the message does not use —
 *  a dangling `aria-describedby` announces that an explanation exists and then
 *  has none to give, which is worse than no association at all.
 *
 *  NAMESPACED PER ENTRY, through the same factory the row uses. These were
 *  global constants — `composer-error-service`, `composer-label-days`,
 *  `composer-send-reason` — so two mounted composers emitted identical ids and
 *  the second one's `aria-labelledby`/`aria-describedby` resolved to the FIRST
 *  one's content: a screen reader announcing another person's validation error.
 *  That is the row's own id-collision defect, repeated one component over in
 *  the same change, which is why the factory now lives in one place. */
export function composerErrorId(entryId: string, field: DraftFieldId): string {
  return waitlistDomId(entryId, `composer-error-${field}`);
}

function composerLabelId(entryId: string, field: DraftFieldId): string {
  return waitlistDomId(entryId, `composer-label-${field}`);
}

function FieldSection({
  entryId,
  id,
  title,
  error,
  children,
}: {
  entryId: string;
  id: DraftFieldId;
  title: string;
  error?: string;
  children: React.ReactNode;
}) {
  const errorId = error ? composerErrorId(entryId, id) : undefined;
  return (
    <section
      data-testid={`composer-field-${id}`}
      // ONE COLUMN AT EVERY WIDTH. The composer is used on a phone between
      // clients; a two-column form would put the presets beside their label and
      // halve the touch targets to do it.
      className="flex flex-col gap-2 border-b border-line px-4 py-4 last:border-b-0"
    >
      {/* The id lives on a wrapper rather than on `SectionLabel`, which is a
          shipped primitive with no `id` prop. Widening a live primitive to suit
          an unwired prototype is exactly the wrong direction of dependency. */}
      <span id={composerLabelId(entryId, id)}>
        <SectionLabel size="caption">{title}</SectionLabel>
      </span>
      {children}
      {error && (
        <span
          id={errorId}
          data-testid={`composer-error-${id}`}
          className="text-xs leading-snug text-danger"
        >
          {error}
        </span>
      )}
    </section>
  );
}

/**
 * A preset, as a REAL RADIO that happens to look like a pill.
 *
 * It was a `type="button"` with `aria-pressed`, which looked operable and
 * submitted nothing: no name, no value, no form. A radio carries the answer
 * natively, so choosing one is a choice the browser will actually send, and the
 * selected state comes from `:checked` rather than from a prop that only the
 * server could change.
 *
 * The input is `sr-only` rather than hidden — it stays focusable and reachable,
 * and the visible pill is its label, so the whole box is the target. The border
 * still carries selection, never colour alone: several studios' staff are
 * colour-blind and the presets are otherwise identical boxes.
 */
function PresetRadio({
  name,
  value,
  testId,
  checked,
  onSelect,
  children,
}: {
  name: string;
  value: string | number;
  testId: string;
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className="block w-full sm:w-auto">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        data-testid={testId}
        className="peer sr-only"
      />
      <span
        className={cx(
          buttonClasses({ variant: "secondary", size: "sm", fullWidth: true }),
          "sm:w-auto",
          "peer-checked:border-accent peer-checked:text-accent",
          "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
        )}
      >
        {children}
      </span>
    </label>
  );
}

/** A weekday, as a real checkbox. Same reasoning as `PresetRadio`: the group
 *  submits `allowed_weekdays` natively, so an empty group is genuinely "any
 *  day" rather than a prop nobody can change. */
function WeekdayCheckbox({
  value,
  testId,
  checked,
  onToggle,
  children,
}: {
  value: number;
  testId: string;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <input
        type="checkbox"
        name={COMPOSER_FIELD_NAMES.allowedWeekdays}
        value={value}
        checked={checked}
        onChange={(event) => onToggle(event.currentTarget.checked)}
        data-testid={testId}
        className="peer sr-only"
      />
      <span
        className={cx(
          buttonClasses({ variant: "secondary", size: "sm" }),
          // A 44px floor with three-letter labels needs a width floor too, or
          // the box is taller than it is wide and reads as a mis-render.
          "min-w-[3.25rem]",
          "peer-checked:border-accent peer-checked:text-accent",
          "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
        )}
      >
        {children}
      </span>
    </label>
  );
}

/**
 * The composer, holding the practitioner's live answers.
 *
 * A CLIENT COMPONENT, AND ONLY THIS ONE. It was server-rendered from a frozen
 * `draft` prop while the browser's own controls moved independently, so the
 * summary, the validation and the Send state all described a draft the
 * practitioner had already changed. Interaction state is the smallest thing
 * that fixes that, and it is all this boundary buys: no data fetching, no
 * authority, no mutation. The form's action still comes from outside.
 */
export function InviteComposer(props: InviteComposerProps) {
  const [state, dispatch] = useReducer(composerReducer, props.draft, initialComposerState);
  return <InviteComposerView {...props} state={state} dispatch={dispatch} />;
}

export type InviteComposerProps = {
  /** Namespaces every id this composer emits, so two mounted composers cannot
   *  cross-reference each other's labels and errors. */
  entryId: string;
  /** The person this invitation is for. Already chosen — the composer opens
   *  from their row, and choosing again here is how a single invitation and a
   *  bulk claim end up looking like one control. */
  entryName: string;
  draft: InviteDraft;
  /**
   * Every service the studio offers — UNFILTERED. The composer applies
   * `isConsultationService` itself rather than trusting a caller to have done
   * it, which is why `modality` is required here: the predicate reads it, and a
   * `{ id, name }` shape could not express the question at all.
   *
   * THE SAME PREDICATE THE BOOKING SURFACE USES. `lib/booking/consultation.ts`
   * exists so the visible service filter and the server-side guard cannot drift
   * apart — its own header says so — and an invitation is an offer to book
   * exactly through that surface. A separate rule here would let a
   * practitioner scope an invitation to a service the invitee's own booking
   * page will not show them.
   */
  services: ReadonlyArray<{ id: string; name: string; modality: string | null }>;
  /** `null` until an adapter satisfying `WaitlistInvitationAdapter` is bound. */
  capabilities?: AdapterCapabilities | null;
  /**
   * The submission binding. `null` until the integration supplies its server
   * action, and while it is null the send control is DISABLED rather than
   * rendered as a button that quietly does nothing.
   *
   * This component never calls a database, never resolves who is acting, and
   * never decides whether the command is allowed. It collects four answers and
   * hands them over.
   */
  action?: InviteComposerAction | null;
  /** Dismissal, bound the same way. A Cancel with nothing behind it is disabled
   *  for the same reason the send is. */
  cancelAction?: InviteComposerAction | null;
};

/**
 * The rendering half, PURE and exported so the whole surface can be proved
 * against any state the reducer can reach.
 *
 * This repo has no jsdom and no testing-library — several suites say so in their
 * own comments — so a click cannot be dispatched here. Splitting the view from
 * the state is what makes the invariant provable anyway: drive the reducer
 * through an interaction, render the state it produces, and check that what is
 * VISIBLE, what VALIDATES and what would be SUBMITTED are the same three
 * answers.
 */
export function InviteComposerView({
  entryId,
  entryName,
  services,
  capabilities = null,
  action = null,
  cancelAction = null,
  state,
  dispatch,
}: InviteComposerProps & {
  state: ComposerState;
  dispatch: (event: ComposerEvent) => void;
}) {
  const draft = state.draft;
  // FILTERED ONCE, then used for everything. Rendering and validation read the
  // same list, so a service the practitioner cannot see is also one the draft
  // cannot be valid for — the two could otherwise disagree, and the payload
  // would carry an id the select never offered.
  const bookableServices = services.filter((s) => isConsultationService(s));
  // The service list is part of validation, not just of rendering: a
  // `serviceId` that is no longer in it must invalidate the draft rather than
  // fall back to "any service" in the summary while the payload keeps the
  // stale id.
  const draftContext = { serviceIds: bookableServices.map((s) => s.id) };
  const validation = validateDraft(draft, draftContext);
  const errors = validation.ok ? {} : validation.errors;
  const send = sendState(draft, capabilities, draftContext);
  // MODES COME FROM THE STATE, NOT FROM THE VALUE. Re-deriving them each render
  // would take the custom field away the moment a typed number happened to
  // match a preset, mid-edit.
  const windowPreset = state.windowMode;
  const daysPreset = state.daysMode;
  const ttlPreset = state.expiryMode;
  const selectedService =
    bookableServices.find((s) => s.id === draft.serviceId) ?? null;
  const serviceName = selectedService?.name ?? null;
  // A chosen-but-missing service must not read as "any service" in the summary.
  // The draft is invalid in that case, so the summary is withheld entirely
  // rather than describing a scope the send would not carry.
  const serviceMissing = draft.serviceId !== null && selectedService === null;

  // NO BINDING MEANS NO OPERABLE SEND. The capability gate is unchanged and
  // still decides on its own; this only adds the second reason a send can be
  // impossible — nothing is listening yet.
  const unbound = action === null;
  const sendDisabled = send.disabled || unbound;
  const sendReason =
    send.reason ?? (unbound ? adapterMissingReason("Send invitation") : undefined);

  return (
    <form
      action={action ?? undefined}
      className="flex flex-col"
      data-testid="invite-composer"
    >
      {/* The entry is the one fact the form carries that is not one of the four
          questions, and it is an IDENTIFIER, not authority: the server still
          decides whether this practitioner may act on it. */}
      <input type="hidden" name={COMPOSER_FIELD_NAMES.entryId} value={entryId} />
      <header className="px-4 py-4">
        <h2 className="text-base font-medium text-fg">
          Invite {entryName} to book
        </h2>
      </header>

      <FieldSection entryId={entryId} id="service" title="Service" error={errors.service}>
        {/* The visible section heading IS this control's label, referenced
            rather than repeated: an `sr-only` copy of the same word made a
            screen reader announce "Service" twice. */}
        <select
          name={COMPOSER_FIELD_NAMES.serviceId}
          data-testid="composer-service"
          aria-labelledby={composerLabelId(entryId, "service")}
          // THE CONTROL CARRIES THE RELATIONSHIP, not just the section. A
          // screen-reader user lands on the select, not on the paragraph
          // underneath it, so without this they are told the field is invalid
          // and never told why Send is blocked.
          aria-invalid={errors.service ? true : undefined}
          aria-describedby={errors.service ? composerErrorId(entryId, "service") : undefined}
          value={draft.serviceId ?? ""}
          onChange={(event) =>
            dispatch({
              type: "service",
              // "Any service" is a real answer and it is the empty option.
              serviceId: event.currentTarget.value === "" ? null : event.currentTarget.value,
            })
          }
          className={fieldControlClass()}
        >
            {/* "Any service" is a real answer, not an empty one. A studio that
                does not mind which service the invitee books should not have to
                pick one to get past this field. */}
          <option value="">Any service</option>
          {bookableServices.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
      </FieldSection>

      <FieldSection entryId={entryId} id="window" title="Booking window" error={errors.window}>
        <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {BOOKING_WINDOW_PRESETS.map((preset) => (
            <li key={preset.days} className="w-full sm:w-auto">
              <PresetRadio
                name={COMPOSER_FIELD_NAMES.windowDays}
                value={preset.days}
                testId={`composer-window-${preset.days}`}
                checked={windowPreset === preset.days}
                onSelect={() => dispatch({ type: "windowPreset", preset: preset.days })}
              >
                {preset.label}
              </PresetRadio>
            </li>
          ))}
          <li className="w-full sm:w-auto">
            <PresetRadio
              name={COMPOSER_FIELD_NAMES.windowDays}
              value={CUSTOM_PRESET_VALUE}
              testId="composer-window-custom"
              checked={windowPreset === "custom"}
              onSelect={() => dispatch({ type: "windowPreset", preset: CUSTOM_PRESET_VALUE })}
            >
              Custom
            </PresetRadio>
          </li>
        </ul>
        {/* RENDERED ONLY WHILE CUSTOM IS SELECTED. An inactive number field left
            in the form is not merely clutter: `min`/`max` on it take part in the
            browser's own constraint validation, so an out-of-range leftover
            would block a submit the practitioner has since made valid — and
            block Cancel with it. Leaving Custom removes it from the form. */}
        {windowPreset === CUSTOM_PRESET_VALUE && (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-muted">Days from today</span>
            <input
              type="number"
              name={COMPOSER_FIELD_NAMES.windowDaysCustom}
              inputMode="numeric"
              min={1}
              max={365}
              data-testid="composer-window-days"
              value={Number.isFinite(draft.windowDays) ? draft.windowDays : ""}
              onChange={(event) =>
                dispatch({
                  type: "windowCustom",
                  // An empty box is NOT zero days. NaN keeps the draft invalid
                  // instead of quietly becoming a number nobody typed.
                  days: event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value),
                })
              }
              aria-invalid={errors.window ? true : undefined}
              aria-describedby={errors.window ? composerErrorId(entryId, "window") : undefined}
              className={fieldControlClass()}
            />
        </label>
        )}
      </FieldSection>

      <FieldSection entryId={entryId} id="days" title="Allowed days" error={errors.days}>
        <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {(
            ["every", "weekdays", "weekends", "custom"] as ReadonlyArray<AllowedDaysPreset>
          ).map((preset) => (
            <li key={preset} className="w-full sm:w-auto">
              <PresetRadio
                name={COMPOSER_FIELD_NAMES.allowedDaysPreset}
                value={preset}
                testId={`composer-days-${preset}`}
                checked={daysPreset === preset}
                onSelect={() => dispatch({ type: "daysPreset", preset })}
              >
                {ALLOWED_DAYS_PRESET_LABEL[preset]}
              </PresetRadio>
            </li>
          ))}
        </ul>
        {/* ONLY WHILE CUSTOM IS SELECTED. The preset radio still submits
            `custom`, so a set with nothing ticked reaches the payload as `[]` —
            an explicit empty set — rather than as the absence of an answer. */}
        {daysPreset === "custom" && (
          // MONDAY FIRST, WHICH IS NOT INDEX ORDER. The value is 0=Sunday, the
          // week a studio reads starts on Monday, and the display order travels
          // with the index precisely so selecting "Mon–Fri" by position cannot
          // quietly select Sunday–Thursday.
          // THE GROUP CARRIES IT, NOT EACH TOGGLE. "Choose at least one day" is
          // a fact about the SET, not about Monday; repeating it on all seven
          // buttons would announce the same error seven times and still not say
          // which control fixes it.
          // NO `aria-invalid` HERE, AND THAT IS CORRECT. ARIA supports it on
          // widget roles, not on `group` — assistive tech ignores it and the
          // repo's own a11y lint rejects it. The invalid state reaches the user
          // through the description instead, which is the part they actually
          // hear on entering the group. Marking the seven toggles individually
          // would be the alternative, and it would be wrong twice over: no
          // single day is invalid, and it would announce one error seven times.
          <div
            role="group"
            data-testid="composer-weekday-group"
            aria-labelledby={composerLabelId(entryId, "days")}
            aria-describedby={errors.days ? composerErrorId(entryId, "days") : undefined}
          >
          <ul className="flex flex-wrap gap-2" data-testid="composer-weekdays">
            {WEEKDAYS_IN_DISPLAY_ORDER.map((day) => (
              <li key={day.index}>
                <WeekdayCheckbox
                  value={day.index}
                  testId={`composer-weekday-${day.index}`}
                  checked={draft.allowedWeekdays?.includes(day.index) ?? false}
                  onToggle={(checked) => dispatch({ type: "weekday", index: day.index, checked })}
                >
                  {day.label}
                </WeekdayCheckbox>
              </li>
            ))}
          </ul>
          </div>
        )}
      </FieldSection>

      <FieldSection entryId={entryId} id="expiry" title="Invitation expires" error={errors.expiry}>
        <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {TTL_PRESETS.map((preset) => (
            <li key={preset.hours} className="w-full sm:w-auto">
              <PresetRadio
                name={COMPOSER_FIELD_NAMES.expiresInHours}
                value={preset.hours}
                testId={`composer-expiry-${preset.hours}`}
                checked={ttlPreset === preset.hours}
                onSelect={() => dispatch({ type: "expiryPreset", preset: preset.hours })}
              >
                {preset.label}
              </PresetRadio>
            </li>
          ))}
          <li className="w-full sm:w-auto">
            <PresetRadio
              name={COMPOSER_FIELD_NAMES.expiresInHours}
              value={CUSTOM_PRESET_VALUE}
              testId="composer-expiry-custom"
              checked={ttlPreset === "custom"}
              onSelect={() => dispatch({ type: "expiryPreset", preset: CUSTOM_PRESET_VALUE })}
            >
              Custom
            </PresetRadio>
          </li>
        </ul>
        {ttlPreset === CUSTOM_PRESET_VALUE && (
          <label className="flex flex-col gap-1.5">
            {/* The bound is the shipped command's own and is stated rather than
                enforced silently: it REFUSES an out-of-range window instead of
                clamping it, so a practitioner who types 200 needs to know why
                nothing happened. */}
            <span className="text-xs text-fg-muted">Hours, from 1 hour to 7 days</span>
            <input
              type="number"
              name={COMPOSER_FIELD_NAMES.expiresInHoursCustom}
              inputMode="numeric"
              min={1}
              max={168}
              data-testid="composer-expiry-hours"
              value={Number.isFinite(draft.expiresInHours) ? draft.expiresInHours : ""}
              onChange={(event) =>
                dispatch({
                  type: "expiryCustom",
                  hours: event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value),
                })
              }
              aria-invalid={errors.expiry ? true : undefined}
              aria-describedby={errors.expiry ? composerErrorId(entryId, "expiry") : undefined}
              className={fieldControlClass()}
            />
          </label>
        )}
      </FieldSection>

      <div className="flex flex-col gap-3 border-t border-line px-4 py-4">
        {!serviceMissing && (
          <p data-testid="composer-summary" className="text-sm leading-snug text-fg-muted">
            {/* States the SCOPE, never that anything has been sent. */}
            They will be able to book {scopeSummary(draft, serviceName)}.
          </p>
        )}
        {sendReason && (
          <span
            id={waitlistDomId(entryId, "composer-send-reason")}
            data-testid="composer-send-reason"
            className="text-xs leading-snug text-fg-muted"
          >
            {sendReason}
          </span>
        )}
        {/* PRIMARY IS FULL WIDTH AND FIRST IN THE DOM. On a phone the send
            control is the one a thumb reaches for; putting Cancel first in
            source order to get it visually left on a desktop would put it under
            the thumb on every phone. */}
        <button
          type="submit"
          disabled={sendDisabled}
          data-testid="composer-send"
          aria-describedby={sendReason ? waitlistDomId(entryId, "composer-send-reason") : undefined}
          className={buttonClasses({ variant: "primary", size: "md", fullWidth: true })}
        >
          Send invitation
        </button>
        <button
          // Submits to its OWN binding, so dismissing is a real action rather
          // than a button that looks live and does nothing. Disabled while no
          // binding exists, for the same reason the send is.
          type="submit"
          // LEAVING MUST NEVER BE BLOCKED BY A FIELD YOU ARE LEAVING BEHIND.
          // Without this, a half-typed custom number makes the browser refuse
          // to run Cancel and points at the very control the practitioner is
          // trying to abandon.
          formNoValidate
          formAction={cancelAction ?? undefined}
          disabled={cancelAction === null}
          data-testid="composer-cancel"
          className={buttonClasses({ variant: "quiet", size: "md", fullWidth: true })}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
