import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Team page's front-desk section (Sam, 2 Nov): Remove and Revoke work with the desk flag OFF; the invite
// form exists only while it is ON; a failed read is loud. Synthetic values only.

let desk: { data: unknown[] | null; error: unknown };
let invites: { data: unknown[] | null; error: unknown };
const filters: Array<[string, string, unknown]> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => (filters.push([table, c, v]), q);
      q.order = () => Promise.resolve(table === "studio_receptionists" ? desk : invites);
      return q;
    },
  }),
}));
vi.mock("@/app/(app)/settings/team/actions", () => ({ revokeInvitationAction: async () => undefined }));
vi.mock("@/app/(app)/settings/team/ReceptionistControls", () => ({
  ReceptionistInviteForm: () => createElement("div", { "data-testid": "invite-form" }, "INVITE-FORM"),
  RemoveReceptionistButton: ({ name }: { name: string }) => createElement("button", null, `Remove ${name}`),
}));

import { ReceptionistSection } from "@/app/(app)/settings/team/ReceptionistSection";

const render = async () => {
  const el = await ReceptionistSection({ studioId: "studio-1" });
  return el === null ? null : renderToStaticMarkup(el);
};

beforeEach(() => {
  desk = { data: [], error: null };
  invites = { data: [], error: null };
  filters.length = 0;
  vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("ReceptionistSection", () => {
  it("flag off and nothing to show: renders nothing", async () => {
    expect(await render()).toBeNull();
  });

  it("flag OFF: an active receptionist still has Remove, a pending receptionist invitation still has Revoke, and there is no invite form", async () => {
    desk = { data: [{ id: "r1", display_name: "Synthetic Desk", email: "desk@example.test" }], error: null };
    invites = { data: [{ id: "i1", email: "waiting@example.test", display_name: null }], error: null };
    const html = (await render())!;
    expect(html).toContain("Remove Synthetic Desk");
    expect(html).toContain("Revoke");
    expect(html).toContain("waiting@example.test");
    expect(html).not.toContain("INVITE-FORM");
  });

  it("flag ON: the invite form appears, even with nobody yet", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    const html = (await render())!;
    expect(html).toContain("INVITE-FORM");
    expect(html).toContain("No receptionist has access.");
  });

  it("reads only this studio's ACTIVE receptionists and PENDING receptionist invitations", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    await render();
    expect(filters).toEqual(
      expect.arrayContaining([
        ["studio_receptionists", "studio_id", "studio-1"],
        ["studio_receptionists", "active", true],
        ["pending_invitations", "studio_id", "studio-1"],
        ["pending_invitations", "status", "pending"],
        ["pending_invitations", "role", "receptionist"],
      ]),
    );
  });

  it("a failed read is loud, never an empty list", async () => {
    desk = { data: null, error: { code: "XX000", message: "secret" } };
    await expect(render()).rejects.toThrow("Failed to load receptionists");
    desk = { data: [], error: null };
    invites = { data: null, error: { code: "XX000", message: "secret" } };
    await expect(render()).rejects.toThrow("Failed to load invitations");
  });
});

describe("page wiring", () => {
  it("the Team page renders the section after its owner check and keeps receptionist invitations out of the generic list", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/settings/team/page.tsx", "utf8");
    expect(src.indexOf('practitioner.role !== "owner"')).toBeLessThan(src.indexOf("<ReceptionistSection"));
    expect(src).toContain('<ReceptionistSection studioId={studio.id} />');
    expect(src).toContain('!== "receptionist"');
  });
});
