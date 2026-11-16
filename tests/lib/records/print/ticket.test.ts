import { describe, expect, it } from "vitest";
import {
  TICKET_LENGTH, TICKET_TTL_MS, mintTicket, openTicket, ticketUseKey, type TicketBinding,
} from "@/lib/records/print/ticket";
import { resolveTicket } from "@/lib/records/print/ticket-resolve";
import { consumeInProcess, consumeTicketNonce, resetInProcessTicketStore, type ConsumeTicket } from "@/lib/records/print/ticket-store";

// Synthetic ids and a synthetic secret only.
const SECRET = "synthetic-print-ticket-secret-0123456789abcdef";
const STUDIO = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const CLIENT = "7c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6";
const DAY = "2031-02-17";
const NOW = new Date("2031-02-17T15:00:00.000Z");
const binding: TicketBinding = { studioId: STUDIO, ownerId: OWNER };
const mint = (over: Partial<Parameters<typeof mintTicket>[0]> = {}) =>
  mintTicket({ secret: SECRET, binding, subject: { clientId: CLIENT, day: DAY }, now: NOW, ...over });
const ticket = () => {
  const m = mint();
  if (!m.ok) throw new Error("mint failed");
  return m.ticket;
};
const open = (over: Partial<Parameters<typeof openTicket>[0]> = {}) =>
  openTicket({ secret: SECRET, binding, ticket: ticket(), now: NOW, ...over });

describe("a ticket is opaque: no identifier is in it, in any common encoding", () => {
  it("is 127 URL-safe characters and holds neither the client id, the day, the studio nor the owner", () => {
    const t = ticket();
    expect(t).toHaveLength(TICKET_LENGTH);
    expect(TICKET_LENGTH).toBe(127);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    const hex = (u: string) => u.replace(/-/g, "");
    const raw = Buffer.from(t, "base64url");
    for (const secret of [CLIENT, DAY, STUDIO, OWNER, "2031", "0217"]) {
      expect(t).not.toContain(secret);
      expect(raw.toString("utf8")).not.toContain(secret);
      expect(raw.toString("hex")).not.toContain(hex(secret));
      expect(Buffer.from(secret).toString("base64url")).not.toBe("");
      expect(t).not.toContain(Buffer.from(secret).toString("base64url").slice(0, 12));
    }
    expect(raw.toString("hex")).not.toContain(hex(CLIENT));
  });
  it("two tickets for the same client and day differ (random iv and nonce)", () => {
    expect(ticket()).not.toBe(ticket());
  });
});

