#!/usr/bin/env node
// Fingerprinted baseline of the migrated, seeded local database, for tests that are
// independent of the migration chain. See README.md. Usage:
//   node scripts/db-baseline/cli.mjs key
//   node scripts/db-baseline/cli.mjs build   --container supabase_db_<id>   (stack with the chain applied)
//   node scripts/db-baseline/cli.mjs seal    --container supabase_db_<id>   (a different, EMPTY stack)
//   node scripts/db-baseline/cli.mjs restore --container supabase_db_<id>   (an empty or used stack; DESTRUCTIVE)
// seal and restore drop schemas: they need the paired E2E_SUPABASE_URL + HONE_LOCAL_DB_URL of the stack you own, or
// --confirm-owned <project>; they refuse when DOCKER_HOST is set or the docker context is not local.
// Chain qualification (upgrade, rollback, migration-chain proofs) still uses a fresh
// `supabase db reset`; a baseline is only for independent app, DB and e2e tests.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_ALLOWED, DEFAULT_CACHE, DEFAULT_MIGRATIONS, DEFAULT_SEED, REPO_ROOT, computeKey, entryDir, lookup } from "./key.mjs";
import { cacheDirProblems, guardProblems, syntheticProblems } from "./guard.mjs";
import { ACL_SQL, EXTENSIONS_SQL, FINGERPRINT_SQL, RESET_SQL, TRIGGERS_SQL } from "./sql.mjs";
import { chainProblems, drift, parseFingerprint, summarise } from "./verify.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const cacheDir = opt("cache", DEFAULT_CACHE);
const container = opt("container");
const confirmOwned = opt("confirm-owned");
const inputs = { migrationsDir: opt("migrations", DEFAULT_MIGRATIONS), seedFile: opt("seed", DEFAULT_SEED), allowedFile: DEFAULT_ALLOWED };

const fail = (msg, code = 1) => {
  console.error(`baseline: ${msg}`);
  process.exit(code);
};
const now = () => Number(process.hrtime.bigint()) / 1e9;
// Every command that touches a container goes through here first. `destructive` commands (seal, restore) drop the public
// and supabase_migrations schemas of that stack, so they also need proof the stack is the caller's own.
const need = ({ destructive }) => {
  if (!container) fail("--container <database container name> is required");
  const ctx = spawnSync("docker", ["context", "show"], { encoding: "utf8" });
  const dockerContext = (ctx.stdout || "").trim();
  const ep = spawnSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", dockerContext || "default"], { encoding: "utf8" });
  const port = spawnSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" });
  const m = /:(\d+)\s*$/m.exec(port.stdout || "");
  const problems = guardProblems({ container, destructive, env: process.env, confirmOwned, dockerContext, contextEndpoint: (ep.stdout || "").trim(), publishedDbPort: m ? Number(m[1]) : undefined });
  if (problems.length) fail(`refused:\n  ${problems.join("\n  ")}`, 4);
};
const cacheOk = () => {
  const problems = cacheDirProblems(cacheDir, REPO_ROOT);
  if (problems.length) fail(`refused: ${problems.join("; ")}`, 4);
};

