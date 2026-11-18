import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// HON-58: the calendar loader computes the DISPLAY name on the server and hands on ONE string.
// Two sentinels make the proof exact: the STORED name and the PREFERRED name are different, distinctive strings, so a surface
// that leaks the wrong one is visible. Synthetic names only.

const STORED = "Stored-Sentinel-Quill";
const PREFERRED = "Preferred-Sentinel-Fern";

const fake = vi.hoisted(() => ({
  clientRow: { id: "C1", name: "", preferred_name: null as string | null },
  missingPreferred: false,
  selects: [] as string[],
}));

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { throw new Error("privileged client must not be used"); } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      let columns = "";
      let after: string | null = null;
      const run = () => {
        fake.selects.push(columns);
        if (fake.missingPreferred && columns.includes("preferred_name")) {
          return { data: null, error: { code: "42703", message: 'column clients_1.preferred_name does not exist' } };
        }
        if (after !== null) return { data: [], error: null };
        const client = fake.missingPreferred
          ? { id: fake.clientRow.id, name: fake.clientRow.name }
          : { id: fake.clientRow.id, name: fake.clientRow.name, preferred_name: fake.clientRow.preferred_name };
        return {
          data: [{
            id: "A1", studio_id: "S", starts_at: "2026-10-20T10:00:00Z", ends_at: "2026-10-20T11:00:00Z", status: "confirmed",
            practitioner: { id: "P", color: "blue", display_name: "Synthetic Practitioner" },
            client,
            service: { id: "SV", name: "Synthetic service", modality: null, calendar_color: null },
          }],
          error: null,
        };
      };
      const query: Record<string, unknown> = {
        select: (value: string) => { columns = value; return query; },
        eq: () => query, gte: () => query, lt: () => query,
        gt: (_k: string, v: string) => { after = v; return query; },
        order: () => query, range: () => query,
        then: (resolve: (v: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve),
      };
      return query;
    },
  }),
}));

import { getAppointmentsForRange } from "@/lib/booking/queries";
import { OverlapAppointmentSummary } from "@/app/(app)/calendar/AppointmentOverlapChooser";

const START = "2026-10-20T00:00:00Z";
const END = "2026-10-21T00:00:00Z";
beforeEach(() => {
  fake.clientRow = { id: "C1", name: STORED, preferred_name: PREFERRED };
  fake.missingPreferred = false;
  fake.selects = [];
});

describe("the calendar loader hands on one display string", () => {
  it("a preferred name is the display name, and the stored name does not leave the loader", async () => {
    const rows = await getAppointmentsForRange("S", START, END);
    expect(rows[0].client).toEqual({ id: "C1", name: PREFERRED });
    const wire = JSON.stringify(rows);
    expect(wire).toContain(PREFERRED);
    expect(wire, "the stored name must be absent when a preferred name is set").not.toContain(STORED);
    expect(Object.keys(rows[0].client ?? {}).sort(), "only id and the display name, never both name fields").toEqual(["id", "name"]);
  });
  it("a blank or whitespace preferred name falls back to the stored name", async () => {
    for (const blank of [null, "", "   "]) {
      fake.clientRow = { id: "C1", name: STORED, preferred_name: blank };
      expect((await getAppointmentsForRange("S", START, END))[0].client).toEqual({ id: "C1", name: STORED });
    }
  });
  it("a database without the preferred_name column behaves as before: stored name, one retry, no other error swallowed", async () => {
    fake.missingPreferred = true;
    const rows = await getAppointmentsForRange("S", START, END);
    expect(rows[0].client).toEqual({ id: "C1", name: STORED });
    expect(fake.selects[0]).toContain("preferred_name");
    expect(fake.selects[1]).not.toContain("preferred_name");
  });
  it("the client embed names its columns: no star, no legal identity (runtime capture)", async () => {
    await getAppointmentsForRange("S", START, END);
    for (const select of fake.selects) {
      const embed = /client:clients\(([^)]*)\)/.exec(select)?.[1] ?? "";
      expect(embed).not.toBe("");
      expect(embed).not.toContain("*");
      expect(select).not.toMatch(/legal/i);
    }
  });
});

describe("the calendar card summary shows the display name only", () => {
  it("renders the preferred name and never the stored name", async () => {
    const [a] = await getAppointmentsForRange("S", START, END);
    const html = renderToStaticMarkup(createElement(OverlapAppointmentSummary, { appointment: a, tz: "America/Toronto", timeFormat: "12h" }));
    expect(html).toContain(PREFERRED);
    expect(html).not.toContain(STORED);
  });
  it("falls back to the stored name when none is preferred", async () => {
    fake.clientRow = { id: "C1", name: STORED, preferred_name: null };
    const [a] = await getAppointmentsForRange("S", START, END);
    const html = renderToStaticMarkup(createElement(OverlapAppointmentSummary, { appointment: a, tz: "America/Toronto", timeFormat: "12h" }));
    expect(html).toContain(STORED);
    expect(html).not.toContain(PREFERRED);
  });
});
