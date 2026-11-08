"use client";

import { useState } from "react";
import { CONTROL_MIN_TOUCH, FOCUS_RING } from "@/components/ui/control-base";
import {
  ANSWER_PROBLEM_COPY,
  DECLINE_ANSWER_MAX,
  NO_TIMES_WORK_LABELS,
  validateNoTimesWork,
  type NoTimesWorkAnswers,
  type NoTimesWorkValidation,
} from "@/lib/waitlist/decline-responses";

// HON-7 (b). "None of these times work": both answers are required, and a separate, quieter control says the person no longer needs an
// appointment. Required is enforced here for the person's benefit (no submit while a field is empty) and again on the server, which is the
// authority. Not yet wired into InvitationScreen: that waits for the 0325 command shapes (see the adapter).
export function NoTimesWorkForm({
  pending,
  onSubmit,
  onNoLongerNeed,
}: {
  pending: boolean;
  onSubmit: (answers: NoTimesWorkAnswers) => void;
  onNoLongerNeed: () => void;
}) {
  const [why, setWhy] = useState("");
  const [better, setBetter] = useState("");
  const [shown, setShown] = useState<Extract<NoTimesWorkValidation, { ok: false }>["problems"]>({});
  const live = validateNoTimesWork({ why, better });

  function submit() {
    const v = validateNoTimesWork({ why, better });
    if (v.ok) {
      setShown({});
      onSubmit(v.answers);
    } else {
      setShown(v.problems);
    }
  }

  const field = (id: "why" | "better", label: string, value: string, set: (v: string) => void) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`no-times-${id}`} className="text-sm text-[#0A0A0A]">
        {label}
      </label>
      <textarea
        id={`no-times-${id}`}
        name={id}
        required
        aria-required="true"
        aria-invalid={shown[id] ? "true" : undefined}
        aria-describedby={shown[id] ? `no-times-${id}-error` : undefined}
        maxLength={DECLINE_ANSWER_MAX}
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

  return (
    <div className="flex flex-col gap-3" data-testid="no-times-work-form">
      <p className="text-sm text-[#6B6B6B]">Please don’t include health or personal details.</p>
      {field("why", NO_TIMES_WORK_LABELS.why, why, setWhy)}
      {field("better", NO_TIMES_WORK_LABELS.better, better, setBetter)}
      <button
        type="button"
        onClick={submit}
        disabled={pending || !live.ok}
        className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full border border-[#0A0A0A] px-4 text-sm text-[#0A0A0A] disabled:opacity-60`}
      >
        {pending ? "Working…" : "None of these times work"}
      </button>
      <button
        type="button"
        onClick={onNoLongerNeed}
        disabled={pending}
        className={`${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full px-4 text-sm text-[#6B6B6B] underline disabled:opacity-60`}
      >
        {NO_TIMES_WORK_LABELS.noLongerNeed}
      </button>
    </div>
  );
}
