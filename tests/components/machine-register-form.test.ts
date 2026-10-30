import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { activeProfiles } from "@/lib/machines/profile-contract";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";

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
    expect(page).toMatch(/registerMachineAction\(input\)/);
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
