import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESTORE_OUTCOMES, parseRestoreOutcome, restoreHref, restoreOutcomeCopy, restoreOutcomeFromRpc } from "@/lib/team/restore-outcome";

// Team page: restore a removed practitioner. Synthetic data; queries and the admin client are mocked, page and action are real.

const ACTIONS = readFileSync("app/(app)/settings/team/actions.ts", "utf8");
const PAGE = readFileSync("app/(app)/settings/team/page.tsx", "utf8");
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("outcome mapping", () => {
  it("maps each command result to one outcome, and anything unknown is a failure, never a restore", () => {
    expect(restoreOutcomeFromRpc("ok", null)).toBe("restored");
    expect(restoreOutcomeFromRpc("invalid_practitioner", null)).toBe("not_found");
    expect(restoreOutcomeFromRpc("cannot_modify_owner", null)).toBe("owner");
    for (const odd of ["not_authorized", "studio_not_found", "", null, undefined, 1, "OK"]) expect(restoreOutcomeFromRpc(odd, null)).toBe("failed");
    expect(restoreOutcomeFromRpc("ok", { message: "boom" })).toBe("failed"); // an error always wins over data
    expect(restoreOutcomeFromRpc(null, { message: 'raise: practitioner_is_active_receptionist (23514)' })).toBe("receptionist_conflict");
  });
  it("every outcome has a sentence, none leaks a code or database text, and only 'restored' is a success", () => {
    for (const o of RESTORE_OUTCOMES) {
      const c = restoreOutcomeCopy(o);
      expect(c.text.length).toBeGreaterThan(20);
      expect(c.text).not.toMatch(/23514|practitioner_is_active|cannot_modify|invalid_practitioner|\bRPC\b|SQL/i);
      expect(c.tone).toBe(o === "restored" ? "ok" : "refused");
    }
  });
  it("parses only known codes and builds an encoded href", () => {
    for (const o of RESTORE_OUTCOMES) expect(parseRestoreOutcome(o)).toBe(o);
    expect(parseRestoreOutcome("<script>")).toBeNull();
    expect(parseRestoreOutcome(undefined)).toBeNull();
    expect(restoreHref("restored")).toBe("/settings/team?restore=restored");
  });
});

