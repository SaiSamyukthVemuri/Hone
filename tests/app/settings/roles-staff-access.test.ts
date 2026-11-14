import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioPolicy } from "@/lib/permissions/catalog";
import { AUDIT_KIND_LABEL, ROLE_ERROR_CODES, roleErrorMessage } from "@/lib/settings/roles/api";
import { parseError, parseHistory, parseStaffActive } from "@/lib/settings/roles/core-parse";
import { REMOVE_ACCESS_COPY, RESTORE_ACCESS_COPY } from "@/lib/settings/roles/staff-access";

// Roles S2 wiring: remove and restore a person's access through the permission core (0342). The core is the only writer and the only judge;
// the page states the consequences, always asks for a reason, and shows the core's answer as is.

const owner = vi.hoisted(() => ({ role: "owner" }));
const core = vi.hoisted(() => ({
  coreDeactivateStaff: vi.fn(async () => ({ ok: true, membershipId: "m1", active: false })),
  coreReactivateStaff: vi.fn(async () => ({ ok: true, membershipId: "m1", active: true })),
}));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: vi.fn(async () => ({ practitioner: { role: owner.role }, studio: { id: "studio-1" } })),
}));
vi.mock("@/lib/settings/roles/core", () => core);
vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const actions = await import("@/app/(app)/settings/roles/actions");
const { RolesEditor } = await import("@/app/(app)/settings/roles/roles-editor");

const M = "11111111-1111-4111-8111-111111111111";
const GOOD = "  left the studio at the end of the month  ";
beforeEach(() => {
  owner.role = "owner";
  core.coreDeactivateStaff.mockClear();
  core.coreReactivateStaff.mockClear();
});

describe.each([
  ["deactivateStaffAction", () => actions.deactivateStaffAction, () => core.coreDeactivateStaff],
  ["reactivateStaffAction", () => actions.reactivateStaffAction, () => core.coreReactivateStaff],
] as const)("%s", (_name, action, coreFn) => {
  it("refuses a non-owner without calling the core", async () => {
    owner.role = "practitioner";
    expect(await action()(M, "practitioner", GOOD)).toEqual({ ok: false, error: { code: "refused" } });
    expect(coreFn()).not.toHaveBeenCalled();
  });
  it("refuses a malformed id and an unknown kind (an owner is not a kind) before the core", async () => {
    expect(await action()("not-a-uuid", "practitioner", GOOD)).toEqual({ ok: false, error: { code: "not_found" } });
    expect(await action()(M, "owner", GOOD)).toEqual({ ok: false, error: { code: "unknown_role" } });
    expect(await action()(M, undefined, GOOD)).toEqual({ ok: false, error: { code: "unknown_role" } });
    expect(coreFn()).not.toHaveBeenCalled();
  });
  it("always needs a meaningful reason: blank, whitespace and placeholders are refused before the core", async () => {
    expect(await action()(M, "practitioner", "")).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(await action()(M, "practitioner", "   ")).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(await action()(M, "practitioner", undefined)).toEqual({ ok: false, error: { code: "reason_required" } });
    expect(await action()(M, "receptionist", "n/a")).toEqual({ ok: false, error: { code: "reason_invalid" } });
    expect(coreFn()).not.toHaveBeenCalled();
  });
  it("passes the trimmed reason and the kind to the core", async () => {
    await action()(M, "receptionist", GOOD);
    expect(coreFn()).toHaveBeenCalledWith("studio-1", M, "receptionist", "left the studio at the end of the month");
  });
  it("returns the core's refusal untouched (the page never overrides it)", async () => {
    coreFn().mockResolvedValueOnce({ ok: false, error: { code: "has_upcoming_appointments", count: 3 } } as never);
    expect(await action()(M, "practitioner", GOOD)).toEqual({ ok: false, error: { code: "has_upcoming_appointments", count: 3 } });
  });
});

