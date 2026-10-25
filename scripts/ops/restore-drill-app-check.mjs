#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DR-01A: application readability after the restore drill.
//
// scripts/ops/restore-drill.sh proves the restored rows and object bytes are
// identical to the originals. This proves Hone can READ them: it starts the
// production build against the drill's project, signs in as the seeded
// synthetic practitioner and makes three reads through the real app:
//   1. /clients lists the seeded client;
//   2. /clients/<id>?tab=consultation renders the client's name and its
//      restored clinical note;
//   3. the app's signed-URL route signs one restored photo, and the bytes
//      behind that URL hash equal to the bytes the drill uploaded.
//
// Usage:
//   restore-drill-app-check.mjs build <api>
//       next build for the drill's API (run once, before the drill).
//   restore-drill-app-check.mjs <pre-restore|post-restore> <api> <evidence-dir>
//       the check; restore-drill.sh calls it through RESTORE_DRILL_APP_CHECK.
//
// Exit codes: 0 every read succeeded; 1 a read missed (the negative control's
// expected result, always preceded by an `app check MISS:` line naming each
// miss); 2 a harness error (no build, port in use, server down, ANY uncaught
// error). Node itself exits 1 on an uncaught throw, so the entry point at the
// bottom catches everything and maps it to 2: a crash must never read as a miss.
//
// Sign-in uses GoTrue's own magic-link token: the admin API issues it, and
// verifyOtp exchanges it for a session exactly as the emailed link would. Only
// the mail hop is skipped, because the drill runs no mail server.
//
// LOCAL AND SYNTHETIC ONLY. The API must be the drill's loopback stack, and the
// server gets a closed environment (below): every provider is a fake or unset.
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILD_STAMP = path.join(REPO_ROOT, ".next", "restore-drill-app.json");
const SENTRY_GUARD = path.join(REPO_ROOT, "e2e", "helpers", "sentry-egress-guard.cjs");
const APP_PORT = 3197;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const DRILL_API = "http://127.0.0.1:56521";

// Matches scripts/ops/restore-drill-seed.sql.
export const SEED = {
  email: "practitioner@restore-drill.invalid",
  clientId: "d0d0d0d0-0000-4000-8000-000000000002",
  clientName: "Synthetic Client Restore-Drill",
  note: "SYNTHETIC restore-drill note. Not a real person.",
  imageId: "d0d0d0d0-0000-4000-8000-000000000011",
  imageObject: "obj-1.bin", // its line in the drill's objects-before.sha256
};

export const MISS = 1;
export const HARNESS = 2;

/**
 * The Supabase CLI's PUBLIC default anon and service-role keys, read from the
 * one place the repository records them (e2e/helpers/local-env.ts). They must
 * be these exact keys, not ones freshly signed with the same secret: Kong
 * admits /auth/v1 and /rest/v1 only for its configured consumer keys.
 */
export function localDemoKeys(source = readFileSync(path.join(REPO_ROOT, "e2e", "helpers", "local-env.ts"), "utf8")) {
  const key = (name) => source.match(new RegExp(`const ${name} =\\s*"([A-Za-z0-9._-]+)"`))?.[1] ?? null;
  const anonKey = key("LOCAL_ANON_KEY");
  const serviceKey = key("LOCAL_SERVICE_ROLE_KEY");
  if (!anonKey || !serviceKey) throw new Error("the local demo keys were not found in e2e/helpers/local-env.ts");
  return { anonKey, serviceKey };
}

/**
 * The server's WHOLE environment. Nothing is inherited but PATH and HOME, so no
 * provider credential or deployed-runtime signal can reach it from the shell.
 * Values mirror e2e/helpers/local-env.ts (E2E_WEB_SERVER_ENV), except that
 * Twilio is UNSET: the fake Twilio egress (#1117) is not on this branch, so no
 * SMS path may be reachable at all. No Google credential is set.
 */
