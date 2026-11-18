import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildTreatmentTimeLine, treatmentTimeFirstName } from "@/lib/treatment-time/format";
import { loadTreatmentTimeNameFields } from "@/lib/treatment-time/client-first-name";

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
    client: await loadTreatmentTimeNameFields(admin, "studio-1", "client-1", stored),
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
    expect(buildTreatmentTimeLine({ enabled: true, client: { name: "Fern" }, context: { sessionCount: 2, totalMinutes: 90 } })).toBe(
      "Treatment time so far: 1h 30m · This will be session 3.",
    );
  });
});

describe("the helper itself", () => {
  it("takes identity fields, so a stored first word cannot be passed in", () => {
    expect(treatmentTimeFirstName({ name: "Quillon Sentinel", preferred_name: "Fern" })).toBe("Fern");
    expect(treatmentTimeFirstName({ name: "Quillon Sentinel", preferred_name: null })).toBe("Quillon");
    expect(treatmentTimeFirstName({ name: "Quillon Sentinel", legal_given_name: "Legal", legal_family_name: "Name" })).toBe("Quillon");
    expect(treatmentTimeFirstName({ name: "Mononym" })).toBe("Mononym");
    const line = buildTreatmentTimeLine({ enabled: true, client: { name: "Quillon Sentinel", preferred_name: "Fern" }, context: { sessionCount: 0, totalMinutes: 0 } });
    expect(line).toBe("This will be Fern's first electrolysis session.");
    expect(buildTreatmentTimeLine({ enabled: false, client: { name: "Q" }, context: { sessionCount: 0, totalMinutes: 0 } })).toBeNull();
  });
});

describe("every path that builds the sentence names the client through the loader", () => {
  const code = (p: string) => readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const PATHS: [string, string, string][] = [
    ["the reminders cron route", "app/api/cron/appointment-reminders/route.ts", "client: await loadTreatmentTimeNameFields(\n            admin,\n            appt.studio.id,\n            appt.client_id,\n            appt.client.name,"],
    ["the trusted-render operation path", "lib/email/send-appointment.ts", "client: nameFields ?? { name: p.client.name }"],
    ["the public booking confirmation", "app/book/[slug]/actions.ts", "client: await loadTreatmentTimeNameFields(admin, studio.id, clientId, clientName)"],
    ["the portal rebook", "app/portal/rebook-actions.ts", "client: await loadTreatmentTimeNameFields(admin, studio.id, clientId, clientName)"],
    ["the reschedule confirmation", "app/reschedule/[token]/actions.ts", "client: await loadTreatmentTimeNameFields(admin, asserted.original.studio_id, asserted.original.client_id, clientRow.name)"],
    ["the calendar confirm/move", "app/(app)/calendar/actions.ts", "client: await loadTreatmentTimeNameFields(createAdminClient(), p.studio.id, p.appointment.client_id, p.clientName)"],
  ];
  for (const [label, file, needle] of PATHS) {
    it(`${label}: passes the loaded identity, studio-scoped, never a first word of the stored name`, () => {
      const src = code(file);
      expect(src).toContain(needle);
      expect(src).not.toMatch(/clientFirstName/);
      expect(src).not.toMatch(/\.split\(\/\\s\+\/\)\[0\]/);
    });
  }
  it("no file in app/ or lib/ calls the sentence builder without being in the list above (the name-string option no longer exists; the type enforces it)", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const callers = execSync(`grep -rlE "buildTreatmentTimeLine\\(" app lib --include=*.ts --include=*.tsx`, { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => f !== "lib/treatment-time/format.ts").sort();
    expect(callers).toEqual(PATHS.map(([, f]) => f).sort());
  });
});