describe("parsing", () => {
  it("the new refusal codes are known and have their own wording", () => {
    for (const c of ["reassign_required", "already_active", "other_membership_active"] as const) {
      expect(ROLE_ERROR_CODES).toContain(c);
      expect(parseError({ ok: false, code: c })).toEqual({ code: c });
      expect(roleErrorMessage({ code: c }).length).toBeGreaterThan(10);
    }
    expect(roleErrorMessage({ code: "reassign_required", count: 2 })).toContain("2 upcoming appointments");
    expect(roleErrorMessage({ code: "has_upcoming_appointments", count: 1 })).toContain("1 upcoming appointment.");
  });
  it("parseStaffActive reads the core's answer and refuses anything malformed as 'unexpected'", () => {
    expect(parseStaffActive({ ok: true, membership_id: M, kind: "practitioner", active: false })).toEqual({ ok: true, membershipId: M, active: false });
    expect(parseStaffActive({ ok: true, membership_id: M, kind: "practitioner", active: false, upcoming: 2 })).toEqual({ ok: true, membershipId: M, active: false, upcoming: 2 });
    expect(parseStaffActive({ ok: true, membership_id: M, active: false, upcoming: -1 })).toEqual({ ok: true, membershipId: M, active: false });
    expect(parseStaffActive({ ok: true, membership_id: M, active: false, upcoming: "2" })).toEqual({ ok: true, membershipId: M, active: false });
    expect(parseStaffActive({ ok: false, code: "not_active" })).toEqual({ ok: false, error: { code: "not_active" } });
    for (const bad of [null, "x", { ok: true }, { ok: true, membership_id: M }, { ok: true, membership_id: M, active: "no" }]) {
      expect(parseStaffActive(bad), JSON.stringify(bad)).toEqual({ ok: false, error: { code: "unexpected" } });
    }
  });
  it("History keeps both new kinds (an unknown kind is dropped) with a label and no invented changes", () => {
    const row = (id: number, kind: string, person: string | null) => ({ id, at: "2026-11-14T00:00:00Z", kind, role: "practitioner", actor_name: "Chloe Owner", person_name: person, person_state: person ? "deactivated" : null, reason: "left the studio", before: { active: true }, after: { active: false } });
    const r = parseHistory({ ok: true, rows: [row(3, "staff_deactivated", "Alex"), row(2, "staff_reactivated", "Alex"), row(1, "staff_exploded", "Alex")] }, 50);
    expect(r.ok && r.rows.map((x) => x.kind)).toEqual(["staff_deactivated", "staff_reactivated"]);
    expect(r.ok && r.rows.every((x) => Object.keys(x.before).length === 0 && Object.keys(x.after).length === 0)).toBe(true);
    expect(AUDIT_KIND_LABEL.staff_deactivated).toBe("Access removed");
    expect(AUDIT_KIND_LABEL.staff_reactivated).toBe("Access restored");
  });
});

describe("copy", () => {
  it("says nothing is deleted, that it is recorded with the reason, and warns about upcoming appointments", () => {
    const remove = REMOVE_ACCESS_COPY.bullets.join(" ");
    expect(remove).toContain("Nothing is deleted");
    expect(remove).toContain("history");
    expect(remove).toContain("upcoming appointments");
    expect(RESTORE_ACCESS_COPY.bullets.join(" ")).toContain("access set in Permissions");
    expect(REMOVE_ACCESS_COPY.reasonLabel).toBe("Why (required)");
    expect(REMOVE_ACCESS_COPY.title("Alex")).toBe("Remove Alex's access");
    // the count is information after the removal, in the owner's words; none when there are none
    expect(REMOVE_ACCESS_COPY.doneLine("Alex", 0)).toBe("Alex's access was removed. It is in the history.");
    expect(REMOVE_ACCESS_COPY.doneLine("Alex")).toBe("Alex's access was removed. It is in the history.");
    expect(REMOVE_ACCESS_COPY.doneLine("Alex", 1)).toContain("still have 1 upcoming appointment, which stays assigned");
    expect(REMOVE_ACCESS_COPY.doneLine("Alex", 3)).toContain("3 upcoming appointments");
    expect(REMOVE_ACCESS_COPY.bullets.join(" ")).not.toContain("cannot be removed");
  });
});

const policy: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };
const noop = async () => ({ ok: false as const, error: { code: "unavailable" as const } });
const people = [
  { id: "o1", name: "Chloe Owner", email: "o@example.test", role: "owner" as const, state: "active" as const, isSelf: true },
  { id: "p2", name: "Alex Practitioner", email: "a@example.test", role: "practitioner" as const, state: "active" as const },
  { id: "r1", name: "Riley Reception", email: "r@example.test", role: "receptionist" as const, state: "active" as const },
  { id: "d1", name: "Sam Former", email: "f@example.test", role: "practitioner" as const, state: "deactivated" as const },
  { id: "d2", name: "Dana Desk", email: "d@example.test", role: "receptionist" as const, state: "deactivated" as const },
  { id: "i1", name: "Taylor Invitee", email: "t@example.test", role: "receptionist" as const, state: "invited" as const },
  { id: "me", name: "Self Practitioner", email: "s@example.test", role: "practitioner" as const, state: "active" as const, isSelf: true },
];
const render = (gate: boolean) =>
  renderToStaticMarkup(
    createElement(RolesEditor, {
      policies: { practitioner: policy, receptionist: policy }, reviewed: false, writable: true, notWritableReason: null, staffRoleChange: gate, people,
      timezone: "America/Toronto", previewSave: noop, previewReset: noop, previewAdopt: noop, save: noop, reset: noop, adopt: noop,
      previewActivation: noop, activate: noop, loadHistory: noop, loadAccess: noop, reload: noop, changeRole: noop, deactivate: noop, reactivate: noop,
    }),
  );
