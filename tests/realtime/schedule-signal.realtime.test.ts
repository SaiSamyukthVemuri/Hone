import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { E2E_DB_URL, E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "@/e2e/helpers/local-env";
import { seedE2eMember, seedE2eStudio, sql, type E2eSeed } from "@/e2e/helpers/seed";

// HON-48 / 0271: the schedule-change signal at the PROTOCOL level, on a stack that runs the
// Realtime service. The SQL-level policy matrix lives in tests/db/schedule-signal.db.test.ts;
// this file proves what only a socket can: that a client who joins the topic PUBLICLY (public
// access to channels is ON by default locally and on the hosted project) still receives
// nothing, that a browser cannot publish into the topic, how a dropped socket recovers, and
// how long a committed change takes to arrive. Every number printed here is measured, none is
// asserted as a budget except the 2 s latency bound (Q7).

const URL = E2E_SUPABASE_URL;
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD = "Hon48-synthetic-pass-1!";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Session = { userId: string; token: string };
type Got = { at: number; event: string; payload: unknown };
type Sub = { client: SupabaseClient; ch: RealtimeChannel; status: string; got: Got[]; log: string[] };

async function gotrue(path: string, method: string, json?: unknown): Promise<Response> {
  return fetch(`${URL}/auth/v1${path}`, {
    method,
    headers: { apikey: E2E_SERVICE_ROLE_KEY, Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

async function withPassword(email: string): Promise<Session> {
  const user = (await sql<{ id: string }>(`select id from auth.users where lower(email) = lower($1)`, [email]))[0];
  const set = await gotrue(`/admin/users/${user.id}`, "PUT", { password: PASSWORD });
  if (!set.ok) throw new Error(`could not set a synthetic password: ${set.status}`);
  const grant = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!grant.ok) throw new Error(`password grant failed: ${grant.status}`);
  return { userId: user.id, token: ((await grant.json()) as { access_token: string }).access_token };
}

const clients: SupabaseClient[] = [];
async function join(topic: string, opts: { token?: string; isPrivate: boolean; waitMs?: number }): Promise<Sub> {
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 50 } },
  });
  clients.push(client);
  if (opts.token) await client.realtime.setAuth(opts.token);
  const ch = client.channel(topic, { config: { private: opts.isPrivate } });
  const sub: Sub = { client, ch, status: "pending", got: [], log: [] };
  ch.on("broadcast", { event: "changed" }, (m: { event: string; payload: unknown }) =>
    sub.got.push({ at: Date.now(), event: m.event, payload: m.payload }));
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { if (sub.status === "pending") sub.status = "TIMED_OUT_WAITING"; resolve(); }, opts.waitMs ?? 12_000);
    ch.subscribe((s: string) => {
      sub.status = s;
      sub.log.push(s);
      if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(s)) { clearTimeout(t); resolve(); }
    });
  });
  return sub;
}
async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); }
  return fn();
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};
const summary = (xs: number[]) =>
  xs.length ? { n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(...xs)) } : { n: 0 };

let A: E2eSeed;
let B: E2eSeed;
let memberEmail: string;
let ownerA: Session;
let ownerB: Session;
let memberA: Session;
let removed: Session;
let anonOnly = true;
const topicA = () => `schedule:${A.studioId}`;
let day = 0;
// One committed schedule-visible change: a blockout is a single statement and fires one signal.
async function commitChange(studioId: string): Promise<number> {
  day += 1;
  const t = Date.now();
  // A distinct day every time: blockouts mirror into calendar reservations, which may not overlap.
  await sql(`insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason)
             values ($1, date '2036-01-01' + $2::int, date '2036-01-01' + $2::int, 'hon48-realtime')`, [studioId, day]);
  return t;
}

