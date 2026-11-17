import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mintTicket } from "@/lib/records/print/ticket";
import { reopenTicket } from "@/lib/records/print/ticket-reopen";
import { resolveTicket } from "@/lib/records/print/ticket-resolve";
import {
  REOPEN_WINDOW_MS, consumeInProcess, recallInProcess, rememberInProcess, resetInProcessContextStore, resetInProcessTicketStore,
} from "@/lib/records/print/ticket-store";

// Synthetic ids and a synthetic secret only.
const SECRET = "synthetic-print-ticket-secret-0123456789abcdef";
const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO = "33333333-3333-4333-8333-333333333333";
const OWNER = "22222222-2222-4222-8222-222222222222";
const SECOND_OWNER = "44444444-4444-4444-8444-444444444444";
const CLIENT = "7c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6";
const DAY = "2031-02-17";
const T0 = new Date("2031-02-17T15:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let clock = T0.getTime();
const recall = async (nonce: string) => recallInProcess(nonce, clock);
const remember = async (nonce: string, ctx: Parameters<typeof rememberInProcess>[1]) => rememberInProcess(nonce, ctx, clock);

function mintAt(now: Date) {
  const m = mintTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: OWNER }, subject: { clientId: CLIENT, day: DAY }, now });
  if (!m.ok) throw new Error("mint failed");
  rememberInProcess(m.nonce, { studioId: STUDIO, clientId: CLIENT, day: DAY }, now.getTime());
  return m;
}
const reopen = (over: Partial<Parameters<typeof reopenTicket>[0]> & { ticket: string; now: Date }) =>
  reopenTicket({
    secret: SECRET, practitioner: { id: OWNER, role: "owner", active: true }, studioId: STUDIO, recall, remember, ...over,
  });

beforeEach(() => {
  resetInProcessContextStore();
  resetInProcessTicketStore();
  clock = T0.getTime();
});

