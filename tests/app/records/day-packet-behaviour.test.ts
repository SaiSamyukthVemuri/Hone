import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { previewAuditMetadata, printAuditMetadata } from "@/lib/records/print/day-audit";

// HON-46 M2 (Insurance E-2). BEHAVIOUR, not source patterns: the real page and
// the real print action run with fakes for auth and the database, and we assert
// what they do. A gate that is present but wrong (the wrong object, a different
// spelling) fails here; a regex test would not notice.

const CLIENT = "7c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6";
const PREVIEW_ID = "0b9f3c64-1111-4222-8333-444455556666";
const STUDIO = { id: "studio-1", name: "Synthetic Studio", timezone: "America/Toronto" };

const state = {
  practitioner: { id: "p1", role: "owner", active: true },
  rpcResult: { data: PREVIEW_ID as unknown, error: null as unknown },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  fromCalls: [] as string[],
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  failTable: null as string | null,
};

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ practitioner: state.practitioner, studio: STUDIO }),
  getSessionBlockAreasByBlockIds: async () => new Map(),
}));
vi.mock("@/lib/clients/print-identity", () => ({
  readPrintIdentities: async () => ({ ok: true, byClient: new Map() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => ({ type: "a", props: { href, children }, key: null, ref: null, $$typeof: Symbol.for("react.transitional.element") }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(state.rpcResult);
    },
    from: (table: string) => {
      state.fromCalls.push(table);
      const ops: Array<[string, string, unknown]> = [];
      const q: Record<string, unknown> = {};
      const chain = (op: string) => (c: string, v?: unknown) => (ops.push([op, c, v]), q);
      for (const op of ["select", "eq", "is", "in", "gt", "gte", "lt", "order", "range"]) q[op] = chain(op);
      const rows = () => {
        let r = [...(state.tables[table] ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
        for (const [op, c, v] of ops) {
          if (op === "eq" || op === "is") r = r.filter((x) => x[c] === v);
          if (op === "in") r = r.filter((x) => (v as string[]).includes(x[c] as string));
          if (op === "gt") r = r.filter((x) => String(x[c]) > String(v));
          if (op === "gte") r = r.filter((x) => String(x[c]) >= String(v));
          if (op === "lt") r = r.filter((x) => String(x[c]) < String(v));
        }
        return r;
      };
      q.maybeSingle = () => Promise.resolve(state.failTable === table ? { data: null, error: { message: "row data" } } : { data: rows()[0] ?? null, error: null });
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(state.failTable === table ? { data: null, error: { message: "row data" } } : { data: rows(), error: null }).then(ok, bad);
      return q;
    },
  }),
}));

const { default: DayPacketPage } = await import("@/app/(app)/records/print/day/page");
const { recordDayPacketPrintAction } = await import("@/app/(app)/records/print/day/actions");

const session = (over: Record<string, unknown> = {}) => ({
  id: "s1", studio_id: STUDIO.id, client_id: CLIENT, deleted_at: null, started_at: "2026-05-10T15:00:00.000Z", ended_at: null,
  modality: "Electrolysis", session_notes: null, performed_by_practitioner_id: "p1", practitioner_id: "p1",
  aftercare_and_risks_explained_at: null, aftercare_and_risks_explained_by: null, ...over,
});
async function render(sp: { clientId?: string; day?: string }) {
  const el = await DayPacketPage({ searchParams: Promise.resolve(sp) });
  return renderToStaticMarkup(el as never);
}
const DAY = "2026-05-10";

beforeEach(() => {
  state.practitioner = { id: "p1", role: "owner", active: true };
  state.rpcResult = { data: PREVIEW_ID, error: null };
  state.rpcCalls = [];
  state.fromCalls = [];
  state.failTable = null;
  state.tables = {
    clients: [{ id: CLIENT, name: "Synthetic Client", studio_id: STUDIO.id }],
    sessions: [session()],
    practitioners: [{ id: "p1", display_name: "Dana Reyes", studio_id: STUDIO.id }],
    session_blocks: [], electrolysis_entries: [], laser_entries: [],
  };
});

describe("the owner gate, behaviourally (page)", () => {
  it.each([
    ["a practitioner", { id: "p2", role: "practitioner", active: true }],
    ["a receptionist", { id: "p3", role: "receptionist", active: true }],
    ["an inactive owner", { id: "p4", role: "owner", active: false }],
  ])("%s is refused before the audit and before any read", async (_n, who) => {
    state.practitioner = who;
    const html = await render({ clientId: CLIENT, day: DAY });
    expect(html).toContain("Only the studio owner can print clinical records.");
    expect(html).not.toContain("Synthetic Client");
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.fromCalls).toHaveLength(0);
  });
});

describe("validation refuses before the audit (page)", () => {
  it.each([
    ["missing day", { clientId: CLIENT }],
    ["malformed day", { clientId: CLIENT, day: "2026-13-01" }],
    ["B-2: year 9999", { clientId: CLIENT, day: "9999-12-31" }],
    ["year 0001", { clientId: CLIENT, day: "0001-01-01" }],
    ["a future day", { clientId: CLIENT, day: "2099-01-01" }],
    ["missing client", { day: DAY }],
    ["a non-UUID client", { clientId: "1 or 1=1", day: DAY }],
  ])("%s writes no audit row and reads nothing", async (_n, sp) => {
    const html = await render(sp);
    expect(html).toContain("No clinical record is shown.");
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.fromCalls).toHaveLength(0);
  });
});