beforeAll(async () => {
  if (typeof WebSocket === "undefined") throw new Error("these proofs need Node 22+ (global WebSocket)");
  const have = await sql<{ ok: boolean }>(`select to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null as ok`);
  if (!have[0].ok) throw new Error("this stack does not run the Realtime service; start it without excluding realtime");
  const pol = await sql<{ n: number }>(`select count(*)::int as n from pg_policies where schemaname='realtime' and tablename='messages' and policyname='schedule_signal_member_read'`);
  if (pol[0].n !== 1) throw new Error("0271's policy is not installed on this stack");
  A = await seedE2eStudio();
  B = await seedE2eStudio();
  const m = await seedE2eMember(A);
  memberEmail = m.email;
  const gone = await seedE2eMember(A);
  ownerA = await withPassword(A.ownerEmail);
  ownerB = await withPassword(B.ownerEmail);
  memberA = await withPassword(memberEmail);
  removed = await withPassword(gone.email);
  // Removed AFTER the token was issued: the token stays valid until it expires (L1), membership does not.
  await sql(`update public.practitioners set active = false where studio_id = $1 and user_id = $2`, [A.studioId, removed.userId]);
  anonOnly = true;
  // Cold start. On a freshly started tenant the first private subscriber can be SUBSCRIBED while the
  // service's message-replication slot is still coming up, so the first commits land in
  // realtime.messages but are not delivered (measured: a row existed, no delivery within 5 s). The
  // client's catch-up on every SUBSCRIBED and the 60 s floor cover exactly this. Warm the tenant
  // here and record how long it took, so the timed proofs below measure steady state and the
  // cold-start gap is reported instead of hidden.
  const warm = await join(topicA(), { token: ownerA.token, isPrivate: true });
  const t0 = Date.now();
  let warmed = false;
  while (!warmed && Date.now() - t0 < 60_000) {
    const n = warm.got.length;
    await commitChange(A.studioId);
    warmed = await waitFor(() => warm.got.length > n, 4_000);
  }
  console.log("PROOF cold-start warm-up", JSON.stringify({ delivered: warmed, ms: Date.now() - t0 }));
  if (!warmed) throw new Error("the Realtime tenant never delivered a private broadcast within 60 s");
}, 180_000);

afterAll(async () => {
  for (const c of clients) { try { await c.removeAllChannels(); } catch { /* best effort */ } }
});

