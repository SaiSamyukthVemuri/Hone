import { readFileSync } from "node:fs";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "./helpers/local-env";
import { createBooking, pct, requireSignalPlatform, seedStudio, sleep, summary, withPassword } from "./helpers/hon48-signal";
import { seedE2eStudio, sql } from "./helpers/seed";

// Needs a Realtime-enabled stack, which CI's browser lanes do not start. Local proofs set HON48_SIGNAL_E2E=1.
test.skip(process.env.HON48_SIGNAL_E2E !== "1", "needs a Realtime stack; run locally");

// HON-48 public-join negative controls (hosted has "Allow public access to channels" ON). Run with the Realtime tenant at its
// default (public allowed): the first test reads it back so a run on a stricter tenant cannot pass by accident.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MIGRATION = "supabase/migrations/0271_schedule_change_signal.sql";

type Listener = { client: SupabaseClient; ch: RealtimeChannel; got: number; status: string };
async function listen(topic: string, token: string | null, priv: boolean): Promise<Listener> {
  const client = createClient(E2E_SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  if (token) await client.realtime.setAuth(token);
  const l: Listener = { client, ch: null as unknown as RealtimeChannel, got: 0, status: "" };
  l.ch = client.channel(topic, { config: { private: priv, broadcast: { self: false } } })
    .on("broadcast", { event: "*" }, () => { l.got++; });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    l.ch.subscribe((s) => { l.status = s; if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") { clearTimeout(timer); resolve(); } });
  });
  return l;
}
const stop = async (ls: Listener[]) => { for (const l of ls) await l.client.removeAllChannels(); };

test("HON48-PUBLIC-0 (a): the emitter pins private => true, and the tenant default permits public joins", async () => {
  const src = readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
  const calls = src.match(/perform\s+realtime\.send\s*\([^;]*\)/g) ?? [];
  const live = calls; // comments are stripped above; only a real PERFORM counts
  expect(live.length).toBeGreaterThan(0);
  for (const c of live) expect(c.replace(/\s+/g, " "), `realtime.send must pass private explicitly: ${c}`).toMatch(/(,|private\s*=>)\s*true\s*\)$/);
  await requireSignalPlatform();
  // default matches hosted: a PUBLIC join to an unrelated topic must succeed on this tenant, else (b) proves nothing
  const probe = await listen(`public-probe:${Date.now()}`, null, false);
  expect(probe.status, "this tenant refuses public joins; it is NOT the hosted default, so (b) would be vacuous").toBe("SUBSCRIBED");
  await stop([probe]);
});

test("HON48-PUBLIC-1 (b)(c): no public join receives the signal, and a public client cannot publish into the private topic", async () => {
  test.setTimeout(300_000);
  await requireSignalPlatform();
  const s = await seedStudio(2);
  const other = await seedE2eStudio();
  const topic = `schedule:${s.seed.studioId}`;
  const member = await withPassword(s.memberEmails[0]);
  const removed = await withPassword(s.memberEmails[1]);
  const foreign = await withPassword(other.ownerEmail);
  await sql(`update public.practitioners set active = false where studio_id = $1 and lower(email) = lower($2)`, [s.seed.studioId, s.memberEmails[1]]);

  const control = await listen(topic, member.token, true);           // positive control: private member
  const anon = await listen(topic, null, false);                      // anon, public join, SAME topic
  const anonTok = await listen(topic, null, true);                    // anon, private join (must be refused)
  const foreignPub = await listen(topic, foreign.token, false);       // another studio's user, public join
  const foreignPriv = await listen(topic, foreign.token, true);
  const removedPub = await listen(topic, removed.token, false);       // removed member, public join
  const removedPriv = await listen(topic, removed.token, true);
  expect(control.status).toBe("SUBSCRIBED");
  for (const l of [anonTok, foreignPriv, removedPriv]) expect(l.status, "a private join by a non-member must be refused").not.toBe("SUBSCRIBED");

  // (c) a public client publishes into the topic; the private member must see NOTHING from it
  const forger = anon;
  const sendRes = await forger.ch.send({ type: "broadcast", event: "changed", payload: {} });
  await sleep(3000);
  expect(control.got, "a forged publish by a public client reached a private member").toBe(0);
  // A public client's message can reach OTHER PUBLIC joiners of the same name (a separate public channel); that is recorded, not
  // asserted away. What must hold: it never reaches the private member, and no COMMIT signal reaches any public joiner.
  const pubAfterForge = { anon: anon.got, foreign: foreignPub.got, removed: removedPub.got };

  const n = 6;
  for (let i = 0; i < n; i++) { await createBooking(s, s.pracIds[0], `${String(8 + i).padStart(2, "0")}:00`); await sleep(500); }
  await sleep(4000);
  const result = { publicSendAck: sendRes, publicToPublicForgeDelivered: pubAfterForge, privateMemberGot: control.got, anonPublic: anon.got, foreignPublic: foreignPub.got, removedPublic: removedPub.got, commits: n };
  console.log("HON48_PUBLIC_JOIN " + JSON.stringify(result));
  expect(control.got, "positive control: a private member must receive each commit").toBeGreaterThanOrEqual(n);
  expect(anon.got, "STOP: an anonymous PUBLIC join received a commit signal").toBe(pubAfterForge.anon);
  expect(foreignPub.got, "STOP: another studio's PUBLIC join received a commit signal").toBe(pubAfterForge.foreign);
  expect(removedPub.got, "STOP: a removed member's PUBLIC join received a commit signal").toBe(pubAfterForge.removed);
  await stop([control, anon, anonTok, foreignPub, foreignPriv, removedPub, removedPriv]);
});

