import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_COLUMNS_WITHOUT_PRICE,
  SESSION_COLUMNS_WITHOUT_PRICE,
} from "@/lib/clients/profile-pricing";
import { canViewClientBilling } from "@/lib/clients/profile-tabs";

const read = (p: string) => readFileSync(p, "utf8");

// RBAC G-1: how a page states the price option on getClientById. Every call's argument text is read (balanced parens), and:
//   - a call with a spread (`...x`) is accepted ONLY as EXACTLY `{ ...priceReads, includeSessions: recordsGate }` (R4: sessions are gated on
//     clin.view_records; the price option still comes only from priceReads) AND only where `const priceReads = { includePrices: isOwner };` is
//     declared in the same file; any other spread (a later `includePrices: true`, an unknown `...x`) is refused, so the extension cannot slip a price in;
//   - without a spread, the call names `includePrices` or passes the bare `priceReads`.
export function getClientByIdStatesPriceOption(src: string): boolean {
  const calls: string[] = [];
  for (let i = src.indexOf("getClientById("); i !== -1; i = src.indexOf("getClientById(", i + 1)) {
    let depth = 0;
    let j = i + "getClientById".length;
    for (; j < src.length; j += 1) {
      if (src[j] === "(") depth += 1;
      else if (src[j] === ")" && (depth -= 1) === 0) break;
    }
    calls.push(src.slice(i + "getClientById(".length, j));
  }
  if (calls.length === 0) return false;
  const declared = /const priceReads = \{ includePrices: isOwner \};/.test(src);
  return calls.every((args) => {
    if (/\.\.\./.test(args)) {
      return declared && /^studio\.id, id, \{ \.\.\.priceReads, includeSessions: recordsGate \}$/.test(args.trim());
    }
    return /includePrices/.test(args) || /^studio\.id, id, priceReads$/.test(args.trim());
  });
}

function typeKeys(name: string): string[] {
  const src = read("lib/types/database.ts");
  const start = src.indexOf(`export type ${name} = {`);
  const end = src.indexOf("\n};", start);
  return [...src.slice(start, end).replace(/\/\/.*/g, "").matchAll(/^\s*([a-z_0-9]+)\??:/gm)].map((m) => m[1]);
}
const cols = (list: string) => list.split(",").map((c) => c.trim());

describe("the price-free column lists stay in step with the row types", () => {
  it("sessions: every Session column except price_paid_cents", () => {
    expect(cols(SESSION_COLUMNS_WITHOUT_PRICE).sort()).toEqual(
      typeKeys("Session").filter((k) => k !== "price_paid_cents").sort(),
    );
  });
  it("services: every Service column except price_cents", () => {
    expect(cols(SERVICE_COLUMNS_WITHOUT_PRICE).sort()).toEqual(
      typeKeys("Service").filter((k) => k !== "price_cents").sort(),
    );
  });
  it("no price column in either list", () => {
    expect(SESSION_COLUMNS_WITHOUT_PRICE + SERVICE_COLUMNS_WITHOUT_PRICE).not.toMatch(/price/);
  });
});

// A recording Supabase client: every table read answers empty, and each .from/.select is logged.
const log: { table: string; select?: string }[] = [];
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: vi.fn(async () => ({ allowed: true, mode: "enforce", engine: true })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const entry: { table: string; select?: string } = { table };
      log.push(entry);
      const chain: Record<string, unknown> = {};
      const self = new Proxy(chain, {
        get(_t, prop: string) {
          if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], error: null });
          if (prop === "maybeSingle") return async () => ({ data: table === "clients" ? { id: "c1" } : null, error: null });
          if (prop === "select") return (arg?: string) => { entry.select = arg; return self; };
          return () => self;
        },
      });
      return self;
    },
  }),
}));

