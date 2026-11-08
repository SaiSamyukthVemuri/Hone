// HON-7 (b). The recipient's "None of these times work" response: BOTH answers are required, or the person says they no longer need an
// appointment. Pure: no I/O, so the form and any server action validate with the same rules.
//
// TODO(0325 contract): the maximum lengths and the forbidden-character set below are PROVISIONAL, copied from the existing 0319 note
// (TIMES_FEEDBACK_NOTE_MAX, and the character class in app/invitation/[token]/actions.ts). Replace them with the database's own caps when the
// frozen contract lands; the database is the authority and enforces its own.
import { TIMES_FEEDBACK_NOTE_MAX } from "./times-feedback";

export const NO_TIMES_WORK_LABELS = {
  why: "Why don't these times work?",
  better: "What days and times work better for you?",
  noLongerNeed: "I no longer need an appointment",
} as const;

export const DECLINE_ANSWER_MAX = TIMES_FEEDBACK_NOTE_MAX;

// Angle brackets, control characters, zero-width and bidi controls: the same set the existing note path refuses.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u0085\u00ad\u061c\u180e\u2028\u2029]/;

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