const block = (html: string, id: string) => html.slice(html.indexOf(`data-person="${id}"`)).split("</li>")[0];

describe("who gets the controls", () => {
  it("remove: an active practitioner and an active receptionist, whether or not the role-change gate is on", () => {
    for (const gate of [false, true]) {
      const html = render(gate);
      for (const id of ["p2", "r1"]) expect(block(html, id), `${id} gate=${gate}`).toContain('data-testid="remove-access"');
    }
  });
  it("remove: never the owner, yourself, a deactivated or an invited person", () => {
    const html = render(true);
    for (const id of ["o1", "me", "d1", "d2", "i1"]) expect(block(html, id), id).not.toContain('data-testid="remove-access"');
  });
  it("restore: only a deactivated person, only with the gate on; with it off the page says not available yet", () => {
    const on = render(true);
    for (const id of ["d1", "d2"]) expect(block(on, id), id).toContain('data-testid="restore-access"');
    for (const id of ["o1", "p2", "r1", "me", "i1"]) expect(block(on, id), id).not.toContain('data-testid="restore-access"');
    const off = render(false);
    expect(off).not.toContain('data-testid="restore-access"');
    for (const id of ["d1", "d2"]) {
      expect(block(off, id)).toContain("Restoring access is not available yet.");
      expect(block(off, id)).not.toContain("<button type=\"button\" aria-expanded=\"false\" aria-controls=\"" + "restore"); // no dead control
      expect(block(off, id)).not.toContain("Restore access</button>");
    }
  });
});

describe("source pins", () => {
  const ui = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
  const a = readFileSync("app/(app)/settings/roles/actions.ts", "utf8");
  it("confirm is disabled until a meaningful reason is entered, and the core's answer is shown", () => {
    expect(ui).toContain('const reasonOk = reasonAcceptable("adopt", false, reason) && reason.trim() !== "";');
    expect(ui).toContain("disabled={busy || !reasonOk}");
    expect(ui).toContain("act(person.id, person.role, reason.trim())");
    expect(ui).toContain("roleErrorMessage(r.error)");
    // the count the core reports reaches the notice the owner reads
    expect(ui).toContain("copy.doneLine(person.name, r.upcoming)");
  });
  it("the action layer calls only the two core functions and never writes a membership table", () => {
    expect(a).toContain("coreDeactivateStaff(");
    expect(a).toContain("coreReactivateStaff(");
    expect(a).not.toMatch(/\.from\("(practitioners|studio_receptionists)"\)/);
  });
  it("the core calls the 0342 commands as the signed-in user", () => {
    const c = readFileSync("lib/settings/roles/core.ts", "utf8");
    expect(c).toContain('call("deactivate_staff_member"');
    expect(c).toContain('call("reactivate_staff_member"');
    expect(c).not.toMatch(/admin/i);
  });
  it("the page wires both actions", () => {
    const page = readFileSync("app/(app)/settings/roles/page.tsx", "utf8");
    expect(page).toContain("deactivate={deactivateStaffAction}");
    expect(page).toContain("reactivate={reactivateStaffAction}");
  });
  it("Team's Remove goes through the core with a required reason, as the signed-in owner, and no longer calls the admin RPC", () => {
    const t = readFileSync("app/(app)/settings/team/actions.ts", "utf8");
    const i = t.indexOf("export async function removePractitionerAction");
    const body = t.slice(i, t.indexOf("\n}\n", i));
    expect(body).toContain('coreDeactivateStaff(studioId, id, "practitioner", reason)');
    expect(body).toMatch(/if \(!reason \|\| !reasonAcceptable\("adopt", false, reason\)\)/);
    expect(body).toContain('formData.get("reason")');
    expect(body).not.toMatch(/createAdminClient|admin\.rpc|set_practitioner_active_locked/);
    const page = readFileSync("app/(app)/settings/team/page.tsx", "utf8");
    expect(page).toContain('name="reason"');
  });
});
