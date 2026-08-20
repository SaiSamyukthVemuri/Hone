import { describe, expect, it } from "vitest";
import { emptyDayMessage } from "@/lib/dashboard/day-navigation";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTodayWorkflow,
  todayWorkflowByAppointment,
  shortenReminder,
  type TodayWorkflowInput,
} from "@/lib/dashboard/today-workflow";

// Chloe: "Today and the Daily Prep Brief are redundant." They were: every
// appointment rendered twice on one screen, and the two lists disagreed about
// the same facts. These prove the ONE combined derivation.

function input(over: Partial<TodayWorkflowInput> = {}): TodayWorkflowInput {
  return {
    appointmentId: "appt-1",
    clientId: "client-1",
    clientName: "A Client",
    timeLabel: "9:00 AM",
    status: "confirmed",
    serviceName: "Electrolysis 30",
    hasHistory: true,
    nextVisitNote: null,
    cautionNote: null,
    setupLine: null,
    reminders: [],
    intake: "reviewed",
    charting: "none",
    ...over,
  };
}

describe("1. chronological order is the input order — never re-sorted", () => {
  it("preserves input order even when priorities would reorder it", () => {
    // Priority 6 (nothing notable) first, priority 1 (a recorded note) last.
    // The old brief sorted by priority; the day must not be reordered, because
    // she works through it in time.
    const items = buildTodayWorkflow([
      input({ appointmentId: "a", timeLabel: "9:00 AM" }),
      input({
        appointmentId: "b",
        timeLabel: "10:00 AM",
        nextVisitNote: "Go gentler on the chin.",
      }),
      input({ appointmentId: "c", timeLabel: "11:00 AM", intake: "none" }),
    ]).items;
    expect(items.map((i) => i.appointmentId)).toEqual(["a", "b", "c"]);
    expect(items.map((i) => i.timeLabel)).toEqual([
      "9:00 AM",
      "10:00 AM",
      "11:00 AM",
    ]);
    // Priority is still computed — as an in-card signal only.
    expect(items[1].priority).toBe(1);
    expect(items[0].priority).toBe(6);
  });

  it("the module contains no sort at all", () => {
    const SRC = readFileSync(
      join(process.cwd(), "lib/dashboard/today-workflow.ts"),
      "utf8",
    );
    expect(SRC).not.toMatch(/\.sort\(/);
  });
});

describe("2-4. identity: one appointment → one item, joined by appointmentId", () => {
  it("one appointment produces exactly one workflow item", () => {
    const w = buildTodayWorkflow([input()]);
    expect(w.items).toHaveLength(1);
    expect(w.hasItems).toBe(true);
  });

  it("TWO appointments for the SAME client stay two separate items", () => {
    // The real case: a consultation at 9 and a treatment at 2, same person.
    const items = buildTodayWorkflow([
      input({
        appointmentId: "appt-morning",
        clientId: "same-client",
        timeLabel: "9:00 AM",
        status: "completed",
        charting: "needs",
      }),
      input({
        appointmentId: "appt-afternoon",
        clientId: "same-client",
        timeLabel: "2:00 PM",
        status: "confirmed",
        charting: "none",
      }),
    ]).items;
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.appointmentId)).toEqual([
      "appt-morning",
      "appt-afternoon",
    ]);
    // ...each keeping its OWN status and charting state.
    expect(items[0].status).toBe("completed");
    expect(items[0].charting).toBe("needs");
    expect(items[1].status).toBe("confirmed");
    expect(items[1].charting).toBe("none");
  });

  it("the lookup map is keyed by appointmentId, so same-client rows never collide", () => {
    const w = buildTodayWorkflow([
      input({ appointmentId: "a1", clientId: "shared", timeLabel: "9:00 AM" }),
      input({ appointmentId: "a2", clientId: "shared", timeLabel: "2:00 PM" }),
    ]);
    const map = todayWorkflowByAppointment(w);
    expect(map.size).toBe(2);
    expect(map.get("a1")?.timeLabel).toBe("9:00 AM");
    expect(map.get("a2")?.timeLabel).toBe("2:00 PM");
    // Joining by client would have collapsed these to one.
    expect(new Set([...map.values()].map((i) => i.clientId)).size).toBe(1);
  });

  it("item id IS the appointment id", () => {
    const [item] = buildTodayWorkflow([input({ appointmentId: "appt-9" })]).items;
    expect(item.id).toBe("appt-9");
    expect(item.id).toBe(item.appointmentId);
    expect(item.id).not.toBe(item.clientId);
  });
});