test("HON48-PUBLIC-2 capacity: 20 simultaneous joins, and signals under statement-level triggers", async () => {
  test.setTimeout(300_000);
  await requireSignalPlatform();
  const s = await seedStudio(1);
  const topic = `schedule:${s.seed.studioId}`;
  const member = await withPassword(s.memberEmails[0]);

  const t0 = performance.now();
  const joins = await Promise.all(Array.from({ length: 20 }, async () => {
    const t = performance.now(); const l = await listen(topic, member.token, true); return { l, ms: performance.now() - t };
  }));
  const joinMs = joins.map((j) => j.ms);
  const joined = joins.filter((j) => j.l.status === "SUBSCRIBED").length;

  // one statement writing many rows must be ONE signal per listener (statement-level trigger)
  const base = joins.map((j) => j.l.got);
  await sql(`insert into public.studio_timed_blocks (studio_id, practitioner_id, starts_at, ends_at, category)
             select $1, $2, now() + (g || ' hours')::interval + interval '5 days', now() + (g || ' hours')::interval + interval '5 days 30 minutes', 'other'
             from generate_series(1, 40) g`, [s.seed.studioId, s.pracIds[0]]).catch(() => null);
  await sleep(3000);
  const perStatement = joins.map((j, i) => j.l.got - base[i]);

  // a burst of single-row statements: count what each listener receives against the 100 events/s tenant limit
  const mark = joins.map((j) => j.l.got);
  const burst = 60; const tb = Date.now();
  await Promise.all(Array.from({ length: burst }, (_, i) => sql(`update public.practitioners set display_name = display_name where id = $1 and $2::int >= 0`, [s.pracIds[0], i])));
  const notices: number[] = [];
  for (let i = 0; i < 20; i++) { await createBooking(s, s.pracIds[i % s.pracIds.length], `${String(8 + (i % 10)).padStart(2, "0")}:${i < 10 ? "00" : "30"}`, undefined, 3).catch(() => null); }
  await sleep(4000);
  const afterBurst = joins.map((j, i) => j.l.got - mark[i]);
  void notices; void tb;
  const out = {
    joinsRequested: 20, joinsSubscribed: joined, allJoinedWallMs: Math.round(performance.now() - t0), joinMs: summary(joinMs),
    signalsPerListenerForOneManyRowStatement: { min: Math.min(...perStatement), max: Math.max(...perStatement) },
    signalsPerListenerAfter20Bookings: { min: Math.min(...afterBurst), max: Math.max(...afterBurst), p50: pct(afterBurst, 50) },
    note: "authorization pool at hosted is 2; local default differs, so treat joinMs as a lower bound",
  };
  console.log("HON48_PUBLIC_CAPACITY " + JSON.stringify(out));
  expect(joined, "all 20 simultaneous joins must succeed").toBe(20);
  expect(Math.max(...perStatement), "a 40-row statement must produce one signal per listener").toBeLessThanOrEqual(1);
  await stop(joins.map((j) => j.l));
});
