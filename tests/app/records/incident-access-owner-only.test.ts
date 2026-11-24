import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exposure incidents are clinical-incident records: only the studio OWNER may read them (RLS, migration 0088), and the app mirrors that on
// the surfaces that could otherwise hand them out. Before this file the print page's gate was proved only by a live browser run: the
// mutants "print shows incidents to everyone" and "the print link / history toggle shown to a non-owner" stayed GREEN.
//
// The fake database below returns the incident row to ANYONE who asks, as RLS would not. That is the point: whatever a practitioner does
// NOT see here is withheld by the page's own role gate, and the table is never even read for them.

const state = vi.hoisted(() => ({ role: "owner" as "owner" | "practitioner", calls: new Map<string, number>() }));

const SENTINELS = {
  name: "Exposed Sentinel Person",
  address: "Address Sentinel Road",
  phone: "555-0148-sentinel",
  details: "needlestick-details-sentinel",
  action: "action-taken-sentinel",
  staff: "Staff Involved Sentinel",
  notes: "notes-sentinel",
};
const ROWS: Record<string, unknown[]> = {
  record_keeping_exposure_incidents: [
    {
      id: "inc-1", studio_id: "studio-1", incident_date: "2026-11-20",
      exposed_person_full_name: SENTINELS.name, exposed_person_address: SENTINELS.address, exposed_person_phone: SENTINELS.phone,
      exposure_details: SENTINELS.details, action_taken: SENTINELS.action, staff_involved_name: SENTINELS.staff, notes: SENTINELS.notes,
      created_by_practitioner_id: null, created_at: "2026-11-20T10:00:00Z", updated_at: "2026-11-20T10:00:00Z",
    },
  ],
};

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
}));

function fakeClient() {
  const builder = (table: string) => {
    state.calls.set(table, (state.calls.get(table) ?? 0) + 1);
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => ({ data: ROWS[table] ?? [], error: null, count: (ROWS[table] ?? []).length }))
              .then(resolve, reject);
        }
        if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null });
        return () => proxy;
      },
    });
    return proxy;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => builder(table),
    rpc: (fn: string) => builder(`rpc:${fn}`),
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/supabase/queries", async (orig) => ({
  ...(await orig<typeof import("@/lib/supabase/queries")>()),
  requirePractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: state.role, display_name: "Someone", email: "someone@example.test" },
    studio: { id: "studio-1", name: "Studio", slug: "studio", timezone: "UTC" },
  }),
}));

const { default: RecordsPage } = await import("@/app/(app)/records/page");
const { default: RecordsPrintPage } = await import("@/app/(app)/records/print/page");

const INCIDENT_TABLE = "record_keeping_exposure_incidents";
const OWNER_ONLY_NOTE = "Exposure incident history is owner-only and is not included in this export.";
const allSentinels = Object.values(SENTINELS);

beforeEach(() => {
  state.calls.clear();
  state.role = "owner";
});

const printMarkup = async (sp: Record<string, string>) =>
  renderToStaticMarkup((await RecordsPrintPage({ searchParams: Promise.resolve(sp) })) as React.ReactElement);

/** Every href and the visible text of a rendered React tree (the records page holds client components, so it is walked, not rendered). */
function scan(node: ReactNode) {
  const out = { text: "", hrefs: [] as string[] };
  const seen = new Set<unknown>();
  const walk = (n: unknown) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      out.text += `${n} `;
      return;
    }
    if (typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) return n.forEach(walk);
    if (isValidElement(n)) {
      const props = n.props as Record<string, unknown>;
      if (typeof props.href === "string") out.hrefs.push(props.href);
      walk(props.children);
    }
  };
  walk(node);
  return out;
}
const recordsScan = async (sp: Record<string, string>) => scan(await RecordsPage({ searchParams: Promise.resolve(sp) }));
const hrefsIn = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

describe("the print page: incident history is owner-only", () => {
  for (const history of [false, true]) {
    const sp = { section: "incidents", ...(history ? { history: "1" } : {}) };
    const label = history ? "with &history=1" : "without history";

    it(`a PRACTITIONER ${label}: no incident text, the owner-only note, no history toggle, and the table is never read`, async () => {
      state.role = "practitioner";
      const html = await printMarkup(sp);
      for (const s of allSentinels) expect(html, `leaked: ${s}`).not.toContain(s);
      expect(html).toContain(OWNER_ONLY_NOTE);
      expect(html).not.toContain("Includes edit history");
      expect(html).not.toContain("Include history");
      expect(html).not.toContain("Hide history");
      expect(hrefsIn(html).filter((h) => h.includes("history=1"))).toEqual([]);
      expect(state.calls.get(INCIDENT_TABLE) ?? 0, "the incident table was read for a practitioner").toBe(0);
    });
  }

  it("the OWNER, without history: the incident is printed and the history toggle is offered", async () => {
    const html = await printMarkup({ section: "incidents" });
    for (const s of [SENTINELS.name, SENTINELS.details, SENTINELS.action, SENTINELS.staff]) expect(html).toContain(s);
    expect(html).not.toContain(OWNER_ONLY_NOTE);
    expect(html).toContain("Include history");
    expect(hrefsIn(html)).toContain("/records/print?section=incidents&history=1");
  });

  it("the OWNER, with &history=1: the incident is printed and the page says it includes edit history", async () => {
    const html = await printMarkup({ section: "incidents", history: "1" });
    expect(html).toContain(SENTINELS.details);
    expect(html).toContain("Includes edit history");
    expect(html).toContain("Hide history");
  });

  it("another section's print is unaffected by the role (a practitioner still gets the history toggle there)", async () => {
    state.role = "practitioner";
    const html = await printMarkup({ section: "sterile" });
    expect(html).toContain("Include history");
  });
});

describe("the Records page: the incident print link is owner-only", () => {
  it("a PRACTITIONER on the incidents section: no print link to incidents, the owner-only copy, the table is never read", async () => {
    state.role = "practitioner";
    const page = await recordsScan({ section: "incidents" });
    expect(page.hrefs.filter((h) => h.startsWith("/records/print?section=incidents"))).toEqual([]);
    expect(page.text).toContain("Exposure incident history is owner-only.");
    for (const s of allSentinels) expect(page.text).not.toContain(s);
    expect(state.calls.get(INCIDENT_TABLE) ?? 0).toBe(0);
  });

  it("the OWNER on the incidents section: the print link is there", async () => {
    const page = await recordsScan({ section: "incidents" });
    expect(page.hrefs).toContain("/records/print?section=incidents");
  });

  it("a PRACTITIONER still gets the print link on the other sections", async () => {
    state.role = "practitioner";
    const page = await recordsScan({ section: "sterile" });
    expect(page.hrefs).toContain("/records/print?section=sterile");
  });
});