describe("5-7. the note facts each resolve ONCE", () => {
  it("Remember comes from nextVisitNote, and is never also the caution text", () => {
    // compactBeforeToday's `rememberLine` is `watchLines[0] ?? plan`, so when a
    // watch line existed the old Today card printed the CAUTION under
    // "Remember:" and the brief printed it again under "Caution noted:".
    const [item] = buildTodayWorkflow([
      input({
        nextVisitNote: "Try 0.6 mA next time.",
        cautionNote: "Reacts to lidocaine.",
      }),
    ]).items;
    expect(item.remember).toBe("Try 0.6 mA next time.");
    expect(item.caution).toBe("Reacts to lidocaine.");
    expect(item.remember).not.toBe(item.caution);
  });

  it("a caution with no plan note leaves Remember empty (not a copy of the caution)", () => {
    const [item] = buildTodayWorkflow([
      input({ nextVisitNote: null, cautionNote: "Reacts to lidocaine." }),
    ]).items;
    expect(item.remember).toBeNull();
    expect(item.caution).toBe("Reacts to lidocaine.");
  });

  it("blank/whitespace notes normalise to null rather than rendering an empty label", () => {
    const [item] = buildTodayWorkflow([
      input({ nextVisitNote: "   ", cautionNote: "\n\t " }),
    ]).items;
    expect(item.remember).toBeNull();
    expect(item.caution).toBeNull();
  });

  it("latest setup resolves once, and only when there is history", () => {
    const [withHistory] = buildTodayWorkflow([
      input({ hasHistory: true, setupLine: "27.12 MHz · Ballet F3" }),
    ]).items;
    expect(withHistory.setup).toBe("27.12 MHz · Ballet F3");
    const [noHistory] = buildTodayWorkflow([
      input({ hasHistory: false, setupLine: "27.12 MHz · Ballet F3" }),
    ]).items;
    // A "latest setup" for someone with no charted history is noise; the
    // no-history state already says everything.
    expect(noHistory.setup).toBeNull();
  });
});

describe("8-9. intake and charting are single-sourced states, not reminder lines", () => {
  it("intake is carried as ONE state, with no reminder-string duplicate", () => {
    for (const intake of ["reviewed", "submitted", "in_progress", "none"] as const) {
      const [item] = buildTodayWorkflow([input({ intake })]).items;
      expect(item.intake).toBe(intake);
      // The old brief pushed "Intake incomplete" / "Intake awaiting review" /
      // "No intake on file" as extra lines beside the pill. Gone.
      expect(item.missingRecords.join(" ")).not.toMatch(/intake/i);
    }
  });

  it("charting is carried as ONE state, with no reminder-string duplicate", () => {
    for (const charting of ["needs", "started", "charted", "none"] as const) {
      const [item] = buildTodayWorkflow([input({ charting })]).items;
      expect(item.charting).toBe(charting);
      expect(item.missingRecords.join(" ")).not.toMatch(/charting/i);
    }
  });

  it("the module emits no intake or charting reminder strings at all", () => {
    const SRC = readFileSync(
      join(process.cwd(), "lib/dashboard/today-workflow.ts"),
      "utf8",
    );
    const code = SRC.split("\n")
      .map((l) => l.replace(/^\s*\/\/.*$/, ""))
      .join("\n");
    for (const gone of [
      '"Intake incomplete"',
      '"Intake awaiting review"',
      '"No intake on file"',
      '"Charting needed"',
      '"Charting in progress"',
    ]) {
      expect(code).not.toContain(gone);
    }
  });
});

