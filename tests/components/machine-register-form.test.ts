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

  it("the tab is an owner-only entry in the settings nav registry", () => {
    const registry = read("lib/settings/nav-registry.ts");
    expect(registry).toMatch(/href: "\/settings\/machines", roles: OWNER/);
  });

  it("CONTROL: with the shipped catalogue the list is whatever is active, never inactive", () => {
    // Keyed by id AND version: a retired v1/v2 shares its id with the active v3.
    const active = new Set(activeProfiles(MACHINE_CATALOGUE).map((p) => `${p.profileId}@${p.version}`));
    for (const p of MACHINE_CATALOGUE) {
      if (p.availability !== "active") expect(active.has(`${p.profileId}@${p.version}`)).toBe(false);
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

  it("the charting panel renders the constant, not its own copy", () => {
    const panel = read("components/machines/machine-first-setup-panel.tsx");
    expect(panel).toMatch(/from "@\/lib\/machines\/owner-input-copy"/);
    expect(panel).toMatch(/\{OWNER_INPUT_REQUEST\}/);
    // No second copy of the wording may creep back in beside the constant.
    expect(squash(panel)).not.toContain("Sending this starts a review");
    expect(squash(panel)).not.toContain("with no client on screen");
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

describe("owner page state: reviewed-active models without a published contract are not offered", () => {
  const load = async (published: string[] | null) => {
    vi.resetModules();
    const registerMachineAction = vi.fn();
    vi.doMock("@/lib/supabase/queries", () => ({
      requirePractitionerWithStudio: async () => ({ practitioner: { role: "owner" }, studio: { id: "studio-synthetic" } }),
    }));
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
    vi.doMock("@/lib/machines/machine-queries", () => ({
      listStudioMachines: async () => ({ ok: true, value: [] }),
      publishedModesFor: async (_db: unknown, profileId: string) =>
        published === null
          ? { ok: false, error: "read failed" }
          : { ok: true, value: profileId === "dectro-apilus:senior-3g" ? published : [] },
    }));
    vi.doMock("../../app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => ({ registerMachineAction }));
    const { default: Page } = await import("../../app/(app)/settings/machines/page");
    return renderToStaticMarkup(await Page());
  };
  const SENIOR_MODES = ["flash", "microflash", "multiplex", "blend", "omniblend", "multiblend", "electrolysis"];

  it("nothing published: the honest 'not available yet' message, no Apilus option", async () => {
    const html = await load([]);
    expect(html).toContain("machine-register-none");
    expect(html).toContain("No machine model is available to register yet");
    expect(html).not.toContain("Senior 3G");
    expect(html).not.toContain("Junior 3G");
  });
  it("a failed contract read offers nothing", async () => {
    expect(await load(null)).toContain("machine-register-none");
  });
  it("a partly published model is not offered", async () => {
    expect(await load(SENIOR_MODES.slice(1))).not.toContain("Senior 3G");
  });
  it("fully published: only that model is offered (Junior stays absent)", async () => {
    const html = await load(SENIOR_MODES);
    expect(html).toContain("Senior 3G");
    expect(html).not.toContain("Junior 3G");
    expect(html).not.toContain("machine-register-none");
  });
});
