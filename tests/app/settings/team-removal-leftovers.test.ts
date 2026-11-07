import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// RBAC G9 (Team matrix C7, C4): what removing a team member leaves behind, and the self-removal message.
// Access itself is cut by `practitioners.active`; these cases cover the grants that would outlive it:
//   * a PENDING invitation for the same email (link_invited_membership honours it and can reactivate the person);
//   * the Google Calendar connection (the sync reads the connection, never `practitioners.active`).
// Synthetic values only.

const SESSION = vi.hoisted(() => ({
  current: {
    practitioner: { id: "owner-1", role: "owner", display_name: "Owner", email: "owner@example.test" },
    studio: { id: "studio-1", name: "Synthetic Studio" },
  } as { practitioner: { id: string; role: string; display_name: string; email: string }; studio: { id: string; name: string } },
}));
const DB = vi.hoisted(() => ({
  rpc: { data: "ok" as unknown, error: null as unknown },
  targetEmail: "Removed.Person@Example.test" as string | null,
  targetReadError: null as unknown,
  inviteUpdateError: null as unknown,
  invitesTouched: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  order: [] as string[],
}));
const GOOGLE = vi.hoisted(() => ({
  cipher: "cipher-1" as string | null,
  decryptOk: true,
  revoke: vi.fn(async (..._a: unknown[]): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
  cipherThrows: false,
  disconnect: vi.fn(async () => undefined),
  disconnectThrows: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Next's redirect() throws a control-flow error; capture the URL like the framework would.
class RedirectSignal extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("@/lib/email/client", () => ({ resend: null, FROM_ADDRESS: "Hone <hello@hone.care>" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => SESSION.current),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      DB.order.push(`rpc:${fn}`);
      DB.rpcCalls.push({ fn, args });
      return DB.rpc;
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.update = (p: Record<string, unknown>) => {
        patch = p;
        return chain;
      };
      chain.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      };
      chain.maybeSingle = async () => {
        DB.order.push(`read:${table}`);
        return DB.targetReadError
          ? { data: null, error: DB.targetReadError }
          : { data: DB.targetEmail === null ? null : { email: DB.targetEmail }, error: null };
      };
      // `update(...).eq().eq().eq()` is awaited directly.
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => {
        if (table === "pending_invitations" && patch) {
          DB.order.push("update:pending_invitations");
          DB.invitesTouched.push({ patch, filters: { ...filters } });
          resolve({ error: DB.inviteUpdateError });
        } else resolve({ error: null });
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/google-calendar/connection", () => ({
  getRefreshTokenCiphertext: vi.fn(async () => {
    if (GOOGLE.cipherThrows) throw new Error("calendar_connection_store_error:read_connection");
    return GOOGLE.cipher;
  }),
  disconnectConnection: vi.fn(async (...a: unknown[]) => {
    GOOGLE.disconnect(...(a as []));
    DB.order.push("google:disconnect");
    if (GOOGLE.disconnectThrows) throw new Error("boom");
  }),
}));
vi.mock("@/lib/google-calendar/token-crypto", () => ({
  decryptGoogleSecret: vi.fn(() => (GOOGLE.decryptOk ? { ok: true, secret: "refresh-secret" } : { ok: false })),
}));
vi.mock("@/lib/google-calendar/oauth", () => ({
  revokeToken: vi.fn(async (...a: unknown[]) => {
    DB.order.push("google:revoke");
    return GOOGLE.revoke(...(a as []));
  }),
}));

import { removePractitionerAction } from "@/app/(app)/settings/team/actions";

// Runs the action and reports how it ended: a redirect URL (leftovers), a thrown message (a refusal before anything was removed), or neither.
async function outcome(id: string): Promise<{ redirectedTo?: string; error?: string }> {
  try {
    await removePractitionerAction(form(id));
    return {};
  } catch (e) {
    if (e instanceof RedirectSignal) return { redirectedTo: e.url };
    return { error: (e as Error).message };
  }
}

const form = (id: string) => {
  const fd = new FormData();
  fd.set("id", id);
  return fd;
};

beforeEach(() => {
  SESSION.current = {
    practitioner: { id: "owner-1", role: "owner", display_name: "Owner", email: "owner@example.test" },
    studio: { id: "studio-1", name: "Synthetic Studio" },
  };
  DB.rpc = { data: "ok", error: null };
  DB.targetEmail = "Removed.Person@Example.test";
  DB.targetReadError = null;
  DB.inviteUpdateError = null;
  DB.invitesTouched = [];
  DB.rpcCalls = [];
  DB.order = [];
  GOOGLE.cipher = "cipher-1";
  GOOGLE.decryptOk = true;
  GOOGLE.disconnectThrows = false;
  GOOGLE.cipherThrows = false;
  GOOGLE.revoke.mockReset();
  GOOGLE.revoke.mockResolvedValue({ ok: true });
  GOOGLE.disconnect.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("removing a member ends their outstanding invitations and Google Calendar connection", () => {
  it("deactivates first, then revokes this studio's PENDING invitations for the member's email (lower-cased)", async () => {
    GOOGLE.cipher = null; // no stored Google credential, so no Google notice and the action simply returns
    await expect(removePractitionerAction(form("member-1"))).resolves.toBeUndefined();
    expect(DB.rpcCalls).toEqual([
      { fn: "set_practitioner_active_locked", args: { p_studio_id: "studio-1", p_actor_practitioner_id: "owner-1", p_target_practitioner_id: "member-1", p_active: false } },
    ]);
    expect(DB.invitesTouched).toEqual([
      { patch: { status: "revoked" }, filters: { studio_id: "studio-1", email: "removed.person@example.test", status: "pending" } },
    ]);
    expect(DB.order.indexOf("rpc:set_practitioner_active_locked")).toBeLessThan(DB.order.indexOf("update:pending_invitations"));
  });

  it("NEVER calls Google: removal deletes this studio's credential and connection only, and says so (the grant at Google is the person's to remove)", async () => {
    const r = await outcome("member-1");
    expect(GOOGLE.revoke).not.toHaveBeenCalled();
    expect(DB.order).not.toContain("google:revoke");
    expect(GOOGLE.disconnect).toHaveBeenCalledTimes(1);
    expect(GOOGLE.disconnect).toHaveBeenCalledWith("studio-1", "member-1");
    expect(r.redirectedTo).toBe("/settings/team?removed=partial&left=google_access");
  });

  it("a member with no Google connection is still disconnected idempotently and nothing is revoked at Google", async () => {
    GOOGLE.cipher = null;
    await removePractitionerAction(form("member-1"));
    expect(GOOGLE.revoke).not.toHaveBeenCalled();
    expect(GOOGLE.disconnect).toHaveBeenCalledWith("studio-1", "member-1");
  });

  it("NOTHING is cleared when the removal itself is refused (owner cannot be removed)", async () => {
    DB.rpc = { data: "cannot_modify_owner", error: null };
    await expect(removePractitionerAction(form("owner-2"))).rejects.toThrow("The studio owner cannot be removed.");
    expect(DB.invitesTouched).toEqual([]);
    expect(GOOGLE.disconnect).not.toHaveBeenCalled();
  });

  it("a failed invitation clear is REPORTED by a fixed redirect code (never a throw), the Google clear still runs", async () => {
    DB.inviteUpdateError = { code: "XX000", message: "db text that must not surface" };
    const r = await outcome("member-1");
    expect(r).toEqual({ redirectedTo: "/settings/team?removed=partial&left=invitations,google_access" }); // the Google notice rides along: a stored credential was deleted
    expect(GOOGLE.disconnect).toHaveBeenCalledTimes(1);
  });

  it("a failed Google clear is REPORTED by a redirect code and the invitation clear still ran", async () => {
    GOOGLE.disconnectThrows = true;
    const r = await outcome("member-1");
    expect(r.redirectedTo).toBe("/settings/team?removed=partial&left=google_connection");
    expect(DB.invitesTouched).toHaveLength(1);
  });

  it("a decrypt or revoke failure cannot happen any more: the action neither decrypts nor revokes (source pin)", () => {
    const src = readFileSync(join(__dirname, "../../../app/(app)/settings/team/actions.ts"), "utf8");
    expect(src).not.toMatch(/revokeToken|decryptGoogleSecret/);
    expect(src).not.toContain("@/lib/google-calendar/oauth");
  });

  it("a failed read of the connection store is reported as google_connection and nothing is revoked or destroyed on a guess", async () => {
    GOOGLE.cipherThrows = true;
    const r = await outcome("member-1");
    expect(r.redirectedTo).toBe("/settings/team?removed=partial&left=google_connection");
    expect(GOOGLE.revoke).not.toHaveBeenCalled();
    expect(GOOGLE.disconnect).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("team_action_error:remove_disconnect_google");
  });

  it("several leftovers are all named, in order, in one redirect", async () => {
    DB.inviteUpdateError = { code: "XX000", message: "x" };
    const r = await outcome("member-1");
    expect(r.redirectedTo).toBe("/settings/team?removed=partial&left=invitations,google_access");
  });

  it("a refusal BEFORE removal still throws (nothing was removed, so there is nothing to report as partial)", async () => {
    DB.rpc = { data: "invalid_practitioner", error: null };
    expect(await outcome("member-1")).toEqual({ error: "Practitioner not found in this studio." });
  });

  it("a member with no email on file has nothing to revoke by email (no unscoped update)", async () => {
    DB.targetEmail = null;
    await outcome("member-1");
    expect(DB.invitesTouched).toEqual([]);
  });
});

describe("self-removal and non-owners (Team C4)", () => {
  it("an owner removing themselves gets the plain message and nothing is called", async () => {
    await expect(removePractitionerAction(form("owner-1"))).rejects.toThrow("You cannot remove yourself.");
    expect(DB.rpcCalls).toEqual([]);
    expect(GOOGLE.disconnect).not.toHaveBeenCalled();
  });

  it("a practitioner (non-owner) cannot remove anyone: the owner-only message, nothing is called", async () => {
    SESSION.current = { ...SESSION.current, practitioner: { ...SESSION.current.practitioner, id: "prac-1", role: "practitioner" } };
    await expect(removePractitionerAction(form("member-1"))).rejects.toThrow("Only studio owners can manage the team.");
    expect(DB.rpcCalls).toEqual([]);
    expect(GOOGLE.disconnect).not.toHaveBeenCalled();
  });
});
