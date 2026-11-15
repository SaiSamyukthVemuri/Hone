import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioPolicy } from "@/lib/permissions/catalog";
import { ROLE_ERROR_CODES, roleErrorMessage } from "@/lib/settings/roles/api";
import { parseChangeRole, parseError } from "@/lib/settings/roles/core-parse";
import { changeRoleCopy } from "@/lib/settings/roles/change-role";

// Roles page part 3: change a person's role (change_staff_role, 0287). The core is the only writer and the only judge; the page states
// the consequences, requires a reason when the move widens clinical access, and shows the core's answer as is.

const owner = vi.hoisted(() => ({ role: "owner" }));
const core = vi.hoisted(() => ({
  coreChangeRole: vi.fn(async () => ({ ok: true, membershipId: "m-new", role: "receptionist" })),
}));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: vi.fn(async () => ({ practitioner: { role: owner.role }, studio: { id: "studio-1" } })),
}));
vi.mock("@/lib/settings/roles/core", () => core);
vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const actions = await import("@/app/(app)/settings/roles/actions");
const { RolesEditor } = await import("@/app/(app)/settings/roles/roles-editor");

const M = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  owner.role = "owner";
  core.coreChangeRole.mockClear();
});

describe("changeStaffRoleAction", () => {
  it("refuses a non-owner without calling the core", async () => {
    owner.role = "practitioner";
    expect(await actions.changeStaffRoleAction(M, "receptionist", "practitioner", "")).toEqual({ ok: false, error: { code: "refused" } });
    expect(core.coreChangeRole).not.toHaveBeenCalled();
  });
  it("refuses a malformed id, an owner/unknown role and a no-op before the core", async () => {
    expect(await actions.changeStaffRoleAction("not-a-uuid", "receptionist", "practitioner", "")).toEqual({ ok: false, error: { code: "not_found" } });
    expect(await actions.changeStaffRoleAction(M, "owner", "practitioner", "")).toEqual({ ok: false, error: { code: "owner_role_fixed" } });
    expect(await actions.changeStaffRoleAction(M, "receptionist", "owner", "")).toEqual({ ok: false, error: { code: "owner_role_fixed" } });
    expect(await actions.changeStaffRoleAction(M, "receptionist", "receptionist", "")).toEqual({ ok: false, error: { code: "nothing_changed" } });
    expect(core.coreChangeRole).not.toHaveBeenCalled();
  });
  it("requires a meaningful reason when a receptionist becomes a practitioner (clinical access widens)", async () => {
    expect(await actions.changeStaffRoleAction(M, "practitioner", "receptionist", "")).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(await actions.changeStaffRoleAction(M, "practitioner", "receptionist", "n/a")).toEqual({ ok: false, error: { code: "reason_invalid" } });
    expect(core.coreChangeRole).not.toHaveBeenCalled();
    await actions.changeStaffRoleAction(M, "practitioner", "receptionist", "  covering clinical shifts  ");
    expect(core.coreChangeRole).toHaveBeenCalledWith("studio-1", M, "practitioner", "receptionist", "covering clinical shifts");
  });
  it("a practitioner becoming a receptionist needs no reason, but a placeholder is still not entered", async () => {
    await actions.changeStaffRoleAction(M, "receptionist", "practitioner", "");
    expect(core.coreChangeRole).toHaveBeenCalledWith("studio-1", M, "receptionist", "practitioner", "");
    core.coreChangeRole.mockClear();
    expect(await actions.changeStaffRoleAction(M, "receptionist", "practitioner", "test")).toEqual({ ok: false, error: { code: "reason_invalid" } });
    expect(core.coreChangeRole).not.toHaveBeenCalled();
  });
  it("returns the core's refusal untouched (the page never overrides it)", async () => {
    core.coreChangeRole.mockResolvedValueOnce({ ok: false, error: { code: "has_upcoming_appointments", count: 3 } } as never);
    expect(await actions.changeStaffRoleAction(M, "receptionist", "practitioner", "")).toEqual({ ok: false, error: { code: "has_upcoming_appointments", count: 3 } });
  });
});