describe("10. missing-record reminders are specific and deduplicated", () => {
  it("shortens to the specific chip and drops duplicates, preserving order", () => {
    const [item] = buildTodayWorkflow([
      input({
        reminders: [
          "Probe lot not recorded on the last session",
          "Aftercare/risks not marked on the last session",
          "Probe lot missing from an earlier session", // shortens to the same chip
          "Date of birth missing from the client record",
        ],
      }),
    ]).items;
    expect(item.missingRecords).toEqual([
      "Probe lot missing",
      "Aftercare not marked",
      "Date of birth missing from record",
    ]);
  });

  it("carries no generic 'Records: N reminders' count alongside the chips", () => {
    const [item] = buildTodayWorkflow([
      input({ reminders: ["Probe lot not recorded", "Phone missing"] }),
    ]).items;
    expect(item.missingRecords).toHaveLength(2);
    expect(JSON.stringify(item)).not.toMatch(/Records: \d/);
    expect(JSON.stringify(item)).not.toMatch(/reminders\b/i);
  });

  it("an unmatched reminder passes through verbatim (already safe-worded)", () => {
    expect(shortenReminder("Something else entirely")).toBe(
      "Something else entirely",
    );
  });

  it("no reminders → an empty list, not a placeholder line", () => {
    const [item] = buildTodayWorkflow([input({ reminders: [] })]).items;
    expect(item.missingRecords).toEqual([]);
  });
});

describe("11. relationship state is stated once", () => {
  it("a no-history client carries hasHistory:false and no setup line", () => {
    const [item] = buildTodayWorkflow([
      input({ hasHistory: false, setupLine: "x" }),
    ]).items;
    expect(item.hasHistory).toBe(false);
    expect(item.setup).toBeNull();
  });

  it("the model emits no 'Returning client' badge string", () => {
    const [item] = buildTodayWorkflow([input({ hasHistory: true })]).items;
    // The old brief built a subtitle "Returning client · <service>" and a
    // duplicate tags array. Both duplicated facts already visible on the card.
    expect(JSON.stringify(item)).not.toMatch(/Returning client/);
    expect(JSON.stringify(item)).not.toMatch(/No prior treatment history yet/);
    expect(item).not.toHaveProperty("tags");
    expect(item).not.toHaveProperty("subtitle");
  });
});

describe("12. long and multiline note text is preserved in full", () => {
  const LONG = "A".repeat(400);
  const MULTILINE = "Line one\nLine two\n\nLine four";

  it("never truncates or caps a note", () => {
    const [item] = buildTodayWorkflow([
      input({ nextVisitNote: LONG, cautionNote: LONG, setupLine: LONG }),
    ]).items;
    expect(item.remember).toHaveLength(400);
    expect(item.caution).toHaveLength(400);
    expect(item.setup).toHaveLength(400);
    expect(item.remember).not.toMatch(/…|\.\.\./);
  });

  it("preserves intentional line breaks exactly", () => {
    const [item] = buildTodayWorkflow([
      input({ nextVisitNote: MULTILINE, cautionNote: MULTILINE }),
    ]).items;
    expect(item.remember).toBe(MULTILINE);
    expect(item.caution).toBe(MULTILINE);
    expect(item.remember?.split("\n")).toHaveLength(4);
  });

  it("only trims the outer edges, never the interior", () => {
    const [item] = buildTodayWorkflow([
      input({ nextVisitNote: "  keep\n  inner  indent  " }),
    ]).items;
    expect(item.remember).toBe("keep\n  inner  indent");
  });

  it("the module contains no cap, slice or clamp", () => {
    const SRC = readFileSync(
      join(process.cwd(), "lib/dashboard/today-workflow.ts"),
      "utf8",
    );
    for (const forbidden of [".slice(0,", ".substring(", "truncate", "line-clamp", "…"]) {
      expect(SRC).not.toContain(forbidden);
    }
  });
});