describe("Open again: a fresh one-use ticket for an owner of the SAME studio", () => {
  it("reopens a USED ticket, and the fresh ticket opens once for that owner", async () => {
    const first = mintAt(T0);
    const opened = await resolveTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: OWNER }, ticket: first.ticket, consume: async (n) => consumeInProcess(n, T0.getTime()), now: T0 });
    expect(opened.ok).toBe(true);
    const again = await resolveTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: OWNER }, ticket: first.ticket, consume: async (n) => consumeInProcess(n, T0.getTime()), now: T0 });
    expect(again).toEqual({ ok: false, reason: "used" });
    clock = at(60_000).getTime();
    const r = await reopen({ ticket: first.ticket, now: at(60_000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fresh = r.path.replace("/records/print/ticket/", "");
    expect(fresh).not.toBe(first.ticket);
    const o = await resolveTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: OWNER }, ticket: fresh, consume: async (n) => consumeInProcess(n, clock), now: at(60_000) });
    expect(o).toEqual({ ok: true, clientId: CLIENT, day: DAY });
    const twice = await resolveTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: OWNER }, ticket: fresh, consume: async (n) => consumeInProcess(n, clock), now: at(60_000) });
    expect(twice).toEqual({ ok: false, reason: "used" });
  });

  it("reopens an EXPIRED ticket (past its 5 minutes) while inside the 30", async () => {
    const first = mintAt(T0);
    clock = at(10 * 60_000).getTime();
    expect((await resolveTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: OWNER }, ticket: first.ticket, consume: async () => "fresh", now: at(10 * 60_000) })).ok).toBe(false);
    expect((await reopen({ ticket: first.ticket, now: at(10 * 60_000) })).ok).toBe(true);
  });

  it("another OWNER of the same studio may reopen; the fresh ticket is bound to THAT owner", async () => {
    const first = mintAt(T0);
    const r = await reopen({ ticket: first.ticket, practitioner: { id: SECOND_OWNER, role: "owner", active: true }, now: at(1000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fresh = r.path.replace("/records/print/ticket/", "");
    expect((await resolveTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: OWNER }, ticket: fresh, consume: async () => "fresh", now: at(1000) }))).toEqual({ ok: false, reason: "foreign" });
    expect((await resolveTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: SECOND_OWNER }, ticket: fresh, consume: async () => "fresh", now: at(1000) })).ok).toBe(true);
  });

  it("puts no identifier in the path it returns (no client id, no day, no studio, no owner)", async () => {
    const first = mintAt(T0);
    const r = await reopen({ ticket: first.ticket, now: at(1000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toMatch(/^\/records\/print\/ticket\/[A-Za-z0-9_-]{127}$/);
    for (const v of [CLIENT, DAY, STUDIO, OWNER, "2031", "0217"]) expect(r.path).not.toContain(v);
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});

describe("one plain refusal for every failure", () => {
  const REFUSED = { ok: false };
  it("TENANT: another studio's owner is refused, and the remembered context is never even read", async () => {
    const first = mintAt(T0);
    let reads = 0;
    const r = await reopen({ ticket: first.ticket, studioId: OTHER_STUDIO, practitioner: { id: SECOND_OWNER, role: "owner", active: true }, recall: async (n) => { reads++; return recallInProcess(n, clock); }, now: at(1000) });
    expect(r).toEqual(REFUSED);
    expect(reads).toBe(0);
  });
  it("NON-OWNER (practitioner, or an inactive owner) is refused", async () => {
    const first = mintAt(T0);
    expect(await reopen({ ticket: first.ticket, practitioner: { id: SECOND_OWNER, role: "practitioner", active: true }, now: at(1000) })).toEqual(REFUSED);
    expect(await reopen({ ticket: first.ticket, practitioner: { id: OWNER, role: "owner", active: false }, now: at(1000) })).toEqual(REFUSED);
  });
  it("EXPIRY: after 30 minutes the context is gone and Open again refuses", async () => {
    const first = mintAt(T0);
    clock = at(REOPEN_WINDOW_MS - 1).getTime();
    expect((await reopen({ ticket: first.ticket, now: at(REOPEN_WINDOW_MS - 1) })).ok).toBe(true);
    clock = at(REOPEN_WINDOW_MS + 1000).getTime();
    expect(await reopen({ ticket: first.ticket, now: at(REOPEN_WINDOW_MS + 1000) })).toEqual(REFUSED);
  });
  it("forged, altered, malformed, missing or unremembered tickets, an unavailable store and a missing secret all refuse identically", async () => {
    const first = mintAt(T0);
    const unremembered = mintTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: OWNER }, subject: { clientId: CLIENT, day: DAY }, now: T0 });
    if (!unremembered.ok) throw new Error("mint");
    for (const t of [first.ticket.slice(0, -3) + "AAA", "short", "", undefined, null, 42, unremembered.ticket]) {
      expect(await reopen({ ticket: t as string, now: at(1000) })).toEqual(REFUSED);
    }
    expect(await reopen({ ticket: first.ticket, recall: async () => { throw new Error("down"); }, now: at(1000) })).toEqual(REFUSED);
    expect(await reopen({ ticket: first.ticket, remember: async () => false, now: at(1000) })).toEqual(REFUSED);
    expect(await reopen({ ticket: first.ticket, secret: undefined, now: at(1000) })).toEqual(REFUSED);
    expect(await reopen({ ticket: first.ticket, secret: "too-short", now: at(1000) })).toEqual(REFUSED);
  });
});

describe("audit and URL contracts, read from source", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("Open again writes no print row itself; the 'previewed' row comes from opening the fresh ticket through the same packet view", () => {
    const reopenSrc = read("lib/records/print/ticket-reopen.ts");
    const reopenAction = read("app/(app)/records/print/ticket/[token]/reopen-action.ts");
    expect(reopenSrc).not.toMatch(/clinical_records_printed|recordDayAudit/);
    expect(reopenAction).not.toMatch(/recordDayAudit|clinical_records_printed/);
    expect(read("app/(app)/records/print/ticket/[token]/page.tsx")).toMatch(/DayPacketView clientId=\{resolved\.clientId\}/);
    expect(read("app/(app)/records/print/_packet/day-packet-view.tsx")).toMatch(/clinical_records_previewed/);
  });
  it("the mint route's redirect still carries only the ticket, and it remembers the context server-side", () => {
    const route = read("app/(app)/records/print/open/route.ts");
    expect(route).toMatch(/Location: `\/records\/print\/ticket\/\$\{minted\.ticket\}`/);
    expect(route).toMatch(/rememberTicketContext\(minted\.nonce/);
    expect(route).not.toMatch(/Location:[^\n]*(clientId|rawClient|day\.day)/);
  });
  it("the reopen action returns no reason and redirects only to the opaque path", () => {
    const action = read("app/(app)/records/print/ticket/[token]/reopen-action.ts");
    expect(action).toMatch(/if \(result\.ok\) redirect\(result\.path\);\s*return \{ ok: false \};/);
  });
});