describe("parsing the core's answer", () => {
  it("accepts exactly the success shape and treats anything else as unexpected", () => {
    expect(parseChangeRole({ ok: true, membership_id: "m1", role: "receptionist" })).toEqual({ ok: true, membershipId: "m1", role: "receptionist" });
    for (const bad of [null, "x", { ok: true }, { ok: true, membership_id: "m1", role: "owner" }, { ok: true, membership_id: 5, role: "receptionist" }]) {
      expect(parseChangeRole(bad)).toEqual({ ok: false, error: { code: "unexpected" } });
    }
  });
  it("carries the refusal code and the upcoming-appointment count", () => {
    expect(parseChangeRole({ ok: false, code: "gate_unmet", gate: "staff_role_change" })).toEqual({ ok: false, error: { code: "gate_unmet" } });
    expect(parseError({ ok: false, code: "has_upcoming_appointments", count: 2 })).toEqual({ code: "has_upcoming_appointments", count: 2 });
    expect(parseError({ ok: false, code: "has_upcoming_appointments", count: "4" })).toEqual({ code: "has_upcoming_appointments", count: 4 });
    expect(parseError({ ok: false, code: "has_upcoming_appointments", count: -1 })).toEqual({ code: "has_upcoming_appointments" });
  });
  it("every refusal change_staff_role can return has a message, and the count is stated", () => {
    const sql = readFileSync("supabase/migrations/0287_roles_permission_engine.sql", "utf8");
    const body = sql.slice(sql.indexOf("create or replace function public.change_staff_role("), sql.indexOf("-- 7) Grants"));
    const codes = [...body.matchAll(/perm_fail\('([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(10);
    for (const c of new Set(codes)) {
      expect(ROLE_ERROR_CODES as readonly string[], c).toContain(c);
      expect(roleErrorMessage({ code: c as never }).length, c).toBeGreaterThan(10);
    }
    expect(roleErrorMessage({ code: "has_upcoming_appointments", count: 1 })).toContain("1 upcoming appointment.");
    expect(roleErrorMessage({ code: "has_upcoming_appointments", count: 3 })).toContain("3 upcoming appointments.");
  });
});

describe("the consequences the owner reads before confirming", () => {
  it("receptionist -> practitioner says it widens clinical access and requires a reason", () => {
    const c = changeRoleCopy("receptionist");
    expect(c).toMatchObject({ to: "practitioner", reasonRequired: true, reasonLabel: "Why (required)" });
    expect(c.bullets.join(" ")).toContain("clinical access");
    expect(c.bullets.join(" ")).not.toContain("upcoming appointments");
  });
  it("practitioner -> receptionist names the upcoming-appointment refusal and needs no reason", () => {
    const c = changeRoleCopy("practitioner");
    expect(c).toMatchObject({ to: "receptionist", reasonRequired: false, reasonLabel: "Why (optional)" });
    expect(c.bullets.join(" ")).toContain("upcoming appointments");
  });
  it("both say nothing is deleted, that it is immediate and recorded, and that Permissions decide the new access", () => {
    for (const from of ["practitioner", "receptionist"] as const) {
      const t = changeRoleCopy(from).bullets.join(" ");
      expect(t).toContain("Nothing is deleted");
      expect(t).toContain("immediately");
      expect(t).toContain("history");
      expect(t).toContain("access set in Permissions");
    }
  });
});

const policy: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };
const noop = async () => ({ ok: false as const, error: { code: "unavailable" as const } });
const people = [
  { id: "o1", name: "Chloe Owner", email: "o@example.test", role: "owner" as const, state: "active" as const, isSelf: true },
  { id: "p2", name: "Alex Practitioner", email: "a@example.test", role: "practitioner" as const, state: "active" as const },
  { id: "r1", name: "Riley Reception", email: "r@example.test", role: "receptionist" as const, state: "active" as const },
  { id: "d1", name: "Sam Former", email: "f@example.test", role: "practitioner" as const, state: "deactivated" as const },
  { id: "i1", name: "Taylor Invitee", email: "t@example.test", role: "receptionist" as const, state: "invited" as const },
  { id: "me", name: "Self Practitioner", email: "s@example.test", role: "practitioner" as const, state: "active" as const, isSelf: true },
];
const render = (gate: boolean) =>
  renderToStaticMarkup(
    createElement(RolesEditor, {
      policies: { practitioner: policy, receptionist: policy }, reviewed: false, writable: true, notWritableReason: null, staffRoleChange: gate, people,
      timezone: "America/Toronto", previewSave: noop, previewReset: noop, previewAdopt: noop, save: noop, reset: noop, adopt: noop,
      previewActivation: noop, activate: noop, loadHistory: noop, loadAccess: noop, reload: noop, changeRole: noop,
    }),
  );
const personBlock = (html: string, id: string) => html.slice(html.indexOf(`data-person="${id}"`)).split("</li>")[0];

describe("who gets the control", () => {
  it("gate off: nobody gets it, the page says it is not available yet", () => {
    const html = render(false);
    expect(html).not.toContain('data-testid="change-role"');
    expect(personBlock(html, "p2")).toContain("Change role: not available yet.");
  });
  it("gate on: an active practitioner and an active receptionist get 'Change role'", () => {
    const html = render(true);
    for (const id of ["p2", "r1"]) {
      expect(personBlock(html, id)).toContain('data-testid="change-role"');
      expect(personBlock(html, id)).toContain("Change role");
    }
  });
  it("gate on: never the owner, a deactivated or invited person; yourself gets the reason instead", () => {
    const html = render(true);
    for (const id of ["o1", "d1", "i1"]) expect(personBlock(html, id)).not.toContain('data-testid="change-role"');
    expect(personBlock(html, "me")).not.toContain('data-testid="change-role"');
    expect(personBlock(html, "me")).toContain("You cannot change your own role.");
    expect(personBlock(html, "p2")).not.toContain("not available yet");
  });
});

describe("source pins", () => {
  const ui = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
  it("confirm is disabled until the reason rule holds, and the result is shown from the core's answer", () => {
    expect(ui).toMatch(/const canConfirm = !busy && reasonOk && \(!needsReason \|\| reason\.trim\(\) !== ""\);/);
    expect(ui).toContain("changeRole(person.id, target, person.role, reason.trim())");
    expect(ui).toContain("roleErrorMessage(r.error)");
  });
  it("the page passes the signed-in owner's own row as isSelf and wires the one action", () => {
    const page = readFileSync("app/(app)/settings/roles/page.tsx", "utf8");
    expect(page).toContain("isSelf: p.id === practitioner.id");
    expect(page).toContain("changeRole={changeStaffRoleAction}");
  });
  it("only the core function writes: the action layer calls coreChangeRole and nothing else changes memberships", () => {
    const a = readFileSync("app/(app)/settings/roles/actions.ts", "utf8");
    expect(a).toContain("coreChangeRole(");
    expect(a).not.toMatch(/\.from\("(practitioners|studio_receptionists)"\)/);
  });
});