describe("audit before any read (page)", () => {
  it("NEGATIVE CONTROL: when the audit is refused nothing is read and no record is shown", async () => {
    state.rpcResult = { data: null, error: { code: "42501", message: "row data" } };
    const html = await render({ clientId: CLIENT, day: DAY });
    expect(html).toContain("Could not record this view in the audit log.");
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.fromCalls).toHaveLength(0);
    expect(html).not.toContain("Dana Reyes");
    expect(html).not.toContain("row data");
  });
  it("a malformed audit response is also a refusal with no read", async () => {
    state.rpcResult = { data: "not-a-uuid", error: null };
    await render({ clientId: CLIENT, day: DAY });
    expect(state.fromCalls).toHaveLength(0);
  });
  it("the preview audit is exactly {scope, day} for this client, and the reads come after it", async () => {
    await render({ clientId: CLIENT, day: DAY });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].fn).toBe("record_clinical_records_audit");
    expect(state.rpcCalls[0].args).toEqual({ p_client_id: CLIENT, p_action: "clinical_records_previewed", p_metadata: previewAuditMetadata(DAY), p_id: null });
    expect(state.fromCalls.length).toBeGreaterThan(0);
  });
});

describe("what the page shows once audited", () => {
  it("a day with a treatment shows it and the Print button, with no contact data", async () => {
    const html = await render({ clientId: CLIENT, day: DAY });
    expect(html).toContain("Dana Reyes");
    expect(html).toContain("Synthetic Client");
    expect(html).toContain("Pending format review");
    expect(html).toContain("Print");
    expect(html).toContain("Per-area numbing, tolerance, reaction and caution notes");
    expect(html).toMatch(/as of May 10, 2026|as of [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  });
  it("an empty day is named and has no Print button", async () => {
    state.tables.sessions = [session({ started_at: "2026-05-09T15:00:00.000Z" })];
    const html = await render({ clientId: CLIENT, day: DAY });
    expect(html).toContain("No treatments were recorded for this client on May 10, 2026.");
    expect(html).not.toContain("Recording print");
    expect(html).not.toMatch(/>Print</);
  });
  it("a client of another studio shows nothing", async () => {
    state.tables.clients = [{ id: CLIENT, name: "Other Studio Client", studio_id: "studio-2" }];
    const html = await render({ clientId: CLIENT, day: DAY });
    expect(html).not.toContain("Other Studio Client");
    expect(html).not.toContain("Dana Reyes");
  });
  it("a failed read is 'could not load', never 'no treatments'", async () => {
    state.failTable = "session_blocks";
    const html = await render({ clientId: CLIENT, day: DAY });
    expect(html).toContain("Could not load this record.");
    expect(html).not.toContain("No treatments were recorded");
    expect(html).not.toContain("row data");
  });
});

describe("the print action, behaviourally", () => {
  const input = { clientId: CLIENT, day: DAY, previewAuditId: PREVIEW_ID };
  it.each([
    ["a practitioner", { id: "p2", role: "practitioner", active: true }],
    ["an inactive owner", { id: "p4", role: "owner", active: false }],
  ])("%s gets ok:false and the database is never called", async (_n, who) => {
    state.practitioner = who;
    expect(await recordDayPacketPrintAction(input)).toEqual({ ok: false });
    expect(state.rpcCalls).toHaveLength(0);
  });
  it.each([
    ["a non-UUID client", { ...input, clientId: "x" }],
    ["a non-UUID preview id", { ...input, previewAuditId: "x" }],
    ["a malformed day", { ...input, day: "2026-13-01" }],
    ["year 9999", { ...input, day: "9999-12-31" }],
    ["a future day", { ...input, day: "2099-01-01" }],
  ])("%s is refused without a database call", async (_n, bad) => {
    expect(await recordDayPacketPrintAction(bad)).toEqual({ ok: false });
    expect(state.rpcCalls).toHaveLength(0);
  });
  it("an owner's print cites the preview and sends only the 0233 print shape", async () => {
    expect(await recordDayPacketPrintAction(input)).toEqual({ ok: true });
    expect(state.rpcCalls).toEqual([
      { fn: "record_clinical_records_audit", args: { p_client_id: CLIENT, p_action: "clinical_records_printed", p_metadata: printAuditMetadata(DAY, PREVIEW_ID), p_id: null } },
    ]);
  });
  it("a database refusal (22023) or a malformed response is ok:false", async () => {
    state.rpcResult = { data: null, error: { code: "22023", message: "the cited preview is not this owner's preview" } };
    expect(await recordDayPacketPrintAction(input)).toEqual({ ok: false });
    state.rpcResult = { data: "nope", error: null };
    expect(await recordDayPacketPrintAction(input)).toEqual({ ok: false });
  });
});