export function appEnv({ api, anonKey, serviceKey, egressLog, runId }) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: `--require ${SENTRY_GUARD}`,
    HONE_E2E_SENTRY_EGRESS_LOG: egressLog,
    HONE_E2E_FAKE_RESEND: "1",
    HONE_E2E_FAKE_RESEND_DEFAULT_MODE: "reject",
    RESEND_API_KEY: "re_dummy_resend_key",
    HONE_E2E_FAKE_STRIPE: "1",
    HONE_E2E_RUN_ID: runId,
    STRIPE_SECRET_KEY: "sk_test_dummy",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_dummy",
    STRIPE_WEBHOOK_SECRET: "whsec_dummy",
    STRIPE_ALLOW_LIVE_MODE: "false",
    PORT: String(APP_PORT),
    NEXT_PUBLIC_APP_ORIGIN: APP_ORIGIN,
    NEXT_PUBLIC_SUPABASE_URL: api,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    CRON_SECRET: "dummy-cron-secret",
    APPOINTMENT_SIGNING_SECRET: "dummy-appointment-signing-secret",
    INTAKE_SIGNING_SECRET: "dummy-intake-signing-secret",
    PORTAL_FINGERPRINT_SALT: "dummy-portal-fingerprint-salt-for-e2e",
  };
}

/** Provider wiring the server must NOT have, and the fakes it must. Empty = fenced. */
export function providerFenceViolations(env) {
  const bad = [];
  for (const k of Object.keys(env)) {
    if (/^TWILIO_/.test(k)) bad.push(`${k} is set (no SMS path may be reachable)`);
    if (/GOOGLE/.test(k)) bad.push(`${k} is set (no Google credential)`);
    if (/^(VERCEL|VERCEL_ENV|AWS_REGION|AWS_EXECUTION_ENV|KUBERNETES_SERVICE_HOST)$/.test(k)) bad.push(`${k} is a deployed-runtime signal`);
  }
  if (env.HONE_E2E_FAKE_RESEND !== "1") bad.push("fake Resend is not armed");
  if (env.HONE_E2E_FAKE_STRIPE !== "1" || !env.HONE_E2E_RUN_ID) bad.push("fake Stripe is not armed");
  if (!/^sk_test_/.test(env.STRIPE_SECRET_KEY ?? "")) bad.push("Stripe key is not a test key");
  if (!(env.NODE_OPTIONS ?? "").includes(SENTRY_GUARD)) bad.push("Sentry egress guard is not preloaded");
  if (!env.HONE_E2E_SENTRY_EGRESS_LOG) bad.push("Sentry egress guard has no log");
  for (const [k, v] of Object.entries(env)) {
    if (/supabase\.(co|com)/.test(v)) bad.push(`${k} names a hosted Supabase URL`);
  }
  return bad;
}

// --- the three reads, as pure checks over what the app returned -----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function clientListShowsClient(status, html) {
  if (status !== 200) return `GET /clients answered ${status}`;
  if (!html.includes(`href="/clients/${SEED.clientId}"`)) return "no link to the seeded client";
  if (!new RegExp(`>${escapeRe(SEED.clientName)}<`).test(html)) return "the seeded client's name is not rendered";
  return null;
}

export function recordRendersFields(status, html) {
  if (status !== 200) return `GET /clients/<id> answered ${status}`;
  if (!new RegExp(`<h1[^>]*>${escapeRe(SEED.clientName)}</h1>`).test(html)) return "the record heading is not the client's name";
  if (!new RegExp(`>${escapeRe(SEED.note)}<`).test(html)) return "the restored clinical note is not rendered";
  return null;
}

export function photoBytesMatch(signStatus, signedUrl, bytesStatus, bytes, expectedSha256) {
  if (signStatus !== 200 || typeof signedUrl !== "string") return `the signed-URL route answered ${signStatus}`;
  if (!signedUrl.startsWith(`${DRILL_API}/storage/v1/object/sign/`)) return "the signed URL is not the drill's storage";
  if (bytesStatus !== 200) return `the signed URL answered ${bytesStatus}`;
  const got = createHash("sha256").update(bytes).digest("hex");
  if (!expectedSha256 || got !== expectedSha256) return `photo sha256 ${got} != original ${expectedSha256 ?? "(unknown)"}`;
  return null;
}

