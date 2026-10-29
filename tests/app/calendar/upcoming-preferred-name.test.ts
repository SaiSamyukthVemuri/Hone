import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// HON-58 names slice on the CURRENT schema: the upcoming list shows the
// preferred name where one exists, and on a database WITHOUT clients.preferred_name
// (before 0258) it retries once without the column and shows the stored name.
// Synthetic data only.

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  selects: [] as string[],
  hasColumn: true,
  rows: [] as unknown[],
}));

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ studio: { id: "studio-a", timezone: "America/Toronto" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const q: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown) => {
            const sel = h.selects[h.selects.length - 1] ?? "";
            if (!h.hasColumn && sel.includes("preferred_name")) {
              return Promise.resolve({ data: null, error: { code: "42703", message: "column clients.preferred_name does not exist" } }).then(res);
            }
            return Promise.resolve({ data: h.rows, error: null }).then(res);
          };
        }
        return (...args: unknown[]) => { if (prop === "select") h.selects.push(String(args[0])); return q; };
      },
    });
    return { from: () => q };
  },
}));

const row = (client: Record<string, unknown>) => ({
  id: "a1", starts_at: "2026-11-02T15:00:00.000Z", status: "confirmed",
  client, service: { id: "s1", name: "Consult" },
});

async function render() {
  const mod = await import("@/app/(app)/calendar/upcoming/page");
  return renderToStaticMarkup(await mod.default());
}

describe("upcoming list names", () => {
  beforeEach(() => { h.selects.length = 0; h.hasColumn = true; h.rows = []; });

  it("shows the preferred name when one is set", async () => {
    h.rows = [row({ id: "c1", name: "Legal Synthetic", preferred_name: "Sam", email: null, phone: null })];
    const html = await render();
    expect(html).toContain("Sam");
    expect(html).not.toContain("Legal Synthetic");
    expect(h.selects).toHaveLength(1);
    expect(h.selects[0]).toContain("preferred_name");
  });

  it("falls back to the stored name when the preferred name is blank", async () => {
    h.rows = [row({ id: "c1", name: "Legal Synthetic", preferred_name: "  ", email: null, phone: null })];
    expect(await render()).toContain("Legal Synthetic");
  });

  it("on a database without the column, retries once without it and shows the stored name", async () => {
    h.hasColumn = false;
    h.rows = [row({ id: "c1", name: "Legal Synthetic", email: null, phone: null })];
    const html = await render();
    expect(html).toContain("Legal Synthetic");
    expect(h.selects).toHaveLength(2); // first attempt hit the missing column: not vacuous
    expect(h.selects[0]).toContain("preferred_name");
    expect(h.selects[1]).not.toContain("preferred_name");
  });
});