describe("restorePractitionerAction", () => {
  const rpc = vi.fn();
  const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); });
  let role = "owner";
  beforeEach(() => {
    vi.resetModules();
    rpc.mockReset();
    redirect.mockClear();
    role = "owner";
    vi.doMock("next/navigation", () => ({ redirect }));
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
    vi.doMock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc }) }));
    vi.doMock("@/lib/email/client", () => ({ resend: {}, FROM_ADDRESS: "x" }));
    vi.doMock("@/lib/supabase/queries", () => ({
      getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "owner-1", role, display_name: "O", email: "o@example.test" }, studio: { id: "studio-1", name: "S" } }),
    }));
  });
  afterEach(() => { vi.doUnmock("@/lib/supabase/admin-server"); });
  const form = (id: string | null) => { const f = new FormData(); if (id !== null) f.set("id", id); return f; };
  const run = async (f: FormData) => { const { restorePractitionerAction } = await import("../../../app/(app)/settings/team/actions"); return restorePractitionerAction(f); };

  it("calls the SAME locked command removal uses, with p_active true and the server-resolved studio and actor", async () => {
    rpc.mockResolvedValue({ data: "ok", error: null });
    await expect(run(form(UUID))).rejects.toThrow("REDIRECT:/settings/team?restore=restored");
    expect(rpc).toHaveBeenCalledWith("set_practitioner_active_locked", { p_studio_id: "studio-1", p_actor_practitioner_id: "owner-1", p_target_practitioner_id: UUID, p_active: true });
  });
  it("a refusal is a redirect with a code, never a thrown error", async () => {
    rpc.mockResolvedValue({ data: "cannot_modify_owner", error: null });
    await expect(run(form(UUID))).rejects.toThrow("REDIRECT:/settings/team?restore=owner");
    rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "practitioner_is_active_receptionist" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(run(form(UUID))).rejects.toThrow("REDIRECT:/settings/team?restore=receptionist_conflict");
    log.mockRestore();
  });
  it("a non-owner is stopped before any command is called", async () => {
    role = "practitioner";
    await expect(run(form(UUID))).rejects.toThrow("Only studio owners can manage the team.");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a missing or malformed id is answered as not found before any command", async () => {
    for (const bad of [null, "", "not-a-uuid", "../x"]) {
      await expect(run(form(bad))).rejects.toThrow("REDIRECT:/settings/team?restore=not_found");
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("source guards", () => {
  it("restore uses the locked command, never a raw active write, and the page reads removed rows with the user's client", () => {
    expect(ACTIONS).toMatch(/p_active: true/);
    expect(ACTIONS).not.toMatch(/\.update\(\s*\{\s*active/);
    expect(PAGE).toMatch(/\.eq\("active", false\)/);
    expect(PAGE).toMatch(/filter\(\(p\) => p\.role !== "owner"\)/);
  });
});

describe("the real Team page", () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock("@/lib/supabase/queries"); vi.doUnmock("@/lib/supabase/server"); });
  const load = async (role: string, removed: unknown[], restore?: string) => {
    vi.resetModules();
    vi.doMock("@/lib/supabase/queries", () => ({
      requirePractitionerWithStudio: async () => ({ practitioner: { id: "p-1", role }, studio: { id: "s" } }),
      getPractitionersForStudio: async () => [{ id: "p-1", display_name: "Owner", email: "o@example.test", role: "owner", active: true }],
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: async () => ({
        from: () => ({ select: () => ({ eq: () => ({ eq: (c: string, v: unknown) => ({ order: async () => ({ data: c === "active" && v === false ? removed : [], error: null }) }) }) }) }),
      }),
    }));
    vi.doMock("@/lib/appointments/review-link", () => ({ shouldShowReviewLink: async () => false }));
    vi.doMock("../../../app/(app)/settings/team/actions", () => ({ removePractitionerAction: vi.fn(), restorePractitionerAction: vi.fn(), revokeInvitationAction: vi.fn() }));
    const { default: Page } = await import("../../../app/(app)/settings/team/page");
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ restore }) }));
  };
  const gone = [{ id: UUID, display_name: "Removed Person", email: "gone@example.test", role: "practitioner", active: false }];

  it("an owner sees the removed person with a Restore button", async () => {
    const html = await load("owner", gone);
    expect(html).toContain('data-testid="team-removed"');
    expect(html).toContain("Removed Person");
    expect(html).toContain("Restore");
  });
  it("an owner row is never listed as removable-or-restorable, even if one is somehow inactive", async () => {
    const html = await load("owner", [{ ...gone[0], id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", display_name: "Inactive Owner", role: "owner" }]);
    expect(html).not.toContain("Inactive Owner");
  });
  it("no removed people and no notice: the section is absent", async () => {
    expect(await load("owner", [])).not.toContain('data-testid="team-removed"');
  });
  it("a refusal shows as a sentence, with no code", async () => {
    const html = await load("owner", gone, "receptionist_conflict");
    expect(html).toContain('data-testid="team-restore-notice"');
    expect(html).toMatch(/active receptionist/);
    expect(html).not.toMatch(/23514|practitioner_is_active/);
  });
  it("an unknown restore code shows nothing", async () => {
    expect(await load("owner", [], "<script>")).not.toContain("team-restore-notice");
  });
  it("a practitioner and a receptionist see only the owner-only notice, no removed list", async () => {
    for (const role of ["practitioner", "receptionist"]) {
      const html = await load(role, gone);
      expect(html).toContain("Only studio owners can manage the team.");
      expect(html).not.toContain("Removed Person");
      expect(html).not.toContain("Restore");
    }
  });
});
