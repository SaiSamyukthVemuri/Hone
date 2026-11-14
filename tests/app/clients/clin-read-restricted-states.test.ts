import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/dashboard/attention-actions", () => ({ dismissAttentionAction: vi.fn(), restoreAttentionAction: vi.fn() }));
vi.mock("@/lib/intake/fitzpatrick", () => ({ computeFitzpatrickEstimate: () => ({ type: 4, score: 22 }) }));
vi.mock("@/lib/intake/questionnaire", () => ({ questionnaireForRow: () => ({ kind: "ok" }) }));

import { RestrictedNote } from "@/components/restricted-note";
import { GATED_RESTRICTED, RESTRICTED_COPY, gatedOk } from "@/lib/permissions/gated";
import { selfReportedFitzpatrickFor } from "@/lib/intake/self-reported-fitzpatrick";
import { computePortalPendingTasks } from "@/lib/portal/pending-tasks";
import { PortalAccessCard } from "@/app/(app)/clients/[id]/PortalAccessCard";
import { NeedsAttentionPanel } from "@/app/(app)/dashboard/needs-attention-panel";
import { TreatmentImagesManager } from "@/app/(app)/clients/[id]/images/TreatmentImagesManager";
import type { NeedsAttention } from "@/lib/dashboard/needs-attention-model";

// Roles clinical-read gating, Part B: ONE restricted display, and the three surfaces Sam named. Synthetic data only.
const read = (p: string) => readFileSync(p, "utf8");
const SUBMITTED = { questionnaire_snapshot: {}, responses: { q: "a" } };

describe("the one restricted display", () => {
  it("renders exactly the shared wording and takes no data", () => {
    const out = renderToStaticMarkup(createElement(RestrictedNote, { testId: "x" }));
    expect(out).toContain(RESTRICTED_COPY);
    expect(RESTRICTED_COPY).toBe("Not available to your role.");
    expect(out).toContain('data-testid="x"');
  });
});