function docker(argv, { input, stdin, stdout } = {}) {
  const r = spawnSync("docker", argv, { input, stdio: [stdin ?? (input === undefined ? "ignore" : "pipe"), stdout ?? "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ? r.stdout.toString() : "", err: r.stderr ? r.stderr.toString() : "" };
}
function psql(sql, { single = false } = {}) {
  const r = docker(["exec", "-i", container, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", ...(single ? ["-1"] : []), "-f", "-"], { input: sql });
  if (r.code !== 0) fail(`psql failed: ${r.err.trim().slice(0, 400)}`);
  return r.out;
}
const fingerprint = () => parseFingerprint(psql(FINGERPRINT_SQL));

function restoreInto(dir) {
  const t0 = now();
  psql(RESET_SQL);
  psql(readFileSync(path.join(dir, "extensions.sql"), "utf8"));
  const dump = path.join(dir, "baseline.dump");
  // `pg_dump -n public` also emits CREATE SCHEMA public, which the reset already made.
  // Drop that entry (and the schema comment) from the list so the restore itself can be
  // run with --exit-on-error: any error is fatal, nothing is "ignored".
  const fdList = openSync(dump, "r");
  const list = docker(["exec", "-i", container, "pg_restore", "-l"], { stdin: fdList });
  closeSync(fdList);
  if (list.code !== 0) fail(`pg_restore -l failed: ${list.err.trim().slice(0, 300)}`);
  const kept = list.out.split("\n").filter((l) => !/^\d+; \d+ \d+ SCHEMA - public /.test(l) && !/ COMMENT - SCHEMA public /.test(l));
  const tocHost = path.join(tmpdir(), `hone-baseline-${process.pid}.toc`);
  const tocBox = `/tmp/hone-baseline-${process.pid}.toc`;
  writeFileSync(tocHost, kept.join("\n"));
  const cp = docker(["cp", tocHost, `${container}:${tocBox}`]);
  rmSync(tocHost, { force: true });
  if (cp.code !== 0) fail(`docker cp failed: ${cp.err.trim().slice(0, 300)}`);
  const fd = openSync(dump, "r");
  const res = docker(["exec", "-i", container, "pg_restore", "-U", "supabase_admin", "-d", "postgres", "-1", "--exit-on-error", "--no-acl", "-L", tocBox], { stdin: fd });
  closeSync(fd);
  docker(["exec", container, "rm", "-f", tocBox]);
  if (res.code !== 0) fail(`pg_restore failed: ${res.err.trim().slice(0, 600)}`);
  const t1 = now();
  psql(readFileSync(path.join(dir, "acl.sql"), "utf8"), { single: true });
  psql(readFileSync(path.join(dir, "triggers.sql"), "utf8"), { single: true });
  return { restoreSeconds: +(t1 - t0).toFixed(1), replaySeconds: +(now() - t1).toFixed(1) };
}

function wipe() {
  // A restore that did not verify leaves nothing usable behind.
  docker(["exec", "-i", container, "psql", "-U", "supabase_admin", "-d", "postgres", "-At", "-c", RESET_SQL]);
}

if (cmd === "key") {
  const k = computeKey(inputs);
  console.log(JSON.stringify({ key: k.key, migrationFiles: k.migrations.count, migrationsDigest: k.migrations.digest, seed: k.seed, sql: k.sql, allowed: k.allowed }, null, 2));
} else if (cmd === "build") {
  need({ destructive: false });
  cacheOk();
  const k = computeKey(inputs);
  const dir = entryDir(cacheDir, k.key);
  if (existsSync(dir)) fail(`an entry for key ${k.key.slice(0, 12)} already exists; entries are immutable (delete it deliberately to rebuild)`);
  // The source stack must hold EXACTLY this checkout's chain, applied from scratch.
  const versions = psql("select version from supabase_migrations.schema_migrations order by version;").split("\n").filter(Boolean);
  const files = readdirSync(inputs.migrationsDir).filter((n) => n.endsWith(".sql")).map((n) => n.split("_")[0]).sort();
  if (JSON.stringify(versions) !== JSON.stringify(files)) fail(`the stack's migration history (${versions.length}) is not this checkout's migration list (${files.length}); build only from a fresh \`supabase db reset\``);
  psql(readFileSync(inputs.seedFile, "utf8"));
  // Only synthetic, migration-seeded data may ever be cached.
  {
    const f = parseFingerprint(psql(FINGERPRINT_SQL));
    const rowCounts = Object.fromEntries(f.data.map((l) => [l.slice(0, l.lastIndexOf("=")), Number(l.slice(l.lastIndexOf("=") + 1))]));
    const problems = syntheticProblems({ authUsers: Number(f.authusers[0] ?? "NaN"), rowCounts, allowedSeeded: JSON.parse(readFileSync(inputs.allowedFile, "utf8")) });
    if (problems.length) fail(`build refused: the database is not synthetic:\n  ${problems.join("\n  ")}`, 5);
  }
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(cacheDir, 0o700);
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const chain = psql(FINGERPRINT_SQL);
  writeFileSync(path.join(partial, "chain-fingerprint.txt"), chain);
  writeFileSync(path.join(partial, "extensions.sql"), psql(EXTENSIONS_SQL));
  writeFileSync(path.join(partial, "triggers.sql"), psql(TRIGGERS_SQL));
  writeFileSync(path.join(partial, "acl.sql"), psql(ACL_SQL));
  const out = openSync(path.join(partial, "baseline.dump"), "w");
  const t0 = now();
  const d = docker(["exec", container, "pg_dump", "-U", "supabase_admin", "-d", "postgres", "-Fc", "-n", "public", "-n", "supabase_migrations"], { stdout: out });
  closeSync(out);
  if (d.code !== 0) fail(`pg_dump failed: ${d.err.trim().slice(0, 400)}`);
  writeFileSync(path.join(partial, "inputs.json"), JSON.stringify({ key: k.key, migrationFiles: k.migrations.count, migrationsDigest: k.migrations.digest, seed: k.seed, sql: k.sql, builtAt: new Date().toISOString(), dumpSeconds: +(now() - t0).toFixed(1), summary: summarise(parseFingerprint(chain)) }, null, 2));
  for (const f of readdirSync(partial)) chmodSync(path.join(partial, f), 0o444);
  renameSync(partial, dir);
  console.log(`baseline: built ${dir} (UNVERIFIED: run \`seal\` against an empty stack)`);
} else if (cmd === "seal") {
  need({ destructive: true });
  cacheOk();
  const k = computeKey(inputs);
  const dir = entryDir(cacheDir, k.key);
  if (!existsSync(dir)) fail(`no entry for key ${k.key.slice(0, 12)}; run build first`);
  if (existsSync(path.join(dir, "verified.json"))) fail("this entry is already sealed");
  const chain = parseFingerprint(readFileSync(path.join(dir, "chain-fingerprint.txt"), "utf8"));
  const timing = restoreInto(dir);
  const restoredText = psql(FINGERPRINT_SQL);
  const problems = chainProblems(chain, parseFingerprint(restoredText));
  if (problems.length) {
    wipe();
    fail(`the verification restore is not equivalent to the chain (${problems.length} problems):\n  ${problems.slice(0, 25).join("\n  ")}`);
  }
  chmodSync(dir, 0o755);
  writeFileSync(path.join(dir, "restored-fingerprint.txt"), restoredText);
  writeFileSync(path.join(dir, "verified.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), ...timing, summary: summarise(parseFingerprint(restoredText)) }, null, 2));
  for (const f of ["restored-fingerprint.txt", "verified.json"]) chmodSync(path.join(dir, f), 0o444);
  chmodSync(dir, 0o555);
  console.log(`baseline: sealed ${dir} ${JSON.stringify(timing)}`);
} else if (cmd === "restore") {
  need({ destructive: true });
  cacheOk();
  console.error("baseline: restore is DESTRUCTIVE: it drops the public and supabase_migrations schemas of this stack");
  const found = lookup(cacheDir, inputs);
  if (!found.ok) fail(found.reason, 3);
  const t0 = now();
  const timing = restoreInto(found.dir);
  const restored = parseFingerprint(psql(FINGERPRINT_SQL));
  const problems = [
    ...chainProblems(parseFingerprint(readFileSync(path.join(found.dir, "chain-fingerprint.txt"), "utf8")), restored),
    ...drift(parseFingerprint(readFileSync(path.join(found.dir, "restored-fingerprint.txt"), "utf8")), restored),
  ];
  if (problems.length) {
    wipe();
    fail(`restore REFUSED: the restored database does not match its fingerprints (${problems.length} problems; the database was cleared):\n  ${problems.slice(0, 25).join("\n  ")}`);
  }
  console.log(`baseline: restored and verified key ${found.key.slice(0, 12)} in ${(now() - t0).toFixed(1)}s ${JSON.stringify(timing)}`);
} else {
  fail("usage: cli.mjs key | build --container C | seal --container C | restore --container C [--cache DIR] [--migrations DIR] [--seed FILE]", 2);
}
