import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNextAction } from "@/lib/dashboard/next-action";

// PR #236: Dashboard Today next-action resolver. Pure logic tested
// directly; the dashboard wiring is source-pinned.

const base = {
  clientId: "c1",
  appointmentId: "a1",
  hasHistory: false,
  sessionId: null as string | null,
  hasChartedArea: false,
};

describe("resolveNextAction", () => {
  it("upcoming + returning client: Review Before Today -> client page", () => {
    expect(
      resolveNextAction({ ...base, status: "confirmed", hasHistory: true }),
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