describe("intake card: restricted is never 'Not completed'", () => {
  it("a viewer without clin.view_intake gets restricted even when a submitted intake exists (nothing leaks)", () => {
    const g = selfReportedFitzpatrickFor(false, SUBMITTED);
    expect(g).toEqual(GATED_RESTRICTED);
    expect(JSON.stringify(g)).not.toMatch(/4|22|type|score/);
  });
  it("a viewer with the key and no submitted intake gets ok(null): 'Not completed' is true there", () => {
    expect(selfReportedFitzpatrickFor(true, null)).toEqual(gatedOk(null));
  });
  it("a viewer with the key and a submitted intake gets the estimate (owner/keyed unchanged)", () => {
    expect(selfReportedFitzpatrickFor(true, SUBMITTED)).toEqual(gatedOk({ type: 4, score: 22 }));
  });
  it("the client page renders RestrictedNote for restricted and keeps 'Not completed' only on the ok branch", () => {
    const page = read("app/(app)/clients/[id]/page.tsx");
    expect(page).toMatch(/selfReportedFitzpatrick\.kind === "restricted" \? \(\s*<RestrictedNote/);
    expect(page).toMatch(/selfReportedFitzpatrick\.kind === "ok" && selfReportedFitzpatrick\.value\s*\?[^:]*:\s*"Not completed"/);
    expect(page).toContain("selfReportedFitzpatrickFor(intakeAllowed, submittedIntake)");
  });
});

describe("Overview signed consents: restricted shows no form text, response or signature", () => {
  it("the consent card is replaced by RestrictedNote without clin.view_intake, and nothing is loaded", () => {
    const page = read("app/(app)/clients/[id]/page.tsx");
    // both consent loaders wait on the gate: without clin.view_intake they resolve to [] and read nothing
    expect(page).toMatch(/canViewIntakePromise\.then\(\(ok\) => \(ok \? getConsentTemplatesForStudio\(/);
    expect(page).toMatch(/canViewIntakePromise\.then\(\(ok\) => \(ok \? getLatestSignaturesForPractitionerView\(/);
    expect(page).toMatch(/\{intakeAllowed \? \(\s*<ConsentSignaturesCard[\s\S]*?\) : \(\s*<RestrictedNote testId="consent-signatures-not-available" \/>/);
    expect(page).toContain("consentRestricted: !intakeAllowed");
  });
  it("pending portal tasks: restricted consent is null, not a zero, and never counts", () => {
    const t = computePortalPendingTasks({
      intakeStatus: null, activeConsentTemplates: [], latestSignatures: [], portalMessages: [], consentRestricted: true,
    });
    expect(t.consentToSignCount).toBeNull();
    expect(t.hasAny).toBe(false);
  });
  it("the portal card says restricted for consent and never the all-clear", () => {
    const t = computePortalPendingTasks({
      intakeStatus: null, activeConsentTemplates: [], latestSignatures: [], portalMessages: [], consentRestricted: true,
    });
    const out = renderToStaticMarkup(createElement(PortalAccessCard, {
      clientId: "c1", portalLoginUrl: "/portal/login?studio=s", clientHasEmail: true, lastLinkSentAt: null, lastSeenAt: null, pendingTasks: t,
    }));
    expect(out).toContain("Not available to your role.");
    expect(out).not.toContain("No pending portal tasks");
    expect(out).not.toMatch(/consent forms? to sign/i);
  });
  it("a keyed viewer is unchanged: a zero is still the all-clear, a count is still shown", () => {
    const zero = computePortalPendingTasks({ intakeStatus: null, activeConsentTemplates: [], latestSignatures: [], portalMessages: [] });
    expect(zero.consentToSignCount).toBe(0);
    const one = computePortalPendingTasks({ intakeStatus: null, activeConsentTemplates: [{ id: "t", version: 1 }], latestSignatures: [], portalMessages: [] });
    expect(one.consentToSignCount).toBe(1);
  });
});

describe("photo upload: the session picker is hidden without record access; upload permission is not widened", () => {
  const img = { id: "i1", sessionDate: null, scopeLabel: "Photo", areaLabel: null, createdAt: "2026-11-01T00:00:00Z", previewUrl: null, thumbUrl: null, note: null, originalFilename: "a.jpg" } as never;
  it("no session options => no 'Photo context' picker is rendered", () => {
    const out = renderToStaticMarkup(createElement(TreatmentImagesManager, { clientId: "c1", images: [img], sessionOptions: [] }));
    expect(out).not.toContain("Photo context");
    expect(out).not.toContain("Select a session");
  });
  it("with session options (a keyed viewer) the picker is offered, unchanged", () => {
    const out = renderToStaticMarkup(createElement(TreatmentImagesManager, {
      clientId: "c1", images: [img], sessionOptions: [{ id: "s1", startedAt: "2026-10-01T10:00:00Z", blocks: [] }],
    }));
    expect(out).toContain("Photo context");
  });
  it("the page reads sessions, areas and the session date only with clin.view_records, and the action refuses a forged session id without it", () => {
    const page = read("app/(app)/clients/[id]/images/page.tsx");
    expect(page).toContain('requirePermission(supabase, studio.id, "clin.view_records", { client: id })');
    expect(page).toMatch(/canViewRecords\s*\?\s*await supabase\s*\.from\("sessions"\)/);
    expect(page).toMatch(/sessionPicker\.kind === "ok" \? sessionPicker\.value : \[\]/);
    expect(page).toMatch(/sessionDate: canViewRecords \?/);
    expect(page).toMatch(/areaLabel: canViewRecords \?/);
    const action = read("app/(app)/clients/[id]/images/actions.ts");
    expect(action).toMatch(/if \(requestedSessionBlockId \|\| requestedSessionId\) \{\s*const records = await requirePermission\(supabase, studio\.id, "clin\.view_records"/);
    // upload permission is unchanged: no new upload gate and no widened check was added
    expect(action).not.toMatch(/clin\.upload_photos[^\n]*\|\|/);
  });
});

describe("dashboard intake review: a viewer without clin.view_intake gets the restricted display, never a zero, names or dates", () => {
  const base: NeedsAttention = {
    clients: [], studioItems: [], itemCount: 0, entries: [], issueCount: 0, others: [], notReturnedCount: 0, unavailableChecks: [],
    notAvailableToRole: false, intakeReviewNotAvailable: false, detailsWindow: null,
  };
  it("renders the intake restricted note and not the all-clear", () => {
    const out = renderToStaticMarkup(createElement(NeedsAttentionPanel, { needs: { ...base, intakeReviewNotAvailable: true } }));
    expect(out).toContain("Intake review is not available to your role.");
    expect(out).not.toContain("Nothing needs attention right now");
  });
  it("a keyed viewer is unchanged: the empty list is still the all-clear", () => {
    expect(renderToStaticMarkup(createElement(NeedsAttentionPanel, { needs: base }))).toContain("Nothing needs attention right now");
  });
  it("the reader runs only after the clin.view_intake gate (page.tsx), and the heading never shows a number to a restricted viewer", () => {
    const page = read("app/(app)/dashboard/page.tsx");
    expect(page).toMatch(/isOwner \|\| \(await requirePermission\(supabase, studio\.id, "clin\.view_intake"\)\)\.allowed;\s*return allowed \? await getIntakesAwaitingReview\(supabase, studio\.id\) : CHECK_RESTRICTED;/);
    const stack = read("app/(app)/dashboard/secondary-stack.tsx");
    expect(stack).toMatch(/v\.shown\.notAvailableToRole \|\| v\.shown\.intakeReviewNotAvailable\s*\?\s*"Not available to your role"/);
  });
});
