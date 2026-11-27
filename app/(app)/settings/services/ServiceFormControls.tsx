"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { actionFailureMessage, isActionFailure, type ActionResult } from "@/lib/actions/action-result";
import { FOCUS_RING } from "@/components/ui/control-base";
import {
  SERVICE_COLOR_KEYS,
  isServiceColorKey,
  serviceColorClasses,
  type ServiceColorKey,
} from "@/lib/calendar/service-colors";
import { formatClockLabel, minutesToHHMM, type TimeFormat } from "@/lib/booking/tz";

const DURATION_PRESETS_MINUTES: ReadonlyArray<number> = [15, 30, 45, 60, 90];

// Swatch dot per allowed color key (preview only; the real card bundle lives in
// lib/calendar/service-colors.ts). No rose/red/pink, reserved for allergy and
// clinical-caution signals. Tones mirror the palette's light/deep alternation so
// the swatch previews the separation the calendar card will actually show.
const COLOR_SWATCH: Record<ServiceColorKey, string> = {
  amber: "bg-amber-400",
  emerald: "bg-emerald-600",
  teal: "bg-teal-400",
  sky: "bg-sky-400",
  indigo: "bg-indigo-600",
  violet: "bg-violet-400",
  orange: "bg-orange-600",
  lime: "bg-lime-500",
  fuchsia: "bg-fuchsia-600",
  slate: "bg-slate-500",
};

export function ServiceColorDot({ colorKey }: { colorKey?: string | null }) {
  const color = isServiceColorKey(colorKey) ? COLOR_SWATCH[colorKey] : "bg-neutral-400";
  return <span aria-hidden="true" className={`inline-block size-3 shrink-0 rounded-full ${color}`} />;
}

