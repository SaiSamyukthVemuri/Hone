import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDailyPrepBrief,
  type DailyPrepInput,
} from "@/lib/dashboard/daily-prep-brief";

// PR #241: Daily Prep Brief V1. Rules-based only (no AI, no model, no
// provider). Pure helper tested directly; the dashboard wiring and
// the no-provider / no-sensitive-surface guarantees are source-pinned.

function input(over: Partial<DailyPrepInput> = {}): DailyPrepInput {
  return {
    appointmentId: "a1",
    clientId: "c1",
    clientName: "Jane Doe",
    timeLabel: "9:00 AM",
    status: "confirmed",
    serviceName: "Electrolysis",
    hasHistory: true,
    nextVisitNote: null,
    cautionNote: null,
    setupLine: "27.12 MHz · Ballet F3 · Thermolysis",
    reminders: [],
    intake: "reviewed",
    charting: "none",
    ...over,
  };
}

function only(over: Partial<DailyPrepInput>) {
  return buildDailyPrepBrief([input(over)]).items[0];
}

describe("buildDailyPrepBrief items", () => {
  it("surfaces the next-session note as a 'For next visit' prep item", () => {
    const item = only({ nextVisitNote: "Start lower on the upper lip." });
    expect(item.reminders).toContain(
      "For next visit: Start lower on the upper lip.",
    );
    expect(item.priority).toBe(1);
  });

  it("surfaces a caution note as a 'Caution noted' item", () => {
    const item = only({ cautionNote: "Check chin sensitivity first." });
    expect(item.reminders).toContain(
      "Caution noted: Check chin sensitivity first.",
    );
    expect(item.priority).toBe(1);
  });

  it("surfaces an incomplete intake item for an upcoming appointment", () => {
    expect(only({ intake: "in_progress" }).reminders).toContain(
      "Intake incomplete",
    );
    expect(only({ intake: "submitted" }).reminders).toContain(
      "Intake awaiting review",
    );
    expect(
      only({ hasHistory: false, intake: "none" }).reminders,
    ).toContain("No intake on file");
    // A reviewed intake produces no intake reminder.
    expect(only({ intake: "reviewed" }).reminders).not.toContain(
      "Intake incomplete",
    );
  });

  it("surfaces a charting-needed item for a completed appointment", () => {
    const item = only({ status: "completed", charting: "needs" });
    expect(item.reminders).toContain("Charting needed");
    expect(item.priority).toBe(3);
  });

  it("shortens missing probe lot / aftercare reminders when facts support it", () => {
    const item = only({
      reminders: [
        "Probe lot number needed before the procedure record is complete",
        "Aftercare/risks not marked on the last session",
        "Client date of birth not recorded",
      ],
    });
    expect(item.reminders).toContain("Probe lot missing");
    expect(item.reminders).toContain("Aftercare not marked");
    expect(item.reminders).toContain("Date of birth missing from record");
  });

  it("shows recorded setup for a returning client and not for a new one", () => {
    expect(only({ hasHistory: true }).reminders).toContain(
      "Last recorded: 27.12 MHz · Ballet F3 · Thermolysis",
    );
    const fresh = only({ hasHistory: false, setupLine: null });
    expect(fresh.reminders.some((r) => r.startsWith("Last recorded"))).toBe(
      false,
    );
  });

  it("keeps the new-client / no-history state calm", () => {
    const item = only({
      hasHistory: false,
      setupLine: null,
      intake: "reviewed",
    });
    expect(item.subtitle).toMatch(/No prior treatment history yet/);
    expect(item.tags).toContain("New client");
    expect(item.priority).toBe(5);
  });

  it("links every item to the existing, safe client route", () => {
    expect(only({}).href).toBe("/clients/c1");
  });

  it("dedupes a reminder that the missing-record list and a chip both produce", () => {
    const item = only({
      charting: "needs",
      status: "completed",
      reminders: ["Aftercare/risks not marked on the last session"],
    });
    const aftercare = item.reminders.filter((r) => r === "Aftercare not marked");
    expect(aftercare).toHaveLength(1);
  });
});

describe("priority order and empty state", () => {
  it("orders by priority then chronological input order", () => {
    const brief = buildDailyPrepBrief([
      input({ appointmentId: "charted", hasHistory: true, charting: "charted" }),
      input({ appointmentId: "memory", nextVisitNote: "watch this" }),
      input({ appointmentId: "intake", intake: "in_progress", nextVisitNote: null }),
    ]);
    expect(brief.items.map((i) => i.appointmentId)).toEqual([
      "memory", // priority 1
      "intake", // priority 2
      "charted", // priority 6
    ]);
  });

  it("an empty roster yields the calm empty state", () => {
    const brief = buildDailyPrepBrief([]);
    expect(brief.hasItems).toBe(false);
    expect(brief.items).toEqual([]);
  });
});

