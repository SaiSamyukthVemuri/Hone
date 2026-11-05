import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TreatmentPlanAttachment } from "@/components/treatment-plan-attachment";

// Codex P2 (#1351, r4472078957): in read-only chart mode (clin.edit_records Off) the plan attach/detach controls were still rendered and every click failed.
const noop = async () => ({ ok: true as const });
const base = { sessionId: "s", clientId: "c", attachAction: noop, detachAction: noop };
const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(TreatmentPlanAttachment, { ...base, ...props } as never));

describe("TreatmentPlanAttachment in read-only chart mode", () => {
  const attached = { id: "p", name: "Plan A", status: "active" as const };
  it("shows an attached plan as read-only text with no control, and offers no attach control when canEdit is false", () => {
    const ro = html({ attachedPlan: attached, activePlans: [], canEdit: false });
    expect(ro).toContain('data-testid="plan-attachment-read-only"');
    expect(ro).toContain("Attached to Plan A");
    expect(ro).not.toMatch(/<button|<select|Detach|aria-label/);
    expect(html({ attachedPlan: null, activePlans: [{ id: "p", name: "Plan A" }], canEdit: false })).toBe("");
    expect(html({ attachedPlan: null, activePlans: [{ id: "p", name: "A" }, { id: "q", name: "B" }], canEdit: false })).toBe("");
  });
  it("control: with canEdit true the controls are rendered as before", () => {
    expect(html({ attachedPlan: attached, activePlans: [], canEdit: true })).toContain("Detach from this plan");
    expect(html({ attachedPlan: null, activePlans: [{ id: "p", name: "Plan A" }], canEdit: true })).toContain("Attach to Plan A");
  });
  it("the session page passes canEditRecords to both uses, and the plan banner (which shows the attached plan) is not gated", () => {
    const src = readFileSync(join(process.cwd(), "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"), "utf8");
    expect(src.match(/canEdit=\{canEditRecords\}/g)).toHaveLength(2);
    expect(src).toContain("<TreatmentPlanBanner");
  });
});

describe("session start time in read-only chart mode (Codex P2, r4472078942)", () => {
  it("the page renders the start time as static text when editing is unavailable, and the editor only with the edit key", () => {
    const src = readFileSync(join(process.cwd(), "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"), "utf8");
    expect(src).toMatch(/\{canEditRecords \? \(\s*<EditSessionStartedAt/);
    expect(src).toContain('data-testid="session-started-at-static"');
    expect(src).toMatch(/Started <FormattedDateTime iso=\{session\.started_at\} \/>/);
  });
});