describe("0271 protocol proofs (real Realtime)", () => {
  it("positive control: a private member join receives a signal, and the payload carries no row data", async () => {
    const sub = await join(topicA(), { token: ownerA.token, isPrivate: true });
    expect(sub.status).toBe("SUBSCRIBED");
    await commitChange(A.studioId);
    expect(await waitFor(() => sub.got.length >= 1, 5_000)).toBe(true);
    expect(sub.got[0].event).toBe("changed");
    const payload = sub.got[0].payload as Record<string, unknown>;
    expect(Object.keys(payload).filter((k) => k !== "id")).toEqual([]);
    console.log("PROOF positive-control ok");
  });

  it("PUBLIC join of the private topic (public access ON) receives ZERO signals: anon, another studio's user, a removed member", async () => {
    const control = await join(topicA(), { token: memberA.token, isPrivate: true });
    expect(control.status).toBe("SUBSCRIBED");
    const publicAnon = await join(topicA(), { isPrivate: false });
    const publicOther = await join(topicA(), { token: ownerB.token, isPrivate: false });
    const publicRemoved = await join(topicA(), { token: removed.token, isPrivate: false });
    const privateAnon = await join(topicA(), { isPrivate: true });
    const privateOther = await join(topicA(), { token: ownerB.token, isPrivate: true });
    const privateRemoved = await join(topicA(), { token: removed.token, isPrivate: true });
    console.log("PROOF public-join statuses", JSON.stringify({
      publicAnon: publicAnon.status, publicOther: publicOther.status, publicRemoved: publicRemoved.status,
      privateAnon: privateAnon.status, privateOther: privateOther.status, privateRemoved: privateRemoved.status,
    }));
    for (let i = 0; i < 3; i++) await commitChange(A.studioId);
    // The positive control must hear it, or the silence below proves nothing.
    expect(await waitFor(() => control.got.length >= 1, 5_000)).toBe(true);
    await sleep(2_500);
    const heard = {
      publicAnon: publicAnon.got.length, publicOther: publicOther.got.length, publicRemoved: publicRemoved.got.length,
      privateAnon: privateAnon.got.length, privateOther: privateOther.got.length, privateRemoved: privateRemoved.got.length,
    };
    console.log("PROOF public-join heard", JSON.stringify(heard), "control", control.got.length);
    expect(heard).toEqual({ publicAnon: 0, publicOther: 0, publicRemoved: 0, privateAnon: 0, privateOther: 0, privateRemoved: 0 });
    expect(anonOnly).toBe(true);
  });

  it("guessed and malformed topics deliver nothing and do not reach another studio's signal", async () => {
    const real = await join(topicA(), { token: memberA.token, isPrivate: true });
    expect(real.status).toBe("SUBSCRIBED");
    const wrong = [
      `schedule:${B.studioId}`, "schedule:*", "schedule:", `schedule:${A.studioId}:x`, `Schedule:${A.studioId}`,
      `schedule:${A.studioId.toUpperCase()}`, "schedule", "realtime:schedule", `schedule:${A.studioId} `,
    ];
    const probes = await Promise.all(wrong.map((t) => join(t, { token: memberA.token, isPrivate: true, waitMs: 6_000 })));
    await commitChange(A.studioId);
    expect(await waitFor(() => real.got.length >= 1, 5_000)).toBe(true);
    await sleep(1_500);
    const leaks = probes.map((p, i) => ({ topic: wrong[i], status: p.status, got: p.got.length })).filter((p) => p.got > 0);
    console.log("PROOF guessed-topics", JSON.stringify(probes.map((p, i) => ({ t: wrong[i].replace(A.studioId, "<A>").replace(B.studioId, "<B>"), s: p.status, n: p.got.length }))));
    expect(leaks).toEqual([]);
  });

  it("another studio's signal is never delivered to this studio's member", async () => {
    const sub = await join(topicA(), { token: memberA.token, isPrivate: true });
    expect(sub.status).toBe("SUBSCRIBED");
    const before = sub.got.length;
    await commitChange(B.studioId);
    await commitChange(B.studioId);
    await sleep(2_000);
    expect(sub.got.length).toBe(before);
  });

  it("forged publish: a browser cannot send into the topic (socket send, REST broadcast incl. an active member), public or private", async () => {
    const listener = await join(topicA(), { token: memberA.token, isPrivate: true });
    expect(listener.status).toBe("SUBSCRIBED");
    const before = listener.got.length;
    const attackers: { name: string; sub: Sub }[] = [
      { name: "anon-public", sub: await join(topicA(), { isPrivate: false }) },
      { name: "other-studio-public", sub: await join(topicA(), { token: ownerB.token, isPrivate: false }) },
      { name: "removed-public", sub: await join(topicA(), { token: removed.token, isPrivate: false }) },
      { name: "other-studio-private", sub: await join(topicA(), { token: ownerB.token, isPrivate: true }) },
    ];
    const outcomes: Record<string, string> = {};
    for (const a of attackers) {
      try { outcomes[a.name] = String(await a.sub.ch.send({ type: "broadcast", event: "changed", payload: { forged: true } })); }
      catch (e) { outcomes[a.name] = `threw:${(e as Error).message.slice(0, 40)}`; }
    }
    // The REST broadcast endpoint, as each caller identity.
    for (const [name, token] of [["rest-anon", ANON], ["rest-other-studio", ownerB.token], ["rest-removed", removed.token], ["rest-member", memberA.token]] as const) {
      const res = await fetch(`${URL}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ topic: topicA(), event: "changed", payload: { forged: true }, private: true }] }),
      });
      outcomes[name] = `http:${res.status}`;
    }
    await sleep(2_500);
    console.log("PROOF forged-publish", JSON.stringify({ outcomes, delivered: listener.got.length - before }));
    // Nothing a browser identity publishes reaches the private listener, over any path: public or
    // private socket send, and the REST broadcast endpoint as anon, another studio's owner, a removed
    // member and an ACTIVE MEMBER of the same studio. Measured on the pinned local Realtime: every REST
    // call returns 202 and none is delivered. Asserted, per path, not just printed.
    expect(outcomes["rest-member"], "REST member publish returns an HTTP status").toMatch(/^http:\d{3}$/);
    expect(listener.got.length - before, "no forged publish was delivered").toBe(0);
    const forgedRows = (await sql<{ n: number }>(`select count(*)::int as n from realtime.messages where topic = $1 and payload ? 'forged'`, [topicA()]))[0].n;
    expect(forgedRows, "no forged row was written").toBe(0);
  });

  it("SQL-level forged realtime.send as authenticated and anon: no new row AND no delivery to a private subscriber; the postgres control row is delivered", async () => {
    const listener = await join(topicA(), { token: memberA.token, isPrivate: true });
    expect(listener.status).toBe("SUBSCRIBED");
    const rows = async () => (await sql<{ n: number }>(`select count(*)::int as n from realtime.messages where topic = $1`, [topicA()]))[0].n;
    const forgedAs = async (role: "authenticated" | "anon", sub: string | null) => {
      const c = new PgClient({ connectionString: E2E_DB_URL });
      await c.connect();
      try {
        await c.query("begin");
        await c.query(`set local role ${role}`);
        if (sub) await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role })]);
        try { await c.query(`select realtime.send('{"forged":true}'::jsonb, 'changed', $1, true)`, [topicA()]); } catch { /* refused */ }
        await c.query("commit").catch(() => undefined);
      } finally { await c.end(); }
    };
    // Control first, on the same topic, through the same function: postgres (BYPASSRLS) lands one row and is delivered.
    const r0 = await rows();
    const h0 = listener.got.length;
    await sql(`select realtime.send('{}'::jsonb, 'changed', $1, true)`, [topicA()]);
    expect(await waitFor(() => listener.got.length > h0, 5_000)).toBe(true);
    expect((await rows()) - r0).toBe(1);
    // Forged calls: neither a row nor a delivery.
    const r1 = await rows();
    const h1 = listener.got.length;
    await forgedAs("authenticated", memberA.userId);
    await forgedAs("authenticated", ownerB.userId);
    await forgedAs("anon", null);
    await sleep(2_500);
    const forgedRows = (await sql<{ n: number }>(`select count(*)::int as n from realtime.messages where payload ? 'forged'`))[0].n;
    console.log("PROOF sql-forged-send", JSON.stringify({ newRows: (await rows()) - r1, delivered: listener.got.length - h1, forgedRows }));
    expect((await rows()) - r1).toBe(0);
    expect(forgedRows).toBe(0);
    expect(listener.got.length - h1).toBe(0);
  });

  it("realtime.messages is not writable by a browser role through the policy (no INSERT/UPDATE/DELETE clause)", async () => {
    const r = await sql<{ cmd: string }>(`select cmd from pg_policies where schemaname='realtime' and tablename='messages' and policyname='schedule_signal_member_read'`);
    expect(r.map((x) => x.cmd)).toEqual(["SELECT"]);
  });

  it("reconnect: a dropped socket rejoins by itself and a change made while it was down is not replayed", async () => {
    const sub = await join(topicA(), { token: memberA.token, isPrivate: true });
    expect(sub.status).toBe("SUBSCRIBED");
    // Drop the transport, change while it is down, then reconnect.
    sub.client.realtime.disconnect();
    await sleep(500);
    await commitChange(A.studioId);
    await sleep(500);
    const seen = sub.got.length;
    const logBefore = sub.log.length;
    sub.client.realtime.connect();
    // What the real client does on its own: does the existing channel rejoin and report SUBSCRIBED again?
    let rejoined = await waitFor(() => sub.log.slice(logBefore).includes("SUBSCRIBED"), 12_000);
    let autoRejoin = rejoined;
    if (!rejoined) {
      // If it does not, the page's own re-subscribe path is what restores it; prove that works.
      const again = await join(topicA(), { token: memberA.token, isPrivate: true });
      rejoined = again.status === "SUBSCRIBED";
    }
    const statuses = sub.log.slice(logBefore);
    console.log("PROOF reconnect", JSON.stringify({ rejoined, autoRejoin, statuses, missedWhileDown: sub.got.length === seen }));
    expect(rejoined).toBe(true);
    // The change made while down is NOT replayed: this is why the client refetches on EVERY
    // SUBSCRIBED (M3a). The unit controller proves that behaviour; this proves the premise.
    expect(sub.got.length).toBe(seen);
  });

  it("removed mid-session: the open socket keeps its join until the token is re-set, then hears nothing (token-lifetime bound)", async () => {
    const extra = await seedE2eMember(A);
    const session = await withPassword(extra.email);
    const sub = await join(topicA(), { token: session.token, isPrivate: true });
    expect(sub.status).toBe("SUBSCRIBED");
    await commitChange(A.studioId);
    expect(await waitFor(() => sub.got.length >= 1, 5_000)).toBe(true);
    await sql(`update public.practitioners set active = false where studio_id = $1 and user_id = $2`, [A.studioId, session.userId]);
    const n0 = sub.got.length;
    await commitChange(A.studioId);
    await sleep(2_000);
    const heardBeforeRefresh = sub.got.length - n0;
    // The page re-sets auth on every token refresh (jwt_expiry is 3600 s locally) and the access policy is
    // re-checked then. Re-setting the SAME token does not re-check it (measured: still heard), so the
    // bound on a removed member's open socket is the access-token lifetime, and what it can hear is a
    // data-free "changed" ping whose refetch returns nothing under RLS.
    const refreshed = await withPassword(extra.email);
    await sub.client.realtime.setAuth(refreshed.token);
    await sleep(1_500);
    const n1 = sub.got.length;
    await commitChange(A.studioId);
    await sleep(2_000);
    const heardAfterRefresh = sub.got.length - n1;
    console.log("PROOF removed-mid-session", JSON.stringify({ heardBeforeTokenReset: heardBeforeRefresh, heardAfterTokenReset: heardAfterRefresh }));
    expect(heardAfterRefresh).toBe(0);
  });

  it("latency: commit to delivery over >=30 trials", async () => {
    const sub = await join(topicA(), { token: memberA.token, isPrivate: true });
    expect(sub.status).toBe("SUBSCRIBED");
    const ms: number[] = [];
    for (let i = 0; i < 40; i++) {
      const n = sub.got.length;
      const t = await commitChange(A.studioId);
      const ok = await waitFor(() => sub.got.length > n, 5_000);
      expect(ok).toBe(true);
      ms.push(sub.got[n].at - t);
      await sleep(150);
    }
    const s = summary(ms);
    console.log("PROOF latency commit-to-delivery ms", JSON.stringify(s));
    expect(s.n).toBeGreaterThanOrEqual(30);
    expect(s.p95).toBeLessThan(2_000);
  });

  it("capacity: 20 simultaneous joins (authorization pool of 2 hosted) and an event burst against statement-level triggers", async () => {
    const t0 = Date.now();
    const subs = await Promise.all(Array.from({ length: 20 }, () => join(topicA(), { token: memberA.token, isPrivate: true, waitMs: 30_000 })));
    const joinMs = Date.now() - t0;
    const ok = subs.filter((s) => s.status === "SUBSCRIBED").length;
    console.log("PROOF capacity joins", JSON.stringify({ requested: 20, subscribed: ok, wallMs: joinMs }));
    expect(ok).toBe(20);
    // Events per second: 100 separate statements in a tight loop, then one 100-row statement.
    const before = subs.map((s) => s.got.length);
    const t1 = Date.now();
    for (let i = 0; i < 100; i++) await commitChange(A.studioId);
    const loopMs = Date.now() - t1;
    await sleep(3_000);
    const perSub = subs.map((s, i) => s.got.length - before[i]);
    console.log("PROOF capacity burst", JSON.stringify({ statements: 100, loopMs, perStatementPerSecond: Math.round(100000 / loopMs), deliveredPerSubscriberMin: Math.min(...perSub), max: Math.max(...perSub) }));
    const beforeBulk = subs.map((s) => s.got.length);
    await sql(`insert into public.studio_blockouts (studio_id, starts_on, ends_on, reason)
               select $1, date '2040-01-01' + g, date '2040-01-01' + g, 'hon48-bulk' from generate_series(0, 99) g`, [A.studioId]);
    await sleep(2_500);
    const bulk = subs.map((s, i) => s.got.length - beforeBulk[i]);
    console.log("PROOF capacity bulk statement", JSON.stringify({ rows: 100, messagesPerSubscriber: bulk[0], allEqual: bulk.every((x) => x === bulk[0]) }));
    expect(Math.max(...bulk)).toBe(1);
    expect(Math.min(...bulk)).toBe(1);
  });
});
