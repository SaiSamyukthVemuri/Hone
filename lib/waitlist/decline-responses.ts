// HON-7 (b). The recipient's "None of these times work" response: BOTH answers are required, or the person says they no longer need an appointment.
// Pure: no I/O, so the form and the server action validate with the same rules.
// Rules are the frozen 0325 contract's (decline_waitlist_invitation_with_answers): each answer trimmed, 1..1000 characters, no control
// characters except newline, tab and carriage return. The database is the authority and re-validates; this exists so the form can say so first.
import { NO_TIMES_WORK_NOTICE } from "./decline-copy";

export const NO_TIMES_WORK_LABELS = {
  why: "Why don't these times work?",
  better: "What days and times work better for you?",
  noLongerNeed: "I no longer need an appointment",
} as const;

export { NO_TIMES_WORK_NOTICE };

export const DECLINE_ANSWER_MAX = 1000;

const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type NoTimesWorkAnswers = { why: string; better: string };
export type AnswerProblem = "required" | "too_long" | "invalid_characters";
export type NoTimesWorkValidation =
  | { ok: true; answers: NoTimesWorkAnswers }
  | { ok: false; problems: Partial<Record<keyof NoTimesWorkAnswers, AnswerProblem>> };

function check(raw: unknown): { value: string; problem: AnswerProblem | null } {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) return { value, problem: "required" };
  if (value.length > DECLINE_ANSWER_MAX) return { value, problem: "too_long" };
  if (FORBIDDEN.test(value)) return { value, problem: "invalid_characters" };
  return { value, problem: null };
}

export function validateNoTimesWork(input: { why?: unknown; better?: unknown }): NoTimesWorkValidation {
  const why = check(input.why);
  const better = check(input.better);
  if (why.problem || better.problem) {
    return {
      ok: false,
      problems: {
        ...(why.problem ? { why: why.problem } : {}),
        ...(better.problem ? { better: better.problem } : {}),
      },
    };
  }
  return { ok: true, answers: { why: why.value, better: better.value } };
}

export const ANSWER_PROBLEM_COPY: Record<AnswerProblem, string> = {
  required: "Please answer this.",
  too_long: `Please keep this to ${DECLINE_ANSWER_MAX} characters or fewer.`,
  invalid_characters: "Please use plain text only.",
};
