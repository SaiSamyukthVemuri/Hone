"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { CONTROL_MIN_TOUCH, FOCUS_RING } from "@/components/ui/control-base";
import {
  ANSWER_PROBLEM_COPY,
  DECLINE_ANSWER_MAX,
  NO_TIMES_WORK_LABELS,
  NO_TIMES_WORK_NOTICE,
  validateNoTimesWork,
  type NoTimesWorkAnswers,
  type NoTimesWorkValidation,
} from "@/lib/waitlist/decline-responses";

// HON-7 (b). Two choices first: "None of these times work" and "I no longer need an appointment". Opening the first only reveals the two
// required questions and the notice (client state; no request, no record); the answers go only when "Send response" is pressed. The second
// goes straight to the withdrawal action and its confirmation, with no question asked. Required is enforced here for the person's benefit
// (an empty field is refused with a message a screen reader announces) and again on the server, which is the authority.
export function NoTimesWorkForm({
  pending,
  onSubmit,
  onNoLongerNeed,
}: {
  pending: boolean;
  onSubmit: (answers: NoTimesWorkAnswers) => void;
  onNoLongerNeed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [better, setBetter] = useState("");
  const [shown, setShown] = useState<Extract<NoTimesWorkValidation, { ok: false }>["problems"]>({});
  const openRef = useRef<HTMLButtonElement>(null);
  const whyRef = useRef<HTMLTextAreaElement>(null);
  const betterRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);

  // Focus follows the reveal: into the first question when it opens, back to the opening choice when the person goes back.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    (open ? whyRef.current : openRef.current)?.focus();
  }, [open]);

  function submit() {
    const v = validateNoTimesWork({ why, better });
    if (v.ok) {
      setShown({});
      onSubmit(v.answers);
    } else {
      setShown(v.problems);
      (v.problems.why ? whyRef.current : betterRef.current)?.focus();
    }
  }

  const field = (id: "why" | "better", label: string, value: string, set: (v: string) => void, ref: Ref<HTMLTextAreaElement>) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`no-times-${id}`} className="text-sm text-[#0A0A0A]">
        {label}
      </label>
      <textarea
        ref={ref}
        id={`no-times-${id}`}
        name={id}
        required
        aria-required="true"
        aria-invalid={shown[id] ? "true" : undefined}
        aria-describedby={shown[id] ? `no-times-${id}-error` : undefined}
        maxLength={DECLINE_ANSWER_MAX}
        autoComplete="off"
        spellCheck={false}
        rows={3}
        value={value}
        onChange={(e) => set(e.target.value)}
        disabled={pending}
        className={`${FOCUS_RING} w-full border border-[#0A0A0A] px-3 py-2 text-sm disabled:opacity-60`}
      />
      {shown[id] ? (
        <p id={`no-times-${id}-error`} role="alert" className="text-sm text-[#8A1C1C]">
          {ANSWER_PROBLEM_COPY[shown[id] as keyof typeof ANSWER_PROBLEM_COPY]}
        </p>
      ) : null}
    </div>
  );

  const noLongerNeed = (
    <button
      type="button"
      onClick={onNoLongerNeed}
      disabled={pending}
      className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full px-4 text-sm text-[#6B6B6B] underline disabled:opacity-60`}
    >
      {NO_TIMES_WORK_LABELS.noLongerNeed}
    </button>
  );

  if (!open) {
    return (
      <div className="flex flex-col gap-3" data-testid="no-times-work-form">
        <button
          ref={openRef}
          type="button"
          onClick={() => setOpen(true)}
          disabled={pending}
          className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full border border-[#0A0A0A] px-4 text-sm text-[#0A0A0A] disabled:opacity-60`}
        >
          None of these times work
        </button>
        {noLongerNeed}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="no-times-work-form">
      {field("why", NO_TIMES_WORK_LABELS.why, why, setWhy, whyRef)}
      {field("better", NO_TIMES_WORK_LABELS.better, better, setBetter, betterRef)}
      <p className="text-sm text-[#6B6B6B]" data-testid="no-times-notice">
        {NO_TIMES_WORK_NOTICE}
      </p>
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full border border-[#0A0A0A] px-4 text-sm text-[#0A0A0A] disabled:opacity-60`}
      >
        {pending ? "Working…" : "Send response"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        disabled={pending}
        className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full px-4 text-sm text-[#6B6B6B] underline disabled:opacity-60`}
      >
        Back
      </button>
    </div>
  );
}
