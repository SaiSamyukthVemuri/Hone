import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { REOPEN_GRACE_MS, REOPEN_WINDOW_MS, TICKET_TTL_MS, inspectTicket, mintTicket } from "@/lib/records/print/ticket";
import { reopenTicket } from "@/lib/records/print/ticket-reopen";
import { resolveTicket } from "@/lib/records/print/ticket-resolve";
import { consumeInProcess, resetInProcessTicketStore } from "@/lib/records/print/ticket-store";

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

function mintAt(now: Date) {
  const m = mintTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: OWNER }, subject: { clientId: CLIENT, day: DAY }, now });
  if (!m.ok) throw new Error("mint failed");
  return m;
}
const reopen = (over: Partial<Parameters<typeof reopenTicket>[0]> & { ticket: string; now: Date }) =>
  reopenTicket({ secret: SECRET, practitioner: { id: OWNER, role: "owner", active: true }, studioId: STUDIO, ...over });
const openAs = (ticket: string, ownerId: string, now: Date) =>
  resolveTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId }, ticket, consume: async (n) => consumeInProcess(n, now.getTime()), now });

describe("Open again: a fresh one-use ticket for an owner of the SAME studio, from the ticket alone", () => {
  it("reopens a USED ticket, and the fresh ticket opens once for that owner", async () => {
    resetInProcessTicketStore();
    const first = mintAt(T0);
    expect((await openAs(first.ticket, OWNER, T0)).ok).toBe(true);
    expect(await openAs(first.ticket, OWNER, T0)).toEqual({ ok: false, reason: "used" });
    const r = reopen({ ticket: first.ticket, now: at(60_000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fresh = r.path.replace("/records/print/ticket/", "");
    expect(fresh).not.toBe(first.ticket);
    expect(await openAs(fresh, OWNER, at(60_000))).toEqual({ ok: true, clientId: CLIENT, day: DAY });
    expect(await openAs(fresh, OWNER, at(60_000))).toEqual({ ok: false, reason: "used" });
  });

  it("reopens a ticket that expired and was never opened", async () => {
    resetInProcessTicketStore();
    const first = mintAt(T0);
    expect((await openAs(first.ticket, OWNER, at(10 * 60_000))).ok).toBe(false); // expired
    const r = reopen({ ticket: first.ticket, now: at(10 * 60_000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await openAs(r.path.replace("/records/print/ticket/", ""), OWNER, at(10 * 60_000))).ok).toBe(true);
  });

  it("another OWNER of the same studio may reopen; the fresh ticket is bound to THAT owner", async () => {
    resetInProcessTicketStore();
    const first = mintAt(T0);
    const r = reopen({ ticket: first.ticket, practitioner: { id: SECOND_OWNER, role: "owner", active: true }, now: at(1000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fresh = r.path.replace("/records/print/ticket/", "");
    expect(await openAs(fresh, OWNER, at(1000))).toEqual({ ok: false, reason: "foreign" });
    expect((await openAs(fresh, SECOND_OWNER, at(1000))).ok).toBe(true);
  });

  it("puts no identifier in the path it returns (no client id, no day, no studio, no owner)", () => {
    const r = reopen({ ticket: mintAt(T0).ticket, now: at(1000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toMatch(/^\/records\/print\/ticket\/[A-Za-z0-9_-]{127}$/);
    for (const v of [CLIENT, DAY, STUDIO, OWNER, "2031", "0217"]) expect(r.path).not.toContain(v);
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});

describe("the 30-minute window is the ticket's own expiry plus 25 minutes", () => {
  it("is 5 + 25 = 30 minutes in total", () => {
    expect(TICKET_TTL_MS).toBe(5 * 60_000);
    expect(REOPEN_GRACE_MS).toBe(25 * 60_000);
    expect(REOPEN_WINDOW_MS).toBe(30 * 60_000);
  });
  it("reopens at 30 minutes after minting and refuses one millisecond later", () => {
    const first = mintAt(T0);
    expect(reopen({ ticket: first.ticket, now: at(REOPEN_WINDOW_MS) }).ok).toBe(true);
    expect(reopen({ ticket: first.ticket, now: at(REOPEN_WINDOW_MS + 1) })).toEqual({ ok: false });
    expect(reopen({ ticket: first.ticket, now: at(REOPEN_WINDOW_MS + 60 * 60_000) })).toEqual({ ok: false });
  });
  it("inspectTicket refuses a ticket that claims more than one TTL of life (one this code cannot mint)", () => {
    const longLived = mintAt(at(20 * 60_000)); // expires 25 minutes after T0
    expect(inspectTicket({ secret: SECRET, ticket: longLived.ticket, now: T0 })).toEqual({ ok: false });
    expect(inspectTicket({ secret: SECRET, ticket: longLived.ticket, now: at(20 * 60_000) }).ok).toBe(true);
  });
  it("inspectTicket returns the studio, client and day from the authenticated payload only", () => {
    const seen = inspectTicket({ secret: SECRET, ticket: mintAt(T0).ticket, now: T0 });
    expect(seen).toMatchObject({ ok: true, studioId: STUDIO, clientId: CLIENT, day: DAY });
    expect(inspectTicket({ secret: SECRET, ticket: mintAt(T0).ticket.slice(0, -3) + "AAA", now: T0 })).toEqual({ ok: false });
  });
});

describe("one plain refusal for every failure", () => {
  const REFUSED = { ok: false };
  it("TENANT: another studio's owner is refused", () => {
    expect(reopen({ ticket: mintAt(T0).ticket, studioId: OTHER_STUDIO, practitioner: { id: SECOND_OWNER, role: "owner", active: true }, now: at(1000) })).toEqual(REFUSED);
  });
  it("NON-OWNER (practitioner, or an inactive owner) is refused", () => {
    const first = mintAt(T0);
    expect(reopen({ ticket: first.ticket, practitioner: { id: SECOND_OWNER, role: "practitioner", active: true }, now: at(1000) })).toEqual(REFUSED);
    expect(reopen({ ticket: first.ticket, practitioner: { id: OWNER, role: "owner", active: false }, now: at(1000) })).toEqual(REFUSED);
  });
  it("forged, altered, malformed or missing tickets, a missing or short secret, and every other failure refuse identically", () => {
    const first = mintAt(T0);
    for (const t of [first.ticket.slice(0, -3) + "AAA", "short", "", undefined, null, 42]) {
      expect(reopen({ ticket: t as string, now: at(1000) })).toEqual(REFUSED);
    }
    expect(reopen({ ticket: first.ticket, secret: undefined, now: at(1000) })).toEqual(REFUSED);
    expect(reopen({ ticket: first.ticket, secret: "too-short", now: at(1000) })).toEqual(REFUSED);
    const other = mintTicket({ secret: "another-synthetic-secret-0123456789abcdefghij", binding: { studioId: STUDIO, ownerId: OWNER }, subject: { clientId: CLIENT, day: DAY }, now: T0 });
    if (!other.ok) throw new Error("mint");
    expect(reopen({ ticket: other.ticket, now: at(1000) })).toEqual(REFUSED); // minted under another secret
  });
});

describe("nothing is stored, and the audit and URL contracts hold (read from source)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("minting writes nothing: the mint route does not import the store, and the store holds only the single-use marker", () => {
    const route = read("app/(app)/records/print/open/route.ts");
    expect(route).not.toMatch(/ticket-store|remember|recall/);
    const store = read("lib/records/print/ticket-store.ts");
    expect(store).not.toMatch(/remember|recall|JSON\.stringify|clientId|studioId/);
    const sets = store.split("\n").filter((l) => /redis\.set\(/.test(l));
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatch(/ticketUseKey\(nonce\), "1", \{ nx: true/);
    expect(read("lib/records/print/ticket-reopen.ts")).not.toMatch(/ticket-store|redis/i);
    expect(read("app/(app)/records/print/ticket/[token]/reopen-action.ts")).not.toMatch(/ticket-store|redis/i);
  });
  it("the ticket module header states what the ticket holds and for how long", () => {
    const head = read("lib/records/print/ticket.ts").slice(0, 3500);
    expect(head).toMatch(/WHAT THE TICKET HOLDS, AND FOR HOW LONG/);
    expect(head).toMatch(/five minutes/);
    expect(head).toMatch(/25 minutes after its expiry/);
    expect(head).toMatch(/No server-side record/);
  });
  it("Open again writes no print row itself; the 'previewed' row comes from opening the fresh ticket through the same packet view", () => {
    const reopenAction = read("app/(app)/records/print/ticket/[token]/reopen-action.ts");
    expect(read("lib/records/print/ticket-reopen.ts")).not.toMatch(/clinical_records_printed|recordDayAudit/);
    expect(reopenAction).not.toMatch(/recordDayAudit|clinical_records_printed/);
    expect(read("app/(app)/records/print/ticket/[token]/page.tsx")).toMatch(/DayPacketView clientId=\{resolved\.clientId\}/);
    expect(read("app/(app)/records/print/_packet/day-packet-view.tsx")).toMatch(/clinical_records_previewed/);
  });
  it("the mint route's redirect carries only the ticket, never the client or the day", () => {
    const route = read("app/(app)/records/print/open/route.ts");
    expect(route).toMatch(/Location: `\/records\/print\/ticket\/\$\{minted\.ticket\}`/);
    expect(route).not.toMatch(/Location:[^\n]*(clientId|rawClient|day\.day)/);
  });
  it("the reopen action returns no reason and redirects only to the opaque path", () => {
    const action = read("app/(app)/records/print/ticket/[token]/reopen-action.ts");
    expect(action).toMatch(/if \(result\.ok\) redirect\(result\.path\);\s*return \{ ok: false \};/);
  });
});
