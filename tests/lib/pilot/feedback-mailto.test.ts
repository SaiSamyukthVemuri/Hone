import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPilotFeedbackMailto,
  PILOT_FEEDBACK_EMAIL,
  pilotSurfaceLabel,
  type PilotIntent,
  type PilotSurface,
} from "@/lib/pilot/feedback-mailto";

// Pilot Love Loop V1 (PR #250). Manual mailto only — no automated send,
// no contacts, no referral automation, no AI. The builder takes ENUM
// inputs only, so by construction no client-sensitive data can reach the
// subject/body. These tests pin that, plus the component/dashboard wiring.

const SURFACES: PilotSurface[] = [
  "before_today",
  "daily_prep",
  "follow_up_assistant",
  "dashboard_pilot_learning",
];
const INTENTS: PilotIntent[] = [
  "useful",
  "not_useful",
  "general",
  "another_electrologist",
];

function decoded(surface: PilotSurface, intent: PilotIntent): string {
  // Decode the mailto so the assertions read the human text, not %20s.
  return decodeURIComponent(buildPilotFeedbackMailto(surface, intent));
}

describe("buildPilotFeedbackMailto", () => {
  it("always targets the configured support address with a subject and body", () => {
    for (const surface of SURFACES) {
      for (const intent of INTENTS) {
        const href = buildPilotFeedbackMailto(surface, intent);
        expect(href.startsWith(`mailto:${PILOT_FEEDBACK_EMAIL}?`)).toBe(true);
        expect(href).toMatch(/subject=/);
        expect(href).toMatch(/body=/);
      }
    }
    expect(PILOT_FEEDBACK_EMAIL).toBe("hello@hone.care");
  });

  it("identifies the surface safely and records the sentiment", () => {
    expect(decoded("before_today", "useful")).toMatch(
      /subject=Hone feedback: Before Today/,
    );
    expect(decoded("daily_prep", "useful")).toMatch(/Feedback: useful/);
    expect(decoded("follow_up_assistant", "not_useful")).toMatch(
      /Feedback: not really/,
    );
    expect(decoded("dashboard_pilot_learning", "another_electrologist")).toMatch(
      /another electrologist who might care about treatment memory/,
    );
    expect(pilotSurfaceLabel("follow_up_assistant")).toBe("Follow-up Assistant");
  });

  it("never includes client-sensitive or system-sensitive data", () => {
    for (const surface of SURFACES) {
      for (const intent of INTENTS) {
        const href = decoded(surface, intent);
        // No client identifiers, contact details, or treatment content.
        expect(href).not.toMatch(/@(?!hone\.care)/); // only the hello@hone.care address
        expect(href).not.toMatch(/\bclient\b|\bphone\b|\baddress\b|\bdob\b|date of birth/i);
        expect(href).not.toMatch(/tolerance|reaction|probe|aftercare|caution|next.session|treatment note/i);
        // No system-sensitive data.
        expect(href).not.toMatch(/exposure|stripe|payment|charge|refund|token|audit|session_id|appointment_id/i);
        // No unsafe / growth-spam wording.
        expect(href).not.toMatch(/refer a friend|invite your contacts|claim your reward|compliance score/i);
      }
    }
  });

  it("the body is empty of recorded data by default (only a placeholder)", () => {
    const href = decoded("daily_prep", "useful");
    expect(href).toMatch(/\(Add any details here\.\)/);
  });
});

describe("Pilot Love Loop: source pins (helper + components)", () => {
  const HELPER = readFileSync(
    join(process.cwd(), "lib/pilot/feedback-mailto.ts"),
    "utf8",
  );
  const PROMPT = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/pilot-feedback-prompt.tsx"),
    "utf8",
  );
  const CARD = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/pilot-learning.tsx"),
    "utf8",
  );

  it("adds no automated send / contact access / AI / referral automation", () => {
    for (const src of [HELPER, PROMPT, CARD]) {
      const executable = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      // No send paths, no provider, no contact/referral automation.
      expect(executable).not.toMatch(
        /sendEmail|sendSms|resend|nodemailer|fetch\(|anthropic|openai|gemini|navigator\.contacts|referral|invite|tracking/i,
      );
      // No writes / charges.
      expect(executable).not.toMatch(/\.insert\(|\.update\(|\.delete\(|paymentIntent|charge\(|refund/i);
    }
  });

  it("the feedback prompt and card are link-only (mailto anchors, no client JS)", () => {
    for (const src of [PROMPT, CARD]) {
      expect(src).not.toMatch(/"use client"|onClick|<button|<form|action=/);
      expect(src).toMatch(/href=\{buildPilotFeedbackMailto/);
    }
  });

  it("the prompt copy is quiet and optional, never a growth/referral nag", () => {
    expect(PROMPT).toMatch(/Was this useful\?/);
    expect(PROMPT).toMatch(/Not really/);
    expect(CARD).toMatch(/Pilot learning/);
    expect(CARD).toMatch(/Send feedback/);
    for (const src of [PROMPT, CARD]) {
      expect(src).not.toMatch(/refer a friend|invite your contacts|help us grow|claim your reward|share client/i);
    }
  });
});

describe("Pilot Love Loop: dashboard wiring (source pins)", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  const FOLLOWUP = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/follow-up-assistant.tsx"),
    "utf8",
  );

  it("the dashboard renders the Pilot learning card and keeps the agentic cards", () => {
    expect(PAGE).toMatch(/<PilotLearningCard \/>/);
    // The Daily Prep Brief card is retired into the combined Today workflow.
    expect(PAGE).toMatch(/buildTodayWorkflow\(todayWorkflowInputs\)/);
    expect(PAGE).toMatch(/<FollowUpAssistantCard assistant=\{followUpAssistant\}/);
  });

  it("the two intended surfaces carry the feedback prompt; nothing else", () => {
    // surface="daily_prep" is an unchanged pilot contract, so feedback stays
    // comparable across the retirement. It moved to the foot of the combined
    // Today section — ONCE, never once per appointment card.
    const prompts = PAGE.match(/<PilotFeedbackPrompt surface="daily_prep" \/>/g) ?? [];
    expect(prompts).toHaveLength(1);
    expect(FOLLOWUP).toMatch(/<PilotFeedbackPrompt surface="follow_up_assistant"/);
  });
});
