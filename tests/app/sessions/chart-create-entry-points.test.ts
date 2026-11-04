import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Codex P2 sweep (#1351): every way to CREATE chart content is gated in the action AND the UI does not offer it to a viewer without clin.edit_records.
// Source pins (the repo's pattern for these pages); the ACTION side is also proved behaviourally in start-session-edit-gate and the 0289 DB tests.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const C = "app/(app)/clients/[id]";

describe("new session / start session", () => {
  it("the action asks the edit key and answers a refusal with a handled redirect, not a throw", () => {
    const a = strip(read(`${C}/sessions/new/actions.ts`));
    expect(a).toMatch(/requirePermission\(supabase, studio\.id, "clin\.edit_records", \{ client: clientId \}\)\)\.allowed\) \{\s*redirect\(`\/clients\/\$\{clientId\}\/sessions\/new`\);/);
    expect(a).not.toMatch(/throw new Error\(EDIT_RECORDS_REFUSAL\)/);
  });
  it("the page asks the edit key after the view key and explains instead of rendering the modality picker", () => {
    const p = strip(read(`${C}/sessions/new/page.tsx`));
    const view = p.indexOf('"clin.view_records"'), edit = p.indexOf('"clin.edit_records"'), picker = p.indexOf("<ModalityPicker");
    expect(view).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(view);
    expect(picker).toBeGreaterThan(edit);
    expect(p).toContain('data-testid="new-session-read-only"');
    expect(p).toContain("{EDIT_RECORDS_REFUSAL}");
  });
  it("the client profile offers 'Log session' only with the edit key and says why otherwise", () => {
    const p = strip(read(`${C}/page.tsx`));
    expect(p).toMatch(/\{canEditRecords \? \(\s*<PendingLink\s+href=\{`\/clients\/\$\{client\.id\}\/sessions\/new`\}/);
    expect(p).toContain('data-testid="log-session-read-only"');
  });
  it("the Sessions tab timeline's 'Chart session' link is behind canChart, fed from canEditRecords", () => {
    expect(strip(read("components/client-appointment-timeline.tsx"))).toMatch(/\{canChart && \(\s*<Link\s+href=\{`\/clients\/\$\{clientId\}\/sessions\/new\?appointment_id=/);
    expect(strip(read(`${C}/page.tsx`))).toMatch(/<ClientAppointmentTimeline[\s\S]*?canChart=\{canEditRecords\}/);
  });
  it("the appointment page's two start-a-chart CTAs are behind canEditRecords", () => {
    const p = strip(read("app/(app)/calendar/[id]/page.tsx"));
    expect(p).toMatch(/const canEditRecords = canViewRecords && \(await requirePermission\(supabase, studio\.id, "clin\.edit_records", \{ appointment: id \}\)\)\.allowed;/);
    expect(p).toMatch(/\{canEditRecords \? \(\s*<Link\s+href=\{`\/clients\/\$\{clientId\}\/sessions\/new\?appointment_id=/);
    expect(p).toContain('data-testid="next-step-read-only"');
    expect(p).toMatch(/<ChartSessionCard[\s\S]*?canEditRecords=\{canEditRecords\}/);
    expect(p).toMatch(/<NextStepCard[\s\S]*?canEditRecords=\{canEditRecords\}/);
  });
});

describe("every chart-CREATE server action asks clin.edit_records (action side of the sweep)", () => {
  it.each([
    ["new block (add settings block)", `${C}/sessions/[sessionId]/block-actions.ts`],
    ["copy setup / whole-session copy", `${C}/sessions/[sessionId]/whole-session-copy-actions.ts`],
    ["new note (consultation / clinical notes)", `${C}/clinical-notes-actions.ts`],
    ["new plan", `${C}/treatment-plans-actions.ts`],
    ["start session", `${C}/sessions/new/actions.ts`],
  ])("%s", (_n, file) => {
    expect(strip(read(file))).toMatch(/"clin\.edit_records"/);
  });
});

describe("their UI entry points are withdrawn in read-only mode (UI side of the sweep)", () => {
  const view = strip(read(`${C}/sessions/[sessionId]/session-blocks-view.tsx`));
  const notes = strip(read("components/clinical-notes-section.tsx"));
  const plans = strip(read("components/treatment-plans-card.tsx"));
  it("new block / copy setup: the blocks view and the copy panel honour readOnly / canEditRecords", () => {
    expect(view).toMatch(/readOnly/);
    expect(strip(read(`${C}/sessions/[sessionId]/page.tsx`))).toMatch(/canEditRecords &&\s*session\.modality === "electrolysis"/); // CopyPreviousAreasPanel
  });
  it("new note: the clinical notes section takes readOnly", () => expect(notes).toMatch(/readOnly/));
  it("new plan: the plans card takes readOnly and a deep link cannot open the create form", () => {
    expect(plans).toMatch(/readOnly/);
    expect(plans).toMatch(/useState\(autoOpenCreate && !readOnly\)/);
  });
});
