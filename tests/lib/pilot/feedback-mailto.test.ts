import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
//
// CHLOE D4 (this PR). The Dashboard "Pilot learning" card is REMOVED: it was
// pilot tooling ("…Send it to Sam", "Know another electrologist?") occupying a
// practitioner's daily workspace. The shared builder SURVIVES — the two quiet
// "Was this useful?" footers still use it — so every safety property below is
// still asserted, over the enum members that remain reachable. The
// `dashboard_pilot_learning` surface and the `another_electrologist` intent
// were reachable only from that card and are removed with it; the tests that
// exercised them are replaced by assertions that the card is gone, NOT deleted
// silently.

const SURFACES: PilotSurface[] = [
  "before_today",
  "daily_prep",
  "follow_up_assistant",
];
const INTENTS: PilotIntent[] = ["useful", "not_useful", "general"];

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
    expect(pilotSurfaceLabel("follow_up_assistant")).toBe("Follow-up Assistant");
  });

  it("no longer offers the retired pilot-only surface or referral intent", () => {
    // CHLOE D4. Both were reachable ONLY from the deleted "Pilot learning"
    // card. Asserting on the built output (not just the TypeScript union)
    // proves the runtime switch has no surviving branch for them, which a type
    // narrowing alone would not.
    const built = SURFACES.flatMap((s) =>
      INTENTS.map((i) => decoded(s, i)),
    ).join("\n");
    expect(built).not.toMatch(/Pilot learning/);
    expect(built).not.toMatch(/another electrologist/i);
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

  it("adds no automated send / contact access / AI / referral automation", () => {
    for (const src of [HELPER, PROMPT]) {
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

  it("the feedback prompt is link-only (mailto anchors, no client JS)", () => {
    expect(PROMPT).not.toMatch(/"use client"|onClick|<button|<form|action=/);
    expect(PROMPT).toMatch(/href=\{buildPilotFeedbackMailto/);
  });

  it("the prompt copy is quiet and optional, never a growth/referral nag", () => {
    expect(PROMPT).toMatch(/Was this useful\?/);
    expect(PROMPT).toMatch(/Not really/);
    expect(PROMPT).not.toMatch(
      /refer a friend|invite your contacts|help us grow|claim your reward|share client/i,
    );
  });

  it("CHLOE D4: the Pilot learning card component is DELETED, not orphaned", () => {
    // A caller census ran before deleting it: the component was imported by
    // exactly one file (the dashboard page) and referenced nowhere else, so it
    // is genuinely dead rather than merely unrendered. The shared
    // feedback-mailto helper is NOT deleted — PilotFeedbackPrompt still uses
    // it, which is the whole reason this file still exists.
    expect(
      existsSync(join(process.cwd(), "app/(app)/dashboard/pilot-learning.tsx")),
      "pilot-learning.tsx should be deleted",
    ).toBe(false);
    expect(existsSync(join(process.cwd(), "lib/pilot/feedback-mailto.ts"))).toBe(
      true,
    );
  });
});

describe("Pilot Love Loop: dashboard wiring (source pins)", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  // Comment-stripped for the absence assertions: the page records WHY the card
  // was removed, and that note necessarily names the card and quotes its copy.
  const PAGE_CODE = PAGE.split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("CHLOE D4: the dashboard no longer renders the Pilot learning card", () => {
    expect(PAGE_CODE).not.toMatch(/PilotLearningCard/);
    expect(PAGE_CODE).not.toMatch(/pilot-learning/);
    // ...and none of its pilot-only copy survives anywhere on the page.
    expect(PAGE_CODE).not.toMatch(/Send it to Sam/i);
    expect(PAGE_CODE).not.toMatch(/Know another electrologist/i);
    expect(PAGE_CODE).not.toMatch(/Pilot learning/);
  });

  it("the operational surfaces it sat beside are untouched", () => {
    // The Daily Prep Brief card is retired into the combined Today workflow.
    expect(PAGE).toMatch(/buildTodayWorkflow\(todayWorkflowInputs\)/);
    expect(PAGE).toMatch(/<DashboardTodoList todo=\{dashboardTodo\}/);
  });

  it("the two intended surfaces carry the feedback prompt; nothing else", () => {
    // surface="daily_prep" is an unchanged pilot contract, so feedback stays
    // comparable across the retirement. It moved to the foot of the combined
    // Today section — ONCE, never once per appointment card.
    const prompts = PAGE.match(/<PilotFeedbackPrompt surface="daily_prep" \/>/g) ?? [];
    expect(prompts).toHaveLength(1);
    // Dashboard V2 Part 2B retired the standalone Follow-up assistant card;
    // the prompt moved to the foot of the unified To do section. The SURFACE
    // ID is deliberately unchanged so pilot feedback stays comparable across
    // the restructure — and it must still appear exactly ONCE.
    const followUp =
      PAGE.match(/<PilotFeedbackPrompt surface="follow_up_assistant" \/>/g) ?? [];
    expect(followUp).toHaveLength(1);
  });
});
