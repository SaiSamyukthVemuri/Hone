import type { HistoryStatus } from "@/lib/dashboard/before-today-previews";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNextAction } from "@/lib/dashboard/next-action";

// PR #236: Dashboard Today next-action resolver. Pure logic tested
// directly; the dashboard wiring is source-pinned.

const base = {
  clientId: "c1",
  appointmentId: "a1",
  history: "absent" as HistoryStatus,
  sessionId: null as string | null,
  hasChartedArea: false,
};

describe("resolveNextAction", () => {
  it("upcoming + returning client: Review Before Today -> client page", () => {
    expect(
      resolveNextAction({ ...base, status: "confirmed", history: "present" }),
    ).toEqual({ label: "Review Before Today", href: "/clients/c1", chip: null });
  });

  it("upcoming + new client: Open client", () => {
    expect(resolveNextAction({ ...base, status: "confirmed" })).toEqual({
      label: "Open client",
      href: "/clients/c1",
      chip: null,
    });
  });

  it("completed without charting: Chart appointment + Charting needed chip", () => {
    expect(resolveNextAction({ ...base, status: "completed" })).toEqual({
      label: "Chart appointment",
      href: "/clients/c1/sessions/new?appointment_id=a1",
      chip: "Charting needed",
    });
  });

  it("session exists without areas: Continue charting (any status)", () => {
    for (const status of ["confirmed", "completed"]) {
      expect(
        resolveNextAction({ ...base, status, sessionId: "s1" }),
      ).toEqual({
        label: "Continue charting",
        href: "/clients/c1/sessions/s1",
        chip: null,
      });
    }
  });

  it("charted session: View session + Charted chip (any status)", () => {
    expect(
      resolveNextAction({
        ...base,
        status: "completed",
        sessionId: "s1",
        hasChartedArea: true,
      }),
    ).toEqual({
      label: "View session",
      href: "/clients/c1/sessions/s1",
      chip: "Charted",
    });
  });

  it("cancelled / no-show: quiet Open client, no chip", () => {
    for (const status of ["cancelled", "no_show"]) {
      expect(resolveNextAction({ ...base, status })).toEqual({
        label: "Open client",
        href: "/clients/c1",
        chip: null,
      });
    }
  });

  it("every href is app-internal", () => {
    for (const status of ["confirmed", "completed", "cancelled"]) {
      const action = resolveNextAction({ ...base, status });
      expect(action.href.startsWith("/clients/")).toBe(true);
    }
  });
});

describe("dashboard wiring (source pins)", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  const RESOLVER = readFileSync(
    join(process.cwd(), "lib/dashboard/next-action.ts"),
    "utf8",
  );

  it("the row resolves and renders the primary action", () => {
    expect(PAGE).toMatch(/resolveNextAction\(\{/);
    expect(PAGE).toMatch(/\{nextAction\.label\}/);
    expect(PAGE).toMatch(/href=\{nextAction\.href\}/);
    expect(PAGE).toMatch(/\{nextAction\.chip\}/);
  });

  it("linked-session facts come from two batched studio-scoped reads", () => {
    expect(PAGE).toMatch(
      /\.from\("sessions"\)[\s\S]*?\.eq\("studio_id", studio\.id\)[\s\S]*?\.in\("appointment_id", apptIds\)[\s\S]*?\.is\("deleted_at", null\)/,
    );
    expect(PAGE).toMatch(
      /\.from\("session_blocks"\)[\s\S]*?\.eq\("studio_id", studio\.id\)[\s\S]*?\.is\("deleted_at", null\)/,
    );
  });

  it("no nested anchors: the row body link and action link are siblings", () => {
    expect(PAGE).not.toMatch(/<Link[^>]*calendar\/\$\{appt\.id\}[\s\S]{0,2000}?<Link[^>]*nextAction/);
  });

  it("safe wording only in the resolver", () => {
    // Executable lines only; the header comment legitimately states
    // what the resolver never does.
    const executable = RESOLVER.split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(executable).not.toMatch(/recommend|score|monitor|unsafe|caused|diagnos/i);
  });
});

describe("UNAVAILABLE is a deliberate neutral degradation, not a coerced false", () => {
  it("an unanswered history read does NOT get the returning-client review", () => {
    expect(
      resolveNextAction({ ...base, status: "confirmed", history: "unavailable" }),
    ).toEqual({ label: "Open client", href: "/clients/c1", chip: null });
  });

  it("it lands on the SAME destination as the proven-absent case", () => {
    // "Open client" asserts nothing about the relationship and its href is
    // correct either way, which is why it is the chosen neutral fallback. What
    // must never happen is the reverse — an unavailable read claiming the
    // returning-client affordance, or a returning client losing it.
    const unavailable = resolveNextAction({ ...base, status: "confirmed", history: "unavailable" });
    const absent = resolveNextAction({ ...base, status: "confirmed", history: "absent" });
    expect(unavailable).toEqual(absent);
    expect(unavailable.label).not.toBe("Review Before Today");
  });

  it("the charting rules still win over history, whatever its state", () => {
    // Order matters: a started session is a stronger fact than any history
    // question, so an unavailable read must not disturb it.
    for (const history of ["present", "absent", "unavailable"] as const) {
      expect(
        resolveNextAction({ ...base, status: "confirmed", history, sessionId: "s1" }).label,
      ).toBe("Continue charting");
      expect(
        resolveNextAction({ ...base, status: "completed", history }).chip,
      ).toBe("Charting needed");
    }
  });

  it("no history state produces an alarming primary button", () => {
    for (const history of ["present", "absent", "unavailable"] as const) {
      const label = resolveNextAction({ ...base, status: "confirmed", history }).label;
      expect(label).not.toMatch(/error|failed|unavailable/i);
    }
  });
});