describe("opening a ticket", () => {
  it("returns the client and the day it was minted for, to the studio and owner it is bound to", () => {
    const r = open();
    expect(r).toMatchObject({ ok: true, clientId: CLIENT, day: DAY });
  });
  it("is refused after five minutes, and still valid just before", () => {
    const t = ticket();
    expect(openTicket({ secret: SECRET, binding, ticket: t, now: new Date(NOW.getTime() + TICKET_TTL_MS - 1) }).ok).toBe(true);
    expect(openTicket({ secret: SECRET, binding, ticket: t, now: new Date(NOW.getTime() + TICKET_TTL_MS) })).toEqual({ ok: false, reason: "expired" });
    expect(openTicket({ secret: SECRET, binding, ticket: t, now: new Date(NOW.getTime() + 24 * 3600_000) })).toEqual({ ok: false, reason: "expired" });
  });
  it("is refused from another studio, and from another owner of the same studio", () => {
    const t = ticket();
    expect(openTicket({ secret: SECRET, binding: { studioId: "33333333-3333-4333-8333-333333333333", ownerId: OWNER }, ticket: t, now: NOW })).toEqual({ ok: false, reason: "foreign" });
    expect(openTicket({ secret: SECRET, binding: { studioId: STUDIO, ownerId: "44444444-4444-4444-8444-444444444444" }, ticket: t, now: NOW })).toEqual({ ok: false, reason: "foreign" });
  });
  it("is refused when any single character is changed (authenticated, not merely signed)", () => {
    const t = ticket();
    for (let i = 0; i < t.length; i += 7) {
      const swapped = t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
      expect(openTicket({ secret: SECRET, binding, ticket: swapped, now: NOW }).ok, `char ${i}`).toBe(false);
    }
    // The last character carries two spare bits: every other spelling of it is refused, only the minted one opens.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const opens = [...alphabet].filter((c) => openTicket({ secret: SECRET, binding, ticket: t.slice(0, -1) + c, now: NOW }).ok);
    expect(opens).toEqual([t.at(-1)]);
  });
  it("is refused under another secret, and malformed strings are refused before any decrypt", () => {
    expect(open({ secret: "another-synthetic-secret-0123456789abcdefgh" })).toEqual({ ok: false, reason: "invalid" });
    for (const bad of ["", "abc", "A".repeat(126), "A".repeat(128), `${"A".repeat(126)}!`, `${CLIENT}`, null, undefined, 42, {}]) {
      expect(open({ ticket: bad }), String(bad)).toEqual({ ok: false, reason: "malformed" });
    }
  });
  it("a ticket claiming more than one lifetime is refused even if it authenticates", () => {
    // minted five minutes in the FUTURE of the clock that opens it: more life than the code ever grants
    const future = mint({ now: new Date(NOW.getTime() + TICKET_TTL_MS) });
    if (!future.ok) throw new Error("mint failed");
    expect(openTicket({ secret: SECRET, binding, ticket: future.ticket, now: NOW })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("minting fails closed", () => {
  it("with no secret, a short secret, or anything that is not a UUID or a real day", () => {
    for (const secret of [undefined, "", "short", "x".repeat(31)]) expect(mint({ secret }), String(secret)).toEqual({ ok: false, reason: "unavailable" });
    expect(open({ secret: undefined })).toEqual({ ok: false, reason: "unavailable" });
    for (const subject of [
      { clientId: "not-a-uuid", day: DAY }, { clientId: CLIENT, day: "2031-02-30" }, { clientId: CLIENT, day: "2031-2-3" },
      { clientId: CLIENT, day: "" }, { clientId: `${CLIENT}x`, day: DAY },
    ]) expect(mint({ subject }), JSON.stringify(subject)).toEqual({ ok: false, reason: "invalid" });
    expect(mint({ binding: { studioId: "x", ownerId: OWNER } })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("single use is enforced by the store, and only after the ticket authenticates", () => {
  const fresh = () => {
    const calls: string[] = [];
    const consume: ConsumeTicket = async (nonce) => (calls.push(nonce), consumeInProcess(nonce, NOW.getTime()));
    resetInProcessTicketStore();
    return { calls, consume };
  };
  const resolve = (t: string, consume: ConsumeTicket, b: TicketBinding = binding) =>
    resolveTicket({ secret: SECRET, binding: b, ticket: t, consume, now: NOW });

  it("the first open succeeds and the second is refused as used", async () => {
    const { consume } = fresh();
    const t = ticket();
    expect(await resolve(t, consume)).toEqual({ ok: true, clientId: CLIENT, day: DAY });
    expect(await resolve(t, consume)).toEqual({ ok: false, reason: "used" });
    expect(await resolve(t, consume)).toEqual({ ok: false, reason: "used" });
  });
  it("a foreign, forged, expired or malformed ticket never reaches the store, so it cannot spend the owner's one use", async () => {
    const { calls, consume } = fresh();
    const t = ticket();
    expect(await resolve(t, consume, { studioId: "33333333-3333-4333-8333-333333333333", ownerId: OWNER })).toEqual({ ok: false, reason: "foreign" });
    expect(await resolve("A".repeat(127), consume)).toEqual({ ok: false, reason: "invalid" });
    expect(await resolve("nope", consume)).toEqual({ ok: false, reason: "malformed" });
    expect(await resolveTicket({ secret: SECRET, binding, ticket: t, consume, now: new Date(NOW.getTime() + TICKET_TTL_MS) })).toEqual({ ok: false, reason: "expired" });
    expect(calls).toEqual([]);
    expect(await resolve(t, consume)).toEqual({ ok: true, clientId: CLIENT, day: DAY }); // the owner's use is intact
  });
  it("when the store cannot answer, or throws, the ticket is refused (fail closed)", async () => {
    expect(await resolve(ticket(), async () => "unavailable")).toEqual({ ok: false, reason: "unavailable" });
    expect(await resolve(ticket(), async () => { throw new Error("redis down"); })).toEqual({ ok: false, reason: "unavailable" });
  });
  it("the marker key is a hash of the nonce: no identifier, no ticket, no secret", () => {
    const o = open();
    if (!o.ok) throw new Error("open failed");
    const key = ticketUseKey(o.nonce);
    expect(key).toMatch(/^print-ticket:[0-9a-f]{64}$/);
    for (const v of [CLIENT, DAY, STUDIO, OWNER, ticket(), o.nonce]) expect(key).not.toContain(v);
  });
});

describe("the production store refuses when it cannot be sure", () => {
  const env = process.env as Record<string, string | undefined>;
  const keep = { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, node: env.NODE_ENV };
  const restore = () => {
    for (const [k, v] of [["UPSTASH_REDIS_REST_URL", keep.url], ["UPSTASH_REDIS_REST_TOKEN", keep.token], ["NODE_ENV", keep.node]] as const) {
      if (v === undefined) delete env[k]; else env[k] = v;
    }
  };
  it("production with no Redis is 'unavailable' (never an in-process stand-in)", async () => {
    try {
      delete env.UPSTASH_REDIS_REST_URL; delete env.UPSTASH_REDIS_REST_TOKEN; env.NODE_ENV = "production";
      expect(await consumeTicketNonce("aa".repeat(8))).toBe("unavailable");
      expect(await consumeTicketNonce("aa".repeat(8))).toBe("unavailable");
    } finally { restore(); }
  });
  it("outside production with no Redis the in-process stand-in still enforces single use", async () => {
    try {
      delete env.UPSTASH_REDIS_REST_URL; delete env.UPSTASH_REDIS_REST_TOKEN; env.NODE_ENV = "test";
      resetInProcessTicketStore();
      expect(await consumeTicketNonce("bb".repeat(8))).toBe("fresh");
      expect(await consumeTicketNonce("bb".repeat(8))).toBe("used");
    } finally { restore(); }
  });
  it("a Redis that throws is 'unavailable'", async () => {
    try {
      env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1"; env.UPSTASH_REDIS_REST_TOKEN = "synthetic"; env.NODE_ENV = "production";
      expect(await consumeTicketNonce("cc".repeat(8))).toBe("unavailable");
    } finally { restore(); }
  });
});