export function CalendarColorField({
  name,
  defaultValue,
  previewName = "",
  previewDuration = 60,
  timeFormat = "12h",
}: {
  name: string;
  defaultValue?: string | null;
  previewName?: string;
  previewDuration?: number;
  timeFormat?: TimeFormat;
}) {
  const initial = isServiceColorKey(defaultValue) ? defaultValue : "sky";
  const [value, setValue] = useState(initial);
  const [serviceName, setServiceName] = useState(previewName);
  const [duration, setDuration] = useState(String(previewDuration));
  const hidden = useRef<HTMLInputElement>(null);
  const previous = useRef(value);

  // Buttons update the hidden field without a native input event. Notify the
  // form's dirty guard after React commits the new FormData value.
  useEffect(() => {
    if (previous.current !== value) {
      previous.current = value;
      hidden.current?.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, [value]);

  // The service editor uses native inputs submitted directly to its server
  // action. Observe the two fields used on a calendar card in this form only.
  useEffect(() => {
    const form = hidden.current?.form;
    if (!form) return;
    const update = (event: Event) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement)) return;
      if (field.name === "name") setServiceName(field.value);
      if (field.name === "default_duration_minutes") setDuration(field.value);
    };
    const reset = () => {
      // Existing service forms remount with the saved server values.
      if (form.elements.namedItem("id")) return;
      setServiceName(previewName);
      setDuration(String(previewDuration));
      previous.current = initial;
      setValue(initial);
    };
    form.addEventListener("input", update);
    form.addEventListener("reset", reset);
    return () => {
      form.removeEventListener("input", update);
      form.removeEventListener("reset", reset);
    };
  }, [initial, previewName, previewDuration]);

  const minutes = Number(duration);
  const start = formatClockLabel("09:00", timeFormat);
  const end = Number.isInteger(minutes) && minutes >= 5 && minutes <= 480
    ? formatClockLabel(minutesToHHMM(9 * 60 + minutes), timeFormat)
    : null;

  return (
    <div className="@container min-w-0 space-y-4">
      <fieldset className="min-w-0">
        <legend className="text-sm font-semibold">Calendar colour</legend>
        <input ref={hidden} type="hidden" name={name} value={value} />
        <div className="mt-2 grid grid-cols-3 gap-1.5 @min-[16rem]:grid-cols-4 @min-[19.25rem]:grid-cols-5">
          {SERVICE_COLOR_KEYS.map((key) => {
            const selected = value === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setValue(key)}
                aria-pressed={selected}
                aria-label={`Calendar color: ${key}`}
                className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1.5 rounded-md border px-1 py-2 text-xs capitalize cursor-pointer ${FOCUS_RING} ${
                  selected
                    ? "border-fg bg-surface-sunken font-semibold shadow-[inset_0_0_0_1px_currentColor]"
                    : "border-line-strong bg-surface hover:bg-surface-sunken"
                }`}
              >
                <span aria-hidden="true" className={`size-4 rounded-full ${COLOR_SWATCH[key]}`} />
                {key}
              </button>
            );
          })}
        </div>
      </fieldset>
      <figure aria-label="Calendar preview" className="min-w-0">
        <figcaption className="mb-2 text-sm font-semibold">Calendar preview</figcaption>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-lg border border-line bg-surface-sunken p-3">
          <span aria-hidden="true" className="pt-2 text-xs tabular-nums text-fg-muted">{start}</span>
          <div data-testid="service-calendar-preview" className={`rounded-md border-l-4 px-3 py-2 ${serviceColorClasses(value)}`}>
            <strong className="block wrap-anywhere text-sm font-semibold">{serviceName.trim() || "New service"}</strong>
            <span className="mt-0.5 block text-xs tabular-nums">{start}{end && ` – ${end}`}</span>
          </div>
        </div>
      </figure>
    </div>
  );
}

// Duration field. The presets sit as a tight pill row directly above
// the number input. Clicking a preset sets the input value (and
// dispatches an input event so any controlled-input watchers see the
// change). Custom durations still work: the input is a normal
// number field with min=5, max=480, step=5. FormData submits as
// `default_duration_minutes` exactly as the unchanged action expects.
export function DurationField({
  name,
  defaultValue,
  required,
}: {
  name: string;
  defaultValue?: number;
  required?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState<string>(
    defaultValue != null ? String(defaultValue) : "",
  );

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const reset = () => {
      if (!form.elements.namedItem("id")) setValue(defaultValue == null ? "" : String(defaultValue));
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [defaultValue]);

  function applyPreset(minutes: number) {
    setValue(String(minutes));
    const el = ref.current;
    if (el) {
      el.value = String(minutes);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {DURATION_PRESETS_MINUTES.map((m) => {
          const selected = value === String(m);
          return (
            <button
              key={m}
              type="button"
              onClick={() => applyPreset(m)}
              aria-pressed={selected}
              className={`min-h-11 min-w-11 flex-1 rounded-md border px-2 py-1.5 text-[12px] tabular-nums transition ${
                selected
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                  : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:border-neutral-500 dark:hover:text-neutral-100"
              }`}
            >
              {m}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          name={name}
          aria-label="Duration in minutes"
          type="number"
          min={5}
          max={480}
          step={5}
          required={required}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="60"
          className="min-h-11 w-20 rounded-md border border-neutral-300 bg-white px-2 py-2 text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
        <span className="text-xs text-neutral-500">minutes</span>
      </div>
    </div>
  );
}

export function ServiceSubmitButton({
  idleLabel,
  pendingLabel,
  variant = "secondary",
}: {
  idleLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} pending={pending} busyLabel={pendingLabel ?? "Saving…"}>
      {idleLabel}
    </Button>
  );
}

export function ToggleActiveSubmitButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus();
  const idle = active ? "Hide from booking" : "Show in booking";
  const busy = active ? "Hiding…" : "Showing…";
  return (
    <Button type="submit" pending={pending} busyLabel={busy}>
      {idle}
    </Button>
  );
}

/**
 * Show/Hide in booking. HON-124 item 20: the page used to re-render silently (or throw a redacted message). Now the action's result is read:
 * a refusal shows its sentence and the button stays; a confirmation names the service and the booking effect ONLY after the server said ok.
 * Source of the effect claim: toggleServiceActiveAction sets services.active, and the booking menu lists active services (page.tsx: `s.active`).
 */
export function ServiceVisibilityForm({ action, serviceId, serviceName, active }: {
  action: (formData: FormData) => Promise<ActionResult>;
  serviceId: string;
  serviceName: string;
  active: boolean;
}) {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  return (
    <form
      action={async (formData) => {
        setMessage(null);
        try {
          const result = await action(formData);
          if (isActionFailure(result)) {
            setMessage({ kind: "error", text: result.error });
            return;
          }
          setMessage({ kind: "ok", text: active ? `${serviceName} is now hidden from booking.` : `${serviceName} is now shown in booking.` });
        } catch (err) {
          setMessage({ kind: "error", text: actionFailureMessage(err, "Could not change this service. Check your connection and try again.") });
        }
      }}
    >
      <input type="hidden" name="id" value={serviceId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <ToggleActiveSubmitButton active={active} />
      <p role={message?.kind === "error" ? "alert" : "status"} className="mt-1 text-xs text-fg-muted empty:hidden">{message?.text ?? ""}</p>
    </form>
  );
}