describe("the loaders do not fetch a price for a non-owner (Sam's ruling)", () => {
  beforeEach(() => { log.length = 0; });

  it("getClientById({ includePrices:false }) never reads client_pricing and never selects price_paid_cents", async () => {
    const { getClientById } = await import("@/lib/supabase/queries");
    await getClientById("s1", "c1", { includePrices: false });
    expect(log.map((l) => l.table)).not.toContain("client_pricing");
    const sessions = log.find((l) => l.table === "sessions");
    expect(sessions?.select).toBeDefined();
    expect(sessions?.select).not.toMatch(/price|\*,|^\*/);
    expect(sessions?.select).toContain("electrolysis_entries(*)");
  });

  it("an owner's read is unchanged: client pricing and every session column", async () => {
    const { getClientById } = await import("@/lib/supabase/queries");
    await getClientById("s1", "c1", { includePrices: true });
    expect(log.map((l) => l.table)).toContain("client_pricing");
    expect(log.find((l) => l.table === "sessions")?.select).toMatch(/^\*,/);
  });

  it.each([undefined, null, "true", 1])("a non-boolean includePrices (%j) is also the SAFE read: only exactly true fetches prices", async (v) => {
    const { getClientById } = await import("@/lib/supabase/queries");
    await getClientById("s1", "c1", { includePrices: v } as never);
    expect(log.map((l) => l.table)).not.toContain("client_pricing");
    expect(log.find((l) => l.table === "sessions")?.select).not.toMatch(/price|^\*/);
  });

  it("the default (a caller that names nothing) is the SAFE read: no client pricing, no price column", async () => {
    const { getClientById } = await import("@/lib/supabase/queries");
    await getClientById("s1", "c1");
    expect(log.map((l) => l.table)).not.toContain("client_pricing");
    expect(log.find((l) => l.table === "sessions")?.select).not.toMatch(/price|^\*/);
  });

  it("no page calls getClientById without stating the price option or needing none (RBAC G-1)", async () => {
    const { readFileSync } = await import("node:fs");
    const withOption = [
      "app/(app)/clients/[id]/page.tsx",
      "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
    ];
    for (const f of withOption) {
      expect(getClientByIdStatesPriceOption(readFileSync(f, "utf8")), f).toBe(true);
    }
  });

  it("the extension cannot be used to slip a price through (negative fixtures)", () => {
    const ok = "const priceReads = { includePrices: isOwner };\n";
    expect(getClientByIdStatesPriceOption(ok + "await getClientById(studio.id, id, priceReads);")).toBe(true);
    expect(getClientByIdStatesPriceOption(ok + "await getClientById(studio.id, id, { ...priceReads, includeSessions: recordsGate });")).toBe(true);
    // refused: a later includePrices after the spread, an unknown spread, a spread with no declared priceReads, a bare call
    expect(getClientByIdStatesPriceOption(ok + "await getClientById(studio.id, id, { ...priceReads, includePrices: true });")).toBe(false);
    expect(getClientByIdStatesPriceOption(ok + "await getClientById(studio.id, id, { includePrices: true, ...x });")).toBe(false);
    expect(getClientByIdStatesPriceOption(ok + "await getClientById(studio.id, id, { ...x, includeSessions: recordsGate });")).toBe(false);
    expect(getClientByIdStatesPriceOption("await getClientById(studio.id, id, { ...priceReads, includeSessions: recordsGate });")).toBe(false);
    expect(getClientByIdStatesPriceOption("await getClientById(studio.id, id);")).toBe(false);
    // one good call does not excuse a second bad one
    expect(getClientByIdStatesPriceOption(ok + "getClientById(studio.id, id, priceReads); getClientById(studio.id, id, { ...priceReads, includePrices: true });")).toBe(false);
  });

  it("getActiveServices({ includePrices:false }) selects no price column and returns price_cents null", async () => {
    const { getActiveServices } = await import("@/lib/booking/queries");
    await getActiveServices("s1", { includePrices: false });
    expect(log.find((l) => l.table === "services")?.select).toBe(SERVICE_COLUMNS_WITHOUT_PRICE);
    log.length = 0;
    await getActiveServices("s1");
    expect(log.find((l) => l.table === "services")?.select).toBe("*");
  });
});

describe("the profile page wires the ruling", () => {
  const PAGE = read("app/(app)/clients/[id]/page.tsx");
  it("the owner decision gates both loaders", () => {
    expect(PAGE).toMatch(/const isOwner = canViewClientBilling\(practitioner\.role\);/);
    expect(PAGE).toMatch(/const priceReads = \{ includePrices: isOwner \};/);
    // Exactly one of: production's `priceReads`, or R4's call. R4: sessions are gated on clin.view_records; the price option still comes
    // only from priceReads.
    const prod = PAGE.includes("getClientById(studio.id, id, priceReads)");
    const r4 = PAGE.includes("getClientById(studio.id, id, { ...priceReads, includeSessions: recordsGate })");
    expect(prod !== r4, "exactly one accepted getClientById call shape").toBe(true);
    expect(PAGE).toContain("getActiveServices(studio.id, priceReads)");
  });
  it("the Pricing card is owner-only", () => {
    expect(PAGE).toMatch(/\{isOwner && \(\s*<section[^>]*>\s*<h2[^>]*>\s*Pricing\s*<\/h2>/);
  });
  it("only an owner is a billing viewer", () => {
    expect(canViewClientBilling("owner")).toBe(true);
    for (const r of ["practitioner", "receptionist", undefined, null, ""]) {
      expect(canViewClientBilling(r as never)).toBe(false);
    }
  });
});

describe("pinned notes: Overview AND the notes tab, one source, no second write path", () => {
  const PAGE = read("app/(app)/clients/[id]/page.tsx");
  it("the card is built once and rendered on both tabs", () => {
    expect((PAGE.match(/<ClientPinnedNotesCard\b/g) ?? []).length).toBe(1);
    expect(PAGE).toMatch(/\{activeTab === "overview" && \(\s*<>[\s\S]*?\{pinnedNotesCard\}/);
    expect(PAGE).toMatch(/\{activeTab === "notes" && pinnedNotesCard\}/);
  });
  it("the three actions are passed in that one place only", () => {
    for (const a of ["addClientPinnedNoteAction", "editClientPinnedNoteAction", "removeClientPinnedNoteAction"]) {
      expect((PAGE.match(new RegExp(`${a}\\b`, "g")) ?? []).length).toBe(2); // import + the one prop
    }
  });
  it("one read serves both, and the deferred-read contract covers the notes tab", () => {
    expect((PAGE.match(/getPinnedNotesForClient\(/g) ?? []).length).toBe(1);
    // The rule: wanted on Overview AND the notes tab, and read only for a viewer who holds clin.view_records (0335 gates the table the same way).
    expect(PAGE).toMatch(/const wantsPinnedNotes = isOverview \|\| activeTab === "notes";/);
    expect(PAGE).toMatch(/const needsPinnedNotes = wantsPinnedNotes && canViewRecords;/);
    expect(PAGE).toMatch(/notes: \{ personalNotes: needsPersonalNotes, pinnedNotes: needsPinnedNotes \}/);
  });
});
