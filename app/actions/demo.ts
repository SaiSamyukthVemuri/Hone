"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  limitDemoRequestSubmit,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit/public";
import { CONTACT_EMAIL } from "@/lib/marketing/content";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PRACTICE_TYPES = ["electrolysis", "laser", "both"] as const;
const PRACTITIONER_COUNTS = ["1", "2-5", "5+"] as const;

type PracticeType = (typeof PRACTICE_TYPES)[number];
type PractitionerCount = (typeof PRACTITIONER_COUNTS)[number];

export type DemoPayload = {
  name: string;
  email: string;
  practice_name: string;
  location: string;
  practice_type: PracticeType | "";
  practitioner_count: PractitionerCount | "";
  current_tool: string;
  notes: string;
};

export type DemoResult = { ok: true } | { ok: false; error: string };

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function checkEnum<T extends string>(
  value: string,
  allowed: ReadonlyArray<T>,
): T | null {
  return (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : null;
}

export async function submitDemoRequest(
  payload: DemoPayload,
): Promise<DemoResult> {
  const name = payload.name.trim();
  if (!name) return { ok: false, error: "Enter your name." };

  const email = payload.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter an email address we can reply to." };
  }

  // Anonymous public form: rate-limit BEFORE the insert (PR #187).
  // 5/hour per IP + 2/day per normalized email; identifiers are hashed
  // inside the limiter and the refusal copy is the shared generic
  // message, so a 429 never reveals prior submissions.
  const rate = await limitDemoRequestSubmit({
    headers: await headers(),
    email,
  });
  if (!rate.allowed) {
    return { ok: false, error: RATE_LIMIT_MESSAGE };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("demo_requests").insert({
    name,
    email,
    practice_name: emptyToNull(payload.practice_name),
    location: emptyToNull(payload.location),
    practice_type: checkEnum(payload.practice_type, PRACTICE_TYPES),
    practitioner_count: checkEnum(
      payload.practitioner_count,
      PRACTITIONER_COUNTS,
    ),
    current_tool: emptyToNull(payload.current_tool),
    notes: emptyToNull(payload.notes),
  });

  if (error) {
    return {
      ok: false,
      error: `Your request didn't send. Try again in a moment, or email ${CONTACT_EMAIL}.`,
    };
  }

  return { ok: true };
}
