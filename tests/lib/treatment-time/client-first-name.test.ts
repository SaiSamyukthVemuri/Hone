import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildTreatmentTimeLine } from "@/lib/treatment-time/format";
import { loadTreatmentTimeNameFields, treatmentTimeFirstName } from "@/lib/treatment-time/client-first-name";

// HON-58: the reminder email's treatment-time sentence names the client by the name they go by. Synthetic names only; nothing is sent.

type Result = { data: { name?: string; preferred_name?: string | null } | null; error: { code?: string; message?: string } | null };
function fakeAdmin(results: Result[]) {
  const calls: { select: string; eq: [string, string][] }[] = [];
  let i = 0;
  const admin = {
    from: (table: string) => {
      expect(table).toBe("clients");
      const call = { select: "", eq: [] as [string, string][] };
      calls.push(call);
      const q = {
        select: (c: string) => ((call.select = c), q),
        eq: (c: string, v: string) => (call.eq.push([c, v]), q),
        maybeSingle: async () => results[Math.min(i++, results.length - 1)],
      };
      return q;
    },
  };
  return { admin, calls };
}
const lineFor = async (admin: unknown, stored: string) =>
  buildTreatmentTimeLine({
    enabled: true,
    clientFirstName: treatmentTimeFirstName(await loadTreatmentTimeNameFields(admin, "studio-1", "client-1", stored)),
    context: { sessionCount: 0, totalMinutes: 0 },
  });

describe("the rendered treatment-time sentence", () => {
  it("carries the preferred name, never the stored first word, when a preferred name exists", async () => {
    const { admin } = fakeAdmin([{ data: { preferred_name: "Fern" }, error: null }]);
    const line = await lineFor(admin, "Quillon Sentinel");
    expect(line).toBe("This will be Fern's first electrolysis session.");
    expect(line).not.toContain("Quillon");
  });
  it("uses the first word of a multi-word preferred name", async () => {
    const { admin } = fakeAdmin([{ data: { preferred_name: "Fern Rowan" }, error: null }]);
    expect(await lineFor(admin, "Quillon Sentinel")).toBe("This will be Fern's first electrolysis session.");
  });
  it("keeps today's fallback when no preferred name is set (blank, null or absent)", async () => {
    for (const preferred of [null, "", "   "]) {
      const { admin } = fakeAdmin([{ data: { preferred_name: preferred }, error: null }]);
      expect(await lineFor(admin, "Quillon Sentinel")).toBe("This will be Quillon's first electrolysis session.");
    }
    expect(await lineFor(fakeAdmin([{ data: null, error: null }]).admin, "Quillon Sentinel")).toBe("This will be Quillon's first electrolysis session.");
  });
  it("is unchanged before the preferred_name column exists: retries without it, then the stored name", async () => {
    const { admin, calls } = fakeAdmin([
      { data: null, error: { code: "42703", message: 'column clients.preferred_name does not exist' } },
      { data: { name: "Quillon Sentinel" }, error: null },
    ]);
    expect(await lineFor(admin, "Quillon Sentinel")).toBe("This will be Quillon's first electrolysis session.");
    expect(calls[0].select).toBe("preferred_name, name");
    expect(calls[1].select).toBe("name");
  });
  it("never fails the send: a read error or a throw leaves the stored name", async () => {
    expect(await lineFor(fakeAdmin([{ data: null, error: { code: "XX000", message: "boom" } }]).admin, "Quillon Sentinel")).toBe(
      "This will be Quillon's first electrolysis session.",
    );
    const thrower = { from: () => { throw new Error("down"); } };
    expect(await lineFor(thrower, "Quillon Sentinel")).toBe("This will be Quillon's first electrolysis session.");
  });
  it("reads only this studio's client row", async () => {
    const { admin, calls } = fakeAdmin([{ data: { preferred_name: "Fern" }, error: null }]);
    await lineFor(admin, "Quillon Sentinel");
    expect(calls[0].eq).toEqual([["id", "client-1"], ["studio_id", "studio-1"]]);
  });
  it("the later sessions' sentence names nobody, so it is unchanged", () => {
    expect(buildTreatmentTimeLine({ enabled: true, clientFirstName: "Fern", context: { sessionCount: 2, totalMinutes: 90 } })).toBe(
      "Treatment time so far: 1h 30m · This will be session 3.",
    );
  });
});

describe("both reminder paths name the client through the helper", () => {
  const code = (p: string) => readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  it("the reminders cron route", () => {
    const src = code("app/api/cron/appointment-reminders/route.ts");
    expect(src).toContain("treatmentTimeFirstName(");
    expect(src).toContain("loadTreatmentTimeNameFields(");
    expect(src, "no first-word-of-the-stored-name").not.toMatch(/client\.name\.split/);
  });
  it("the trusted-render operation path", () => {
    const src = code("lib/email/send-appointment.ts");
    expect(src).toContain("treatmentTimeFirstName(nameFields ?? { name: p.client.name })");
    expect(src).toContain("loadTreatmentTimeNameFields(admin, studioId, render.client.id, render.client.name)");
    expect(src).toContain("addressVisibility, nameFields)");
    expect(src, "no first-word-of-the-stored-name").not.toMatch(/client\.name\.split/);
  });
});
