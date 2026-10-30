import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { OWNER_INPUT_REQUEST } from "@/lib/machines/owner-input-copy";
import path from "node:path";
import { activeProfiles } from "@/lib/machines/profile-contract";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import { matchNavEntries } from "@/lib/search/navigation-registry";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MachineRegisterForm, registrationProblem } = await import(
  "@/components/machines/machine-register-form"
);

const MODELS = [{ profileId: "model-a", label: "Maker Alpha" }];
const noop = async () => ({ ok: true });
const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

describe("the registration form", () => {
  it("offers the listed reviewed models and a name field", () => {
    const html = renderToStaticMarkup(
      createElement(MachineRegisterForm, { models: MODELS, register: noop }),
    );
    expect(html).toContain("Maker Alpha");
    expect(html).toContain("Name for this unit");
    expect(html).toContain('data-testid="machine-register-submit"');
  });

  it("with no reviewed model, says so and renders no form", () => {
    const html = renderToStaticMarkup(
      createElement(MachineRegisterForm, { models: [], register: noop }),
    );
    expect(html).toContain('data-testid="machine-register-none"');
    expect(html).not.toContain("machine-register-form");
  });

  it("refuses a model that is not in the list, and a bad name", () => {
    expect(registrationProblem("other", "Room 1", MODELS)).toMatch(/listed models/);
    expect(registrationProblem("model-a", "   ", MODELS)).toMatch(/name/);
    expect(registrationProblem("model-a", "x".repeat(81), MODELS)).toMatch(/name/);
    expect(registrationProblem("model-a", " Room 1 ", MODELS)).toBeNull();
  });
});

describe("the owner route stays reviewed-only and owner-only", () => {
  const page = read("app/(app)/settings/machines/page.tsx");

  it("lists only ACTIVE profiles from the server's catalogue", () => {
    expect(page).toMatch(/activeProfiles\(catalogue\)/);
    expect(page).toMatch(/catalogueForRuntime\(\)/);
  });

  it("refuses a non-owner before reading or rendering anything", () => {
    const gate = page.indexOf('practitioner.role !== "owner"');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(page.indexOf("listStudioMachines("));
    expect(gate).toBeLessThan(page.indexOf("<MachineRegisterForm"));
  });

  it("registers through the existing action, which re-checks the model and the contract", () => {
    expect(page).toMatch(/registerMachineAction\(\{\s*profileId: input\.profileId,\s*displayName: input\.displayName,?\s*\}\)/);
    expect(page).not.toMatch(/register_studio_machine|\.rpc\(/);
  });

  it("the tab is inside the owner-only block of the settings layout", () => {
    const layout = read("app/(app)/settings/layout.tsx");
    const owner = layout.indexOf("isOwner\n      ? [");
    const tab = layout.indexOf('"/settings/machines"');
    expect(owner).toBeGreaterThan(-1);
    expect(tab).toBeGreaterThan(owner);
    expect(layout.slice(owner, tab)).not.toContain(": []");
  });

  it("CONTROL: with the shipped catalogue the list is whatever is active, never inactive", () => {
    const active = new Set(activeProfiles(MACHINE_CATALOGUE).map((p) => p.profileId));
    for (const p of MACHINE_CATALOGUE) {
      if (p.availability !== "active") expect(active.has(p.profileId)).toBe(false);
    }
  });
});

describe("Global Search finds the Machines page for an owner only", () => {
  const owner = { isOwner: true, googleCalendarEnabled: false };
  const staff = { isOwner: false, googleCalendarEnabled: false };
  const hrefs = (q: string, ctx: typeof owner) =>
    matchNavEntries(q, ctx).map((m) => m.entry.href);

  it("an owner typing 'register a machine' reaches /settings/machines", () => {
    expect(hrefs("register a machine", owner)).toContain("/settings/machines");
  });

  it("a practitioner does not get the owner-only page", () => {
    expect(hrefs("register a machine", staff)).not.toContain("/settings/machines");
  });
});

describe("R5: one shared owner-input wording", () => {
  const squash = (t: string) => t.replace(/\s+/g, " ");

  it("carries the screen-photo and review caveats", () => {
    expect(OWNER_INPUT_REQUEST).toContain("a photo of the screen with no client on screen");
    expect(OWNER_INPUT_REQUEST).toContain("Never include client details");
    expect(OWNER_INPUT_REQUEST).toContain("Sending this starts a review; it does not add the model.");
    expect(OWNER_INPUT_REQUEST).toContain("Today only models that have passed their evidence review can be registered.");
  });

  it("the Machines page renders the constant, not its own copy", () => {
    expect(read("app/(app)/settings/machines/page.tsx")).toMatch(/\{OWNER_INPUT_REQUEST\}/);
  });

  it("the charting panel hint, once it carries the review caveat, carries this exact text", () => {
    const panel = squash(read("components/machines/machine-first-setup-panel.tsx"));
    if (!panel.includes("Sending this starts a review")) return; // #1272 not merged yet
    expect(panel).toContain(OWNER_INPUT_REQUEST);
  });
});

describe("R3: a non-owner gets the refusal and nothing else", () => {
  it("renders only the refusal, reads no machines and registers nothing", async () => {
    vi.resetModules();
    const listStudioMachines = vi.fn();
    const registerMachineAction = vi.fn();
    const createClient = vi.fn();
    vi.doMock("@/lib/supabase/queries", () => ({
      requirePractitionerWithStudio: async () => ({
        practitioner: { role: "practitioner" },
        studio: { id: "studio-synthetic" },
      }),
    }));
    vi.doMock("@/lib/supabase/server", () => ({ createClient }));
    vi.doMock("@/lib/machines/machine-queries", () => ({ listStudioMachines }));
    vi.doMock(
      "../../app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions",
      () => ({ registerMachineAction }),
    );
    const { default: Page } = await import("../../app/(app)/settings/machines/page");
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("Only studio owners can register machines.");
    expect(html).not.toContain("machine-register");
    expect(html).not.toContain("Register machine");
    expect(createClient).not.toHaveBeenCalled();
    expect(listStudioMachines).not.toHaveBeenCalled();
    expect(registerMachineAction).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/supabase/queries");
  });
});
