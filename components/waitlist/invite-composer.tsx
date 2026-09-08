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
} from "@/lib/waitlist/b4-invitation-draft";
import type { AdapterCapabilities } from "@/lib/waitlist/invite-to-book-contract";

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

/** A preset button. `aria-pressed` carries the selection to assistive tech and
 *  a border carries it visually — never colour alone, because the presets are
 *  otherwise identical boxes and several studios' staff are colour-blind. */
function PresetButton({
  testId,
  pressed,
  children,
}: {
  testId: string;
  pressed: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={pressed}
      className={cx(
        buttonClasses({ variant: "secondary", size: "sm", fullWidth: true }),
        "sm:w-auto",
        pressed && "border-accent text-accent",
      )}
    >
      {children}
    </button>
  );
}

export function InviteComposer({
  entryId,
  entryName,
  draft,
  services,
  capabilities = null,
}: {
  /** Namespaces every id this composer emits, so two mounted composers cannot
   *  cross-reference each other's labels and errors. */
  entryId: string;
  /** The person this invitation is for. Already chosen — the composer opens
   *  from their row, and choosing again here is how a single invitation and a
   *  bulk claim end up looking like one control. */
  entryName: string;
  draft: InviteDraft;
  services: ReadonlyArray<{ id: string; name: string }>;
  /** `null` until an adapter satisfying `WaitlistInvitationAdapter` is bound. */
  capabilities?: AdapterCapabilities | null;
}) {
  // The service list is part of validation, not just of rendering: a
  // `serviceId` that is no longer in it must invalidate the draft rather than
  // fall back to "any service" in the summary while the payload keeps the
  // stale id.
  const draftContext = { serviceIds: services.map((s) => s.id) };
  const validation = validateDraft(draft, draftContext);
  const errors = validation.ok ? {} : validation.errors;
  const send = sendState(draft, capabilities, draftContext);
  const windowPreset = activeWindowPreset(draft.windowDays);
  const daysPreset = activeAllowedDaysPreset(draft.allowedWeekdays);
  const ttlPreset = activeTtlPreset(draft.expiresInHours);
  const selectedService = services.find((s) => s.id === draft.serviceId) ?? null;
  const serviceName = selectedService?.name ?? null;
  // A chosen-but-missing service must not read as "any service" in the summary.
  // The draft is invalid in that case, so the summary is withheld entirely
  // rather than describing a scope the send would not carry.
  const serviceMissing = draft.serviceId !== null && selectedService === null;

  return (
    <div className="flex flex-col" data-testid="invite-composer">
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
          data-testid="composer-service"
          aria-labelledby={composerLabelId(entryId, "service")}
          // THE CONTROL CARRIES THE RELATIONSHIP, not just the section. A
          // screen-reader user lands on the select, not on the paragraph
          // underneath it, so without this they are told the field is invalid
          // and never told why Send is blocked.
          aria-invalid={errors.service ? true : undefined}
          aria-describedby={errors.service ? composerErrorId(entryId, "service") : undefined}
          defaultValue={draft.serviceId ?? ""}
          className={fieldControlClass()}
        >
            {/* "Any service" is a real answer, not an empty one. A studio that
                does not mind which service the invitee books should not have to
                pick one to get past this field. */}
          <option value="">Any service</option>
          {services.map((service) => (
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
              <PresetButton
                testId={`composer-window-${preset.days}`}
                pressed={windowPreset === preset.days}
              >
                {preset.label}
              </PresetButton>
            </li>
          ))}
          <li className="w-full sm:w-auto">
            <PresetButton
              testId="composer-window-custom"
              pressed={windowPreset === "custom"}
            >
              Custom
            </PresetButton>
          </li>
        </ul>
        {windowPreset === "custom" && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-fg-muted">Days from today</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              data-testid="composer-window-days"
              defaultValue={draft.windowDays}
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
              <PresetButton
                testId={`composer-days-${preset}`}
                pressed={daysPreset === preset}
              >
                {ALLOWED_DAYS_PRESET_LABEL[preset]}
              </PresetButton>
            </li>
          ))}
        </ul>
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
                <button
                  type="button"
                  data-testid={`composer-weekday-${day.index}`}
                  aria-pressed={draft.allowedWeekdays?.includes(day.index) ?? false}
                  className={cx(
                    buttonClasses({ variant: "secondary", size: "sm" }),
                    // A 44px floor with three-letter labels needs a width floor
                    // too, or the box is taller than it is wide and reads as a
                    // mis-render rather than a target.
                    "min-w-[3.25rem]",
                    draft.allowedWeekdays?.includes(day.index) &&
                      "border-accent text-accent",
                  )}
                >
                  {day.label}
                </button>
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
              <PresetButton
                testId={`composer-expiry-${preset.hours}`}
                pressed={ttlPreset === preset.hours}
              >
                {preset.label}
              </PresetButton>
            </li>
          ))}
          <li className="w-full sm:w-auto">
            <PresetButton testId="composer-expiry-custom" pressed={ttlPreset === "custom"}>
              Custom
            </PresetButton>
          </li>
        </ul>
        {ttlPreset === "custom" && (
          <label className="flex flex-col gap-1.5">
            {/* The bound is the shipped command's own and is stated rather than
                enforced silently: it REFUSES an out-of-range window instead of
                clamping it, so a practitioner who types 200 needs to know why
                nothing happened. */}
            <span className="text-xs text-fg-muted">Hours, from 1 hour to 7 days</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={168}
              data-testid="composer-expiry-hours"
              defaultValue={draft.expiresInHours}
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
        {send.reason && (
          <span
            id={waitlistDomId(entryId, "composer-send-reason")}
            data-testid="composer-send-reason"
            className="text-xs leading-snug text-fg-muted"
          >
            {send.reason}
          </span>
        )}
        {/* PRIMARY IS FULL WIDTH AND FIRST IN THE DOM. On a phone the send
            control is the one a thumb reaches for; putting Cancel first in
            source order to get it visually left on a desktop would put it under
            the thumb on every phone. */}
        <button
          type="button"
          disabled={send.disabled}
          data-testid="composer-send"
          aria-describedby={send.reason ? waitlistDomId(entryId, "composer-send-reason") : undefined}
          className={buttonClasses({ variant: "primary", size: "md", fullWidth: true })}
        >
          Send invitation
        </button>
        <button
          type="button"
          data-testid="composer-cancel"
          className={buttonClasses({ variant: "quiet", size: "md", fullWidth: true })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