/** The original hash of the object the check reads, from the drill's evidence. */
export function originalSha256(sha256File) {
  const line = readFileSync(sha256File, "utf8").split("\n").find((l) => l.endsWith(`  ${SEED.imageObject}`));
  return line ? line.split(" ")[0] : null;
}

/** Sentry guard records that are anything but contained (sink or refusal). */
export function uncontainedSentryRecords(logText) {
  return logText.split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => !["envelope", "refused", "sink-error"].includes(r.kind));
}

// --- sign-in ----------------------------------------------------------------
export async function signIn(api, anonKey, serviceKey) {
  const res = await fetch(`${api}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email: SEED.email }),
  });
  if (!res.ok) return { error: `generate_link answered ${res.status}` };
  const link = await res.json();
  const { createServerClient } = await import("@supabase/ssr");
  const jar = new Map();
  const supabase = createServerClient(api, anonKey, {
    // supabase-js builds a realtime client on construction, and on Node 20 (the
    // version ci.yml pins) that throws without a WebSocket. This check never
    // subscribes, so a transport that is never constructed is enough; adding
    // the `ws` package would be a dependency change for no behaviour.
    realtime: { transport: class NoRealtime {} },
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { data, error } = await supabase.auth.verifyOtp({
    type: link.verification_type ?? "magiclink",
    token_hash: link.hashed_token,
  });
  if (error || !data.session) return { error: `verifyOtp: ${error?.message ?? "no session"}` };
  if (jar.size === 0) return { error: "no session cookie was written" };
  return { cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") };
}

// --- harness ----------------------------------------------------------------
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(true));
  });
}

function run(cmd, args, env, logFile) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => out.push(d));
    child.on("close", (code) => {
      if (logFile) writeFileSync(logFile, Buffer.concat(out));
      resolve(code);
    });
  });
}

async function build(api) {
  if (api !== DRILL_API) return fail(HARNESS, `refusing: the API must be the drill's ${DRILL_API}`);
  const stamp = { api, runId: `drill-${randomUUID().slice(0, 12)}` };
  const env = appEnv({ ...stamp, ...localDemoKeys(), egressLog: path.join(tmpdir(), `restore-drill-build-egress-${process.pid}.jsonl`) });
  const violations = providerFenceViolations(env);
  if (violations.length) return fail(HARNESS, `provider fence: ${violations.join("; ")}`);
  const code = await run(path.join(REPO_ROOT, "node_modules", ".bin", "next"), ["build"], env, null);
  if (code !== 0) return fail(HARNESS, `next build exited ${code}`);
  writeFileSync(BUILD_STAMP, JSON.stringify(stamp));
  console.log(`built for ${api}`);
  return 0;
}

async function check(phase, api, evidence) {
  if (api !== DRILL_API) return fail(HARNESS, `refusing: the API must be the drill's ${DRILL_API}`);
  if (!existsSync(BUILD_STAMP)) return fail(HARNESS, "no build: run `restore-drill-app-check.mjs build` first");
  const stamp = JSON.parse(readFileSync(BUILD_STAMP, "utf8"));
  if (stamp.api !== api) return fail(HARNESS, `the build is for ${stamp.api}, not ${api}`);
  if (!(await portFree(APP_PORT))) return fail(HARNESS, `port ${APP_PORT} is in use`);

  const { anonKey, serviceKey } = localDemoKeys();
  const egressLog = path.join(evidence, `sentry-egress-${phase}.jsonl`);
  const env = appEnv({ api, anonKey, serviceKey, egressLog, runId: stamp.runId });
  const violations = providerFenceViolations(env);
  if (violations.length) return fail(HARNESS, `provider fence: ${violations.join("; ")}`);
  console.log(`[${phase}] server env keys: ${Object.keys(env).sort().join(",")}`);

  const server = spawn(path.join(REPO_ROOT, "node_modules", ".bin", "next"), ["start", "-p", String(APP_PORT)], {
    cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const serverOut = [];
  server.stdout.on("data", (d) => serverOut.push(d));
  server.stderr.on("data", (d) => serverOut.push(d));
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        up = (await fetch(`${APP_ORIGIN}/login`, { redirect: "manual" })).status < 500;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!up) return fail(HARNESS, "the app server did not come up");

    const misses = [];
    const session = await signIn(api, anonKey, serviceKey);
    if (session.error) misses.push(`sign-in: ${session.error}`);
    const headers = session.cookie ? { cookie: session.cookie } : {};
    const get = (p) => fetch(`${APP_ORIGIN}${p}`, { headers, redirect: "manual" });

    const list = await get("/clients");
    const r1 = clientListShowsClient(list.status, await list.text());
    const record = await get(`/clients/${SEED.clientId}?tab=consultation`);
    const r2 = recordRendersFields(record.status, await record.text());
    const sign = await get(`/api/clients/${SEED.clientId}/images/${SEED.imageId}/signed-url?variant=original`);
    const signed = sign.headers.get("content-type")?.includes("json") ? await sign.json() : {};
    let r3;
    if (sign.status === 200 && typeof signed.url === "string" && signed.url.startsWith(`${DRILL_API}/`)) {
      const bytes = await fetch(signed.url);
      r3 = photoBytesMatch(sign.status, signed.url, bytes.status, Buffer.from(await bytes.arrayBuffer()),
        originalSha256(path.join(evidence, "objects-before.sha256")));
    } else {
      r3 = photoBytesMatch(sign.status, signed.url, 0, Buffer.alloc(0), null);
    }
    for (const [name, miss] of [["client list", r1], ["client record", r2], ["photo bytes", r3]]) {
      console.log(`[${phase}] ${name}: ${miss ? `MISS (${miss})` : "ok"}`);
      if (miss) misses.push(`${name}: ${miss}`);
    }

    const egress = existsSync(egressLog) ? readFileSync(egressLog, "utf8") : "";
    const uncontained = uncontainedSentryRecords(egress);
    console.log(`[${phase}] sentry guard: ${egress.split("\n").filter(Boolean).length} records, all contained: ${uncontained.length === 0}`);
    if (uncontained.length) return fail(HARNESS, `sentry guard recorded uncontained traffic: ${JSON.stringify(uncontained)}`);

    console.log(`[${phase}] reads ok: ${[r1, r2, r3].filter((m) => m === null).length}/3; sign-in: ${session.error ? "failed" : "ok"}`);
    return misses.length ? fail(MISS, misses.join("; ")) : 0;
  } finally {
    server.kill("SIGTERM");
    writeFileSync(path.join(evidence, `app-server-${phase}.log`), Buffer.concat(serverOut));
  }
}

function fail(code, message) {
  console.error(`app check ${code === MISS ? "MISS" : "HARNESS ERROR"}: ${message}`);
  return code;
}

/** Run one invocation: 0 ok, MISS (1) only from a returned read miss, HARNESS (2) for everything thrown. */
export async function main(argv) {
  const [phase, api, evidence] = argv;
  try {
    const code =
      phase === "build" ? await build(api)
        : phase === "pre-restore" || phase === "post-restore" ? await check(phase, api, evidence)
          : fail(HARNESS, "usage: restore-drill-app-check.mjs build <api> | <pre-restore|post-restore> <api> <evidence-dir>");
    return code;
  } catch (error) {
    return fail(HARNESS, `uncaught: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // A late rejection or throw outside main() must not fall back to Node's own exit 1.
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    process.on(event, (error) => {
      console.error(`app check HARNESS ERROR: ${event}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exit(HARNESS);
    });
  }
  process.exit(await main(process.argv.slice(2)));
}