describe("safety: wording and surfaces (source pins)", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/dashboard/daily-prep-brief.ts"),
    "utf8",
  );
  const executable = SRC.split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("the helper emits no clinical-advice wording in executable lines", () => {
    expect(executable).not.toMatch(
      /recommend|\bscore\b|monitor|\bunsafe\b|\bsafe\b|caused|diagnos|should treat|medically necessary|clinical advice/i,
    );
  });

  it("the helper reads no sensitive surface (no exposure / payment / token / audit)", () => {
    // Executable lines only; the header comment legitimately names the
    // sensitive surfaces the helper does NOT read.
    expect(executable).not.toMatch(/exposure|stripe|payment|charge|token|audit/i);
  });

  it("the helper is pure: no I/O, no model, no provider, no mutation", () => {
    expect(SRC).not.toMatch(
      /createClient|supabase|fetch\(|anthropic|openai|gemini|\.insert\(|\.update\(|\.delete\(/i,
    );
  });
});

describe("dashboard wiring and card (source pins)", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  const CARD = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/daily-prep-brief.tsx"),
    "utf8",
  );

  it("the dashboard builds the brief and renders the card", () => {
    expect(PAGE).toMatch(/buildDailyPrepBrief\(dailyPrepInputs\)/);
    expect(PAGE).toMatch(/<DailyPrepBriefCard brief=\{dailyPrepBrief\}/);
  });

  it("the brief is built from already-loaded facts, not a new query", () => {
    // Inputs map over visibleAppointments and pull from the existing
    // beforeTodayPreviews / sessionByAppointment / intakeByClient maps;
    // there is no supabase call between the previews and the brief.
    expect(PAGE).toMatch(/visibleAppointments\.map\(\(appt\) => \{/);
    expect(PAGE).toMatch(/beforeTodayPreviews\.get\(appt\.client_id\)/);
    expect(PAGE).toMatch(/sessionByAppointment\.get\(appt\.id\)/);
    expect(PAGE).toMatch(/intakeByClient\.get\(appt\.client_id\)/);
    const buildIdx = PAGE.indexOf("const dailyPrepInputs");
    const briefIdx = PAGE.indexOf("buildDailyPrepBrief(dailyPrepInputs)");
    expect(PAGE.slice(buildIdx, briefIdx)).not.toMatch(/await supabase|\.from\(/);
  });

  it("the brief renders under Today and above Practice Snapshot (Today/Snapshot intact)", () => {
    const today = PAGE.indexOf('<h2 className="text-lg font-medium">Today</h2>');
    const brief = PAGE.indexOf("<DailyPrepBriefCard");
    const snapshot = PAGE.indexOf("<PracticeSnapshot");
    expect(today).toBeGreaterThan(-1);
    expect(brief).toBeGreaterThan(today);
    expect(snapshot).toBeGreaterThan(brief);
  });

  it("the card is link-only and adds no AI/model/provider/action", () => {
    expect(CARD).not.toMatch(
      /anthropic|openai|gemini|createClient|supabase|fetch\(|<form|action=|<button/i,
    );
    expect(CARD).toMatch(/Daily prep brief/);
    expect(CARD).toMatch(/Today&apos;s recorded memory and follow-up items\./);
    expect(CARD).toMatch(/Nothing needs special review yet\./);
    expect(CARD).toMatch(/href=\{item\.href\}/);
  });

  it("no AI provider dependency was added to package.json", () => {
    const pkg = readFileSync(join(process.cwd(), "package.json"), "utf8");
    expect(pkg).not.toMatch(/@anthropic-ai|openai|@google\/gen|@ai-sdk|langchain/i);
  });
});

// ---------------------------------------------------------------------------
// Full-length recorded memory (Chloe: the brief still cut her notes off).
// ---------------------------------------------------------------------------
// The three memory lines used to be capped at 90 characters by a module-local
// truncate(). The Today roster card had already been un-capped; the brief
// renders the SAME note on the SAME screen, so the cap just relocated the
// complaint. These pin that nothing in the builder shortens them.
describe("recorded-memory lines are never truncated", () => {
  // Longer than the old 90-char cap, so a regression is unmissable.
  const LONG =
    "Drop to energy level 8 on the upper lip next visit and re-check tolerance " +
    "after the first pass; she reacted to the higher setting last time and " +
    "preferred shorter passes with a longer rest between them.";

  it("keeps a long next-visit note whole, with no ellipsis", () => {
    const item = only({ nextVisitNote: LONG });
    expect(item.reminders).toContain(`For next visit: ${LONG}`);
    expect(item.reminders.join("\n")).not.toContain("…");
  });

  it("keeps a long caution note whole", () => {
    const item = only({ cautionNote: LONG });
    expect(item.reminders).toContain(`Caution noted: ${LONG}`);
  });

  it("keeps a long latest-setup line whole", () => {
    const item = only({ hasHistory: true, setupLine: LONG });
    expect(item.reminders).toContain(`Last recorded: ${LONG}`);
  });

  it("preserves the practitioner's own line breaks", () => {
    const multi = "Upper lip: energy level 8.\nNumbing 30 min ahead.";
    const item = only({ nextVisitNote: multi });
    expect(item.reminders).toContain(`For next visit: ${multi}`);
  });

  it("still trims surrounding whitespace", () => {
    const item = only({ nextVisitNote: "   Start lower.   " });
    expect(item.reminders).toContain("For next visit: Start lower.");
  });

  it("a note far past the old cap is carried verbatim, character for character", () => {
    const huge = "x".repeat(2000);
    const item = only({ nextVisitNote: huge });
    const line = item.reminders.find((r) => r.startsWith("For next visit: "));
    expect(line).toBeDefined();
    expect(line!.slice("For next visit: ".length)).toHaveLength(2000);
  });

  it("the brief and the Today roster now agree on the SAME note", () => {
    // The exact defect: the roster showed the note in full while the brief,
    // rendered lower on the same screen, showed it clipped at 90.
    const item = only({ nextVisitNote: LONG });
    const briefLine = item.reminders.find((r) => r.startsWith("For next visit: "))!;
    expect(briefLine.slice("For next visit: ".length)).toBe(LONG);
  });
});
