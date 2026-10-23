import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

// LEAD-ALERT-01 (Codex P2 4248920469): the one-lead page the alert links to.
// Admin only (a non-admin, or no session, is a 404 before anything is read);
// platform-lead data only (never a client, clinical record or the alert's
// frozen message); any lead, whatever its age.

const LEAD = "8f0c2b7e-5d1a-4a2b-9c3d-4e5f6a7b8c9d";
const state = vi.hoisted(() => ({
  user: null as { email: string } | null,
  reads: [] as Array<{ table: string; columns: string; eq: [string, string] }>,
  rows: {} as Record<string, unknown>,
}));

class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never) };
});
vi.mock("@/lib/admin", () => ({ isAdmin: (e: string | null | undefined) => e === "ops@hone.example" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (col: string, val: string) => ({
          maybeSingle: async () => {
            state.reads.push({ table, columns, eq: [col, val] });
            return { data: state.rows[table] ?? null, error: null };
          },
        }),
      }),
    }),
  }),
}));

import LeadDetailPage from "@/app/admin/leads/[kind]/[id]/page";

const open = (kind: string, id = LEAD) => LeadDetailPage({ params: Promise.resolve({ kind, id }) });

beforeEach(() => {
  state.user = null;
  state.reads = [];
  state.rows = {
    demo_requests: {
      id: LEAD, name: "Avery Lead", email: "avery@example.test", practice_name: "Clinic", location: "Toronto",
      practice_type: "electrolysis", practitioner_count: "1", current_tool: "Paper", notes: "Call after 5 <b>pm</b>",
      status: "new", created_at: "2026-01-01T00:00:00Z",
    },
    waitlist: { id: LEAD, email: "early@example.test", practice_name: null, created_at: "2026-01-01T00:00:00Z" },
    platform_lead_alerts: { status: "accepted", attempt_count: 1, last_error_code: null },
  };
});

describe("who may open it", () => {
  it("no session, or a signed-in NON-admin: 404, and nothing is read", async () => {
    for (const user of [null, { email: "practitioner@studio.example" }]) {
      state.user = user;
      await expect(open("demo-request")).rejects.toBeInstanceOf(NotFound);
    }
    expect(state.reads).toEqual([]);
  });

  it("an unknown kind or a malformed id is the same 404, before any read", async () => {
    state.user = { email: "ops@hone.example" };
    for (const [kind, id] of [["clients", LEAD], ["demo_request", LEAD], ["demo-request", "1 or 1=1"]]) {
      await expect(open(kind, id)).rejects.toBeInstanceOf(NotFound);
    }
    expect(state.reads).toEqual([]);
  });

  it("an admin and a lead that does not exist: 404", async () => {
    state.user = { email: "ops@hone.example" };
    state.rows.demo_requests = null;
    await expect(open("demo-request")).rejects.toBeInstanceOf(NotFound);
  });
});

describe("what it shows", () => {
  it("a demo request, by id (whatever its age), with its notes escaped and its alert state", async () => {
    state.user = { email: "ops@hone.example" };
    const html = renderToStaticMarkup(await open("demo-request"));
    expect(state.reads.map((r) => [r.table, r.eq])).toEqual([
      ["demo_requests", ["id", LEAD]],
      ["platform_lead_alerts", ["demo_request_id", LEAD]],
    ]);
    expect(html).toContain("Avery Lead");
    expect(html).toContain("Call after 5 &lt;b&gt;pm&lt;/b&gt;");
    expect(html).toContain("Alert accepted");
  });

  it("an early-access signup", async () => {
    state.user = { email: "ops@hone.example" };
    const html = renderToStaticMarkup(await open("early-access"));
    expect(state.reads.map((r) => r.table)).toEqual(["waitlist", "platform_lead_alerts"]);
    expect(html).toContain("early@example.test");
    expect(html).not.toContain("Notes");
  });
});

describe("scope: platform leads only (source guard)", () => {
  // Code only: the header comment names the tables it must NOT read.
  const SRC = readFileSync("app/admin/leads/[kind]/[id]/page.tsx", "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("reads exactly the two lead tables and the alert status, nothing clinical", () => {
    const tables = [...SRC.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]).sort();
    expect([...new Set(tables)]).toEqual(["demo_requests", "platform_lead_alerts", "waitlist"]);
    expect(SRC).not.toMatch(/\.rpc\(/);
    expect(SRC).not.toMatch(/clients|appointments|treatment|chart|session_notes|consent/i);
  });

  it("never selects the alert's frozen message or provider detail", () => {
    const alertSelect = SRC.match(/from\("platform_lead_alerts"\)\s*\.select\("([^"]*)"\)/)![1];
    expect(alertSelect.split(",").map((c) => c.trim()).sort()).toEqual(["attempt_count", "last_error_code", "status"]);
    expect(SRC).not.toMatch(/frozen_|provider_message_id|last_provider_error|\*"/);
  });

  it("checks admin before it reads anything", () => {
    expect(SRC.indexOf("isAdmin(")).toBeGreaterThan(-1);
    expect(SRC.indexOf("isAdmin(")).toBeLessThan(SRC.indexOf("createAdminClient()"));
  });
});