describe("13. purity", () => {
  it("does not mutate its inputs", () => {
    const reminders = ["Probe lot not recorded"];
    const one = input({ reminders });
    const snapshot = JSON.parse(JSON.stringify(one));
    buildTodayWorkflow([one]);
    expect(JSON.parse(JSON.stringify(one))).toEqual(snapshot);
    expect(reminders).toEqual(["Probe lot not recorded"]);
  });

  it("returns a fresh reminders array (mutating the output cannot reach the input)", () => {
    const reminders = ["Probe lot not recorded"];
    const [item] = buildTodayWorkflow([input({ reminders })]).items;
    item.missingRecords.push("injected");
    expect(reminders).toEqual(["Probe lot not recorded"]);
  });

  it("is deterministic — same input, identical output", () => {
    const inputs = [input({ appointmentId: "a" }), input({ appointmentId: "b" })];
    expect(JSON.stringify(buildTodayWorkflow(inputs))).toBe(
      JSON.stringify(buildTodayWorkflow(inputs)),
    );
  });

  it("does no I/O and reads no clock", () => {
    const SRC = readFileSync(
      join(process.cwd(), "lib/dashboard/today-workflow.ts"),
      "utf8",
    );
    for (const forbidden of ["Date.now", "new Date", "fetch(", "supabase", "await "]) {
      expect(SRC).not.toContain(forbidden);
    }
  });

  it("an empty day yields an empty workflow", () => {
    const w = buildTodayWorkflow([]);
    expect(w.items).toEqual([]);
    expect(w.hasItems).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wiring pins: the dashboard renders ONE list and the old brief is gone.
// ---------------------------------------------------------------------------
describe("dashboard wiring", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );

  it("builds the combined workflow and looks it up by appointment id", () => {
    expect(PAGE).toMatch(/buildTodayWorkflow\(todayWorkflowInputs\)/);
    expect(PAGE).toMatch(/todayWorkflowByAppointment\(todayWorkflow\)/);
    expect(PAGE).toMatch(/workflow=\{workflowByAppointment\.get\(appt\.id\) \?\? null\}/);
  });

  it("renders exactly ONE appointment list — the separate brief card is gone", () => {
    expect(PAGE).not.toMatch(/DailyPrepBriefCard/);
    expect(PAGE).not.toMatch(/daily-prep-brief/);
    expect(PAGE).not.toMatch(/buildDailyPrepBrief/);
    // Exactly ONE rendered appointment list: one <AppointmentRow>, one <li>
    // keyed by appointment. (Other visibleAppointments.map() calls extract ids
    // for batched lookups and render nothing.)
    expect(PAGE.match(/<AppointmentRow/g) ?? []).toHaveLength(1);
    expect(PAGE.match(/<li key=\{appt\.id\}>/g) ?? []).toHaveLength(1);
    // ...and only ONE place maps the appointments into JSX at all, so a second
    // list cannot be reintroduced beside it.
    expect(PAGE.match(/visibleAppointments\.map\(\(appt\) => \(/g) ?? []).toHaveLength(1);
    // No RENDERED "Daily prep brief" heading. (The code comments explain why
    // the card was retired; that prose is not a rendered heading.)
    const rendered = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(rendered).not.toMatch(/Daily prep brief/i);
  });

  // DASH-TRUTH-04: the daily workspace no longer asks a practitioner to email
  // the founder. The quiet pilot feedback footers under Today and To do are
  // gone, along with the earlier large "Pilot learning" card.
  it("renders NO pilot feedback prompt anywhere on the Dashboard", () => {
    const rendered = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(rendered).not.toMatch(/<PilotFeedbackPrompt/);
    expect(rendered).not.toMatch(/Send feedback|Send it to Sam|Know another electrologist|Pilot learning/i);
  });

  it("the card renders each fact once, from the workflow item only", () => {
    // Strip comments: the code explains WHY the old duplicate labels are gone,
    // and that prose must not be mistaken for a rendered label.
    const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // The old duplicated sources are no longer read by the row.
    expect(code).not.toMatch(/beforeToday\.rememberLine/);
    expect(code).not.toMatch(/beforeToday\.recordsLine/);
    expect(code).not.toMatch(/Last recorded:/);
    expect(code).not.toMatch(/For next visit:/);
    expect(code).not.toMatch(/Caution noted:/);
    // Exactly one rendered Remember, Caution and Latest setup label.
    expect(code.match(/Remember: \{workflow\.remember\}/g) ?? []).toHaveLength(1);
    expect(code.match(/Caution: \{workflow\.caution\}/g) ?? []).toHaveLength(1);
    expect(
      code.match(/Latest setup: \{workflow\.setup \?\? "Not recorded"\}/g) ?? [],
    ).toHaveLength(1);
  });

  it("full-text rendering from #486/#489 is preserved (no cap, no clamp)", () => {
    const start = PAGE.indexOf("function AppointmentRow(");
    const row = PAGE.slice(start, PAGE.indexOf("function AppointmentStatusPill("));
    for (const field of ["workflow.remember", "workflow.caution", "workflow.setup"]) {
      expect(row).toContain(field);
    }
    expect(row).toMatch(/whitespace-pre-wrap break-words/);
    expect(row).not.toMatch(/line-clamp/);
    // truncate() survives only for the pinned note, which is out of scope here.
    const truncs = row.match(/truncate\(/g) ?? [];
    expect(truncs.length).toBeLessThanOrEqual(1);
  });

  it("adds NO new database query for the combined view", () => {
    // The workflow is derived from facts already loaded; it must not await.
    const start = PAGE.indexOf("const todayWorkflowInputs");
    const end = PAGE.indexOf("const workflowByAppointment");
    expect(start).toBeGreaterThan(-1);
    expect(PAGE.slice(start, end)).not.toContain("await ");
  });

  it("preserves the row-body appointment link and the primary action resolver", () => {
    expect(PAGE).toMatch(/href=\{`\/calendar\/\$\{appt\.id\}`\}/);
    expect(PAGE).toMatch(/resolveDayNextAction\(\{/);
    expect(PAGE).toMatch(/<AppointmentCheckoutCell/);
  });

  it("the retired brief files are gone from the tree", () => {
    for (const gone of [
      "lib/dashboard/daily-prep-brief.ts",
      "app/(app)/dashboard/daily-prep-brief.tsx",
    ]) {
      let existed = true;
      try {
        readFileSync(join(process.cwd(), gone), "utf8");
      } catch {
        existed = false;
      }
      expect(existed, `${gone} should have been removed`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// One Today empty state. DaySummary used to print "No appointments today." as
// well as EmptyDayState, so the empty day said it twice.
// ---------------------------------------------------------------------------
describe("empty day renders ONE empty state", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  const rendered = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("only EmptyDayState renders the empty-day sentence", () => {
    // The sentence itself moved into `emptyDayMessage`, which says "today"
    // only when the roster really is showing today. What this test guards is
    // unchanged: exactly ONE surface prints it, and that surface is
    // EmptyDayState.
    expect(rendered.match(/emptyDayMessage\(/g) ?? []).toHaveLength(1);
    const emptyState = rendered.slice(rendered.indexOf("function EmptyDayState("));
    expect(emptyState).toContain("emptyDayMessage(selectedDay, todayLocal)");
    expect(emptyDayMessage("2026-08-20", "2026-08-20")).toBe("No appointments today.");
  });

  it("DaySummary renders nothing at all when there are no appointments", () => {
    const summary = rendered.slice(
      rendered.indexOf("function DaySummary("),
      rendered.indexOf("function AppointmentRow("),
    );
    expect(summary).toMatch(/if \(appointmentCount === 0\) return null;/);
    expect(summary).not.toContain("No appointments today.");
    expect(summary).not.toContain("emptyDayMessage");
  });

  it("a NON-empty day still summarises appointment and client counts", () => {
    const summary = rendered.slice(
      rendered.indexOf("function DaySummary("),
      rendered.indexOf("function AppointmentRow("),
    );
    expect(summary).toMatch(/appointmentCount === 1 \? "appointment" : "appointments"/);
    expect(summary).toMatch(/clientCount === 1 \? "client" : "clients"/);
    expect(summary).toMatch(/\{appt\}/);
    expect(summary).toMatch(/\{client\}/);
  });

  it("the Book appointment action is untouched", () => {
    expect(rendered).toMatch(/href="\/calendar"[\s\S]{0,300}Book appointment/);
  });

  it("no standalone Daily Prep Brief empty state survives", () => {
    expect(rendered).not.toMatch(/Nothing needs special review yet\./);
    expect(rendered).not.toMatch(/Daily prep brief/i);
  });
});
