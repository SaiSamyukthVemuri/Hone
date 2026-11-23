import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The receptionist studio chooser: only a user's ACTIVE receptionist studios are listed, the selected-studio cookie is set
// only after the rows are read again and the requested studio is one of them, and a single studio never sees it.
// Synthetic fixtures; the chooser shows no client data and no studio name (a receptionist cannot read one).

class Redirected extends Error {}
type Row = { id: string; studio_id: string; display_name: string; user_id: string; active: boolean };
const state: { user: { id: string } | null; rows: Row[]; selected: string | null; set: string[] } = { user: { id: "u1" }, rows: [], selected: null, set: [] };

vi.mock("server-only", () => ({}));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Redirected("404"); },
  redirect: (to: string) => { throw new Redirected(to); },
}));
vi.mock("@/lib/supabase/selected-studio", () => ({
  readSelectedStudioId: async () => state.selected,
  setSelectedStudioId: async (id: string) => { state.set.push(id); state.selected = id; },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => {
      let rows = state.rows;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => { rows = rows.filter((r) => (r as Record<string, unknown>)[c] === v); return q; };
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
      return q;
    },
  }),
}));

import { requireReceptionistChoice, requireReceptionistWithStudio } from "@/lib/desk/guard";
import { chooseDeskStudioAction } from "@/lib/desk/choose-actions";
import DeskChoosePage from "@/app/(desk-choose)/desk/choose/page";

const row = (n: number, active = true, user = "u1"): Row => ({ id: `r${n}`, studio_id: `s${n}`, display_name: `Desk ${n}`, user_id: user, active });
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const form = (id: string | null) => { const f = new FormData(); if (id !== null) f.set("studio_id", id); return f; };

beforeEach(() => {
  state.user = { id: "u1" };
  state.rows = [];
  state.selected = null;
  state.set = [];
  vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
});

describe("two studios: choose, then the schedule shows", () => {
  it("the guard sends a two-studio receptionist with no selection to the chooser, which lists both and nothing else", async () => {
    state.rows = [row(1), row(2)];
    expect(await outcome(requireReceptionistWithStudio())).toBe("/desk/choose");
    const html = renderToStaticMarkup(await DeskChoosePage());
    expect(html).toContain("Studio 1");
    expect(html).toContain("Studio 2");
    expect(html.match(/name="studio_id"/g)).toHaveLength(2);
    expect(/href=/.test(html)).toBe(false);
  });

  it("choosing a studio sets the cookie to it and goes to the desk, and the guard then resolves that studio", async () => {
    state.rows = [row(1), row(2)];
    expect(await outcome(chooseDeskStudioAction(form("s2")))).toBe("/desk");
    expect(state.set).toEqual(["s2"]);
    await expect(requireReceptionistWithStudio()).resolves.toMatchObject({ studioId: "s2", receptionistId: "r2" });
  });
});

describe("refusals", () => {
  it("a forged studio id is refused: no cookie is set, back to the chooser", async () => {
    state.rows = [row(1), row(2)];
    expect(await outcome(chooseDeskStudioAction(form("s-forged")))).toBe("/desk/choose");
    expect(await outcome(chooseDeskStudioAction(form("")))).toBe("/desk/choose");
    expect(await outcome(chooseDeskStudioAction(form(null)))).toBe("/desk/choose");
    expect(state.set).toEqual([]);
  });

  it("an inactive row is not listed and cannot be chosen; another user's row is invisible", async () => {
    state.rows = [row(1), row(2), row(3, false), row(4, true, "someone-else")];
    const html = renderToStaticMarkup(await DeskChoosePage());
    expect(html.match(/name="studio_id"/g)).toHaveLength(2);
    expect(html).not.toContain('value="s3"');
    expect(html).not.toContain('value="s4"');
    expect(await outcome(chooseDeskStudioAction(form("s3")))).toBe("/desk/choose");
    expect(await outcome(chooseDeskStudioAction(form("s4")))).toBe("/desk/choose");
    expect(state.set).toEqual([]);
  });

  it("a removed row after the page was shown is refused when the form is submitted", async () => {
    state.rows = [row(1), row(2)];
    await DeskChoosePage();
    state.rows = [row(1), row(2, false)];
    // One active studio is left: the chooser is skipped (and nothing is set).
    expect(await outcome(chooseDeskStudioAction(form("s2")))).toBe("/desk");
    expect(state.set).toEqual([]);
  });

  it("flag off: 404 for the page and the action, and nothing is set", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "");
    state.rows = [row(1), row(2)];
    expect(await outcome(requireReceptionistChoice())).toBe("404");
    expect(await outcome(chooseDeskStudioAction(form("s1")))).toBe("404");
    expect(state.set).toEqual([]);
  });

  it("anonymous goes to login; a user with no active receptionist row goes to /no-access", async () => {
    state.user = null;
    expect(await outcome(requireReceptionistChoice())).toBe("/login");
    expect(await outcome(chooseDeskStudioAction(form("s1")))).toBe("/login");
    state.user = { id: "u1" };
    state.rows = [row(1, false)];
    expect(await outcome(requireReceptionistChoice())).toBe("/no-access");
    expect(state.set).toEqual([]);
  });
});

describe("a single studio skips the chooser", () => {
  it("one active studio goes straight to the desk, and the desk guard resolves it with no cookie", async () => {
    state.rows = [row(1)];
    expect(await outcome(requireReceptionistChoice())).toBe("/desk");
    await expect(requireReceptionistWithStudio()).resolves.toMatchObject({ studioId: "s1" });
  });
});
