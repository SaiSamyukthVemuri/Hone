import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ===========================================================================
// The encrypted-export tools (scripts/ops/logical-export.sh, object-export.sh,
// verify-export.sh, export-restore.sh, export-lib.sh). The REAL tools run here
// against SHIMS for pg_dump, psql, age and curl, so every gate in them executes
// without a database, a key or a network:
//   * the shim `age` copies stdin to the -o file (and `-d` cats it): the files
//     are not encrypted, but the tools' own plumbing, markers, gates, hashes and
//     refusals are the real ones;
//   * the shim `psql` speaks the one-session protocol the tools use;
//   * the shim `pg_dump` prints a fixture per part.
// What this CANNOT show (real age, real pg_dump --snapshot, a real Storage API)
// is exercised by the CI rehearsal, scripts/ops/export-rehearsal.sh.
//
// Every control below is a NEGATIVE one first: the gate must refuse, then the
// positive case must pass, so a green run means the gate can actually fail.
// ===========================================================================

const ROOT = process.cwd();
const OPS = path.join(ROOT, "scripts/ops");
const REF = "testref";
const DB_URL = `postgresql://u:p@db.${REF}.supabase.co:5432/postgres`;
const US = "\x1f";

let scratch: string;
let bin: string;

function write(file: string, body: string, mode = 0o644) {
  writeFileSync(file, body);
  chmodSync(file, mode);
}

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "export-tools-test-"));
  bin = path.join(scratch, "bin");
  mkdirSync(bin);
  write(
    path.join(bin, "age"),
    `#!/usr/bin/env bash
mode=enc; out=""; file=""
while [ $# -gt 0 ]; do case "$1" in -r) shift 2;; -o) out="$2"; shift 2;; -d) mode=dec; shift;; -i) shift 2;; *) file="$1"; shift;; esac; done
if [ "$mode" = enc ]; then cat >"$out"; else
  if [ -n "\${SHIM_AGE_WRONG_KEY:-}" ]; then echo "age: no identity matched" >&2; exit 1; fi
  cat "$file"; fi
`,
    0o755,
  );
  // pg_dump: a fixture per part, chosen by the arguments; the tools must pass --snapshot.
  write(
    path.join(bin, "pg_dump"),
    `#!/usr/bin/env bash
case " $* " in *" --snapshot="*) ;; *) echo "pg_dump called without --snapshot" >&2; exit 9;; esac
D="$SHIM_DUMP_DIR"
case " $* " in
  *" --schema-only "*) cat "$D/schema.sql";;
  *"--table=storage.buckets"*) cat "$D/storage.sql";;
  *"--schema=auth"*) cat "$D/auth.sql";;
  *"--schema=public"*) if [ -n "\${SHIM_NO_CLIENTS:-}" ]; then grep -v 'public.clients' "$D/public.sql" | grep -v '^Synthetic'; else cat "$D/public.sql"; fi;;
  *) echo "unexpected pg_dump args: $*" >&2; exit 9;;
esac
`,
    0o755,
  );
  // psql: the one-session protocol (begin; snapshot; one-line queries; EXPORT-EOF; commit).
  write(
    path.join(bin, "psql"),
    `#!/usr/bin/env bash
while IFS= read -r line; do
  [ -n "\${SHIM_PSQL_LOG:-}" ] && printf '%s\\n' "$line" >>"$SHIM_PSQL_LOG"
  case "$line" in
    begin*) echo BEGIN;;
    *pg_export_snapshot*) echo "00000003-00000002-1";;
    *EXPORT-EOF*) echo EXPORT-EOF;;
    *pg_stat_user_tables*) cat "$SHIM_DUMP_DIR/manifest.txt";;
    *rows_total=*) cat "$SHIM_DUMP_DIR/coverage.txt";;
    *"from storage.objects where bucket_id"*) cat "$SHIM_DUMP_DIR/list.txt";;
    commit*) echo COMMIT;;
  esac
done
`,
    0o755,
  );
  // curl: object bytes are a function of the URL; a match can fail or lie about its size.
  write(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
url=""; for a in "$@"; do case "$a" in http*) url="$a";; esac; done
if [ -n "\${SHIM_CURL_FAIL_MATCH:-}" ] && [[ "$url" == *"$SHIM_CURL_FAIL_MATCH"* ]]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi
if [ -n "\${SHIM_CURL_LIE_MATCH:-}" ] && [[ "$url" == *"$SHIM_CURL_LIE_MATCH"* ]]; then printf 'XX%s' "$url"; exit 0; fi
printf '%s' "$url"
`,
    0o755,
  );
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fixtures(name: string, opts: { withClients?: boolean } = {}) {
  const d = path.join(scratch, name);
  mkdirSync(d, { recursive: true });
  const withClients = opts.withClients ?? true;
  write(path.join(d, "public.sql"), `COPY public.studios (id) FROM stdin;\ns1\n\\.\n${withClients ? "COPY public.clients (id, name) FROM stdin;\nc1\tSynthetic Client\n\\.\n" : ""}`);
  write(path.join(d, "auth.sql"), "COPY auth.users (id) FROM stdin;\nu1\n\\.\nCOPY auth.identities (id) FROM stdin;\ni1\n\\.\n");
  write(path.join(d, "storage.sql"), "COPY storage.buckets (id) FROM stdin;\nb1\n\\.\nCOPY storage.objects (id) FROM stdin;\no1\n\\.\n");
  write(
    path.join(d, "schema.sql"),
    `CREATE TABLE public.studios (\n);\nCREATE TABLE public.clients (\n);\nCREATE TABLE auth.users (\n);\nCREATE TABLE auth.identities (\n);\nCREATE TABLE auth.schema_migrations (\n);\nCREATE TABLE storage.objects (\n);\n`,
  );
  write(path.join(d, "manifest.txt"), "public.clients rows=1 md5=aaa\nstorage.objects rows=1 md5=bbb\n");
  return d;
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [path.join(OPS, script), ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: scratch, ...env } as unknown as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

const LOGICAL_ARGS = (out: string) => ["--out", out, "--recipient", "age1testrecipient", "--expect-ref", REF];

describe("export-lib: the pure checks", () => {
  const lib = (body: string) =>
    spawnSync("bash", ["-c", `. ${path.join(OPS, "export-lib.sh")}; ${body}`], { encoding: "utf8" });

  it("host_of strips credentials, port and path", () => {
    expect(lib(`host_of '${DB_URL}'`).stdout).toBe(`db.${REF}.supabase.co`);
    expect(lib(`host_of 'https://${REF}.supabase.co/storage/v1'`).stdout).toBe(`${REF}.supabase.co`);
  });

  it("url_matches_ref: the host must name the typed ref; loopback only in rehearsal", () => {
    expect(lib(`url_matches_ref '${DB_URL}' ${REF}`).status).toBe(0);
    expect(lib(`url_matches_ref '${DB_URL}' otherref`).status).not.toBe(0);
    expect(lib(`url_matches_ref '${DB_URL}' ''`).status).not.toBe(0);
    expect(lib(`url_matches_ref 'postgresql://u:p@127.0.0.1:5432/x' ${REF}`).status).not.toBe(0);
    // Rehearsal accepts loopback only for the ONE ref it declares: any other typed ref is refused.
    expect(lib(`EXPORT_REHEARSAL=1; url_matches_ref 'postgresql://u:p@127.0.0.1:5432/x' ${REF}`).status).not.toBe(0);
    expect(lib(`EXPORT_REHEARSAL=1; EXPORT_REHEARSAL_REF=${REF}; url_matches_ref 'postgresql://u:p@127.0.0.1:5432/x' ${REF}`).status).toBe(0);
    expect(lib(`EXPORT_REHEARSAL=1; EXPORT_REHEARSAL_REF=${REF}; url_matches_ref 'postgresql://u:p@127.0.0.1:5432/x' wrongref`).status).not.toBe(0);
    // A non-loopback host that does not name the ref is refused in rehearsal exactly as in production (Codex P2).
    expect(lib(`EXPORT_REHEARSAL=1; EXPORT_REHEARSAL_REF=${REF}; url_matches_ref 'postgresql://u:p@db.other.example/x' ${REF}`).status).not.toBe(0);
    // A ref that only appears in the PATH or the password does not count.
    expect(lib(`url_matches_ref 'postgresql://u:${REF}@evil.example/${REF}' ${REF}`).status).not.toBe(0);
  });

  it("urlencode_path keeps '/', encodes spaces, '+' and non-ASCII", () => {
    expect(lib(`urlencode_path 'a b/c+d/é.png'`).stdout).toBe("a%20b/c%2Bd/%C3%A9.png");
  });

  it("gate_markers fails on a missing marker, a zero and a non-integer", () => {
    const d = path.join(scratch, "gm");
    mkdirSync(path.join(d, "markers"), { recursive: true });
    const set = (m: string, v: string) => writeFileSync(path.join(d, "markers", `${m}.count`), v);
    set("public-clients", "3\n"); set("auth-identities", "1\n");
    expect(lib(`gate_markers ${d}`).stdout).toContain("storage-objects is missing");
    set("storage-objects", "0\n");
    expect(lib(`gate_markers ${d}`).stdout).toContain("storage-objects is 0");
    set("storage-objects", "x\n");
    expect(lib(`gate_markers ${d}`).status).not.toBe(0);
    set("storage-objects", "2\n");
    expect(lib(`gate_markers ${d}`).status).toBe(0);
  });

  it("hash_record / hash_verify: a flipped byte is caught", () => {
    const d = path.join(scratch, "hv");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "a.age"), "ciphertext-a");
    writeFileSync(path.join(d, "b.age"), "ciphertext-b");
    expect(lib(`hash_record ${d}; hash_verify ${d}`).status).toBe(0);
    writeFileSync(path.join(d, "b.age"), "ciphertext-X");
    expect(lib(`hash_verify ${d}`).status).not.toBe(0);
  });

  it("compare_manifests: md5 differences fail; storage.objects compares by count only", () => {
    const a = path.join(scratch, "m1"), b = path.join(scratch, "m2"), c = path.join(scratch, "m3");
    writeFileSync(a, "public.clients rows=1 md5=aaa\nstorage.objects rows=3 md5=111\n");
    writeFileSync(b, "public.clients rows=1 md5=aaa\nstorage.objects rows=3 md5=222\n");
    writeFileSync(c, "public.clients rows=1 md5=zzz\nstorage.objects rows=3 md5=111\n");
    expect(lib(`compare_manifests ${a} ${b}`).status).toBe(0);
    expect(lib(`compare_manifests ${a} ${c}`).status).not.toBe(0);
    const d = path.join(scratch, "m4");
    writeFileSync(d, "public.clients rows=1 md5=aaa\nstorage.objects rows=4 md5=111\n");
    expect(lib(`compare_manifests ${a} ${d}`).status).not.toBe(0);
  });

  it("object_manifest_check: count, hash shape and index uniqueness", () => {
    const h = "a".repeat(64);
    const line = (i: number, hash = h, size = "10") => `00000${i}${US}p${i}${US}${size}${US}${hash}`;
    const f = path.join(scratch, "om");
    writeFileSync(f, `${line(0)}\n${line(1)}\n`);
    expect(lib(`object_manifest_check ${f} 2`).status).toBe(0);
    expect(lib(`object_manifest_check ${f} 3`).stdout).toContain("2 line(s), 3 object(s)");
    writeFileSync(f, `${line(0)}\n${line(1, "zz")}\n`);
    expect(lib(`object_manifest_check ${f} 2`).stdout).toContain("malformed");
    writeFileSync(f, `${line(0)}\n${line(0)}\n`);
    expect(lib(`object_manifest_check ${f} 2`).stdout).toContain("repeats an index");
  });
});

describe("logical-export.sh", () => {
  const env = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, EXPORT_REHEARSAL: "1", SHIM_DUMP_DIR: d, ...extra });

  it("NEGATIVE: refuses a connection string that does not name the typed ref", () => {
    const d = fixtures("lx-ref");
    const r = run("logical-export.sh", ["--out", path.join(scratch, "lx-ref-out"), "--recipient", "age1x", "--expect-ref", "someotherproject"], env(d));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not name project ref");
    expect(existsSync(path.join(scratch, "lx-ref-out", "public-data.sql.age"))).toBe(false);
  });

  it("NEGATIVE: the pg_dump/psql overrides are refused outside rehearsal; a secret set in the environment is refused too", () => {
    const lib = (body: string) => spawnSync("bash", ["-c", `. ${path.join(OPS, "export-lib.sh")}; ${body}`], { encoding: "utf8" });
    const ov = lib("EXPORT_PG_DUMP='pg_dump x'; export_configure_commands");
    expect(ov.status).not.toBe(0);
    expect(ov.stderr).toContain("rehearsal-only");
    expect(lib("EXPORT_REHEARSAL=1; DB_URL=u; EXPORT_PG_DUMP='pg_dump x'; export_configure_commands; echo ok").stdout).toContain("ok");
    const env2 = lib("DB_URL='postgresql://u:p@h/x'; secret_input DB_URL 'p: '");
    expect(env2.status).not.toBe(0);
    expect(env2.stderr).toContain("set in the environment");
    const rehearsal = lib("EXPORT_REHEARSAL=1; secret_input DB_URL 'p: '");
    expect(rehearsal.stderr).toContain("rehearsal needs DB_URL");
  });

  it("NEGATIVE: refuses a non-empty output directory and a non-public recipient", () => {
    const d = fixtures("lx-ne");
    const out = path.join(scratch, "lx-ne-out");
    mkdirSync(out); writeFileSync(path.join(out, "x"), "x");
    expect(run("logical-export.sh", LOGICAL_ARGS(out), env(d)).stderr).toContain("not empty");
    const r = run("logical-export.sh", ["--out", path.join(scratch, "lx-ne-2"), "--recipient", "AGE-SECRET-KEY-1abc", "--expect-ref", REF], env(d));
    expect(r.stderr).toContain("PUBLIC key");
  });

  it("NEGATIVE: public.clients missing from the dump fails the V3 gate and DISCARDS the export", () => {
    const d = fixtures("lx-nc", { withClients: false });
    const out = path.join(scratch, "lx-nc-out");
    const r = run("logical-export.sh", LOGICAL_ARGS(out), env(d));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("marker public-clients is 0");
    expect(r.stderr).toContain("COMPLETENESS GATE FAILED");
    expect(readdirSync(out, { recursive: true }).filter((f) => existsSync(path.join(out, String(f))) && !String(f).endsWith("markers"))).toEqual(
      expect.arrayContaining([]),
    );
    const left = (readdirSync(out, { recursive: true }) as string[]).filter((f) => !readdirSync(path.join(out), { withFileTypes: true }).some((e) => e.isDirectory() && e.name === f));
    expect(left).toEqual([]);
  });

  it("NEGATIVE: a table in the dump that the schema-only dump lacks (or the reverse) fails V3", () => {
    const d = fixtures("lx-tl");
    // schema-only knows public.clients; remove one table from the schema dump
    write(path.join(d, "schema.sql"), "CREATE TABLE public.studios (\n);\nCREATE TABLE auth.users (\n);\nCREATE TABLE auth.identities (\n);\n");
    const r = run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, "lx-tl-out")), env(d));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("public table list differs");
  });

  it("POSITIVE: a complete export writes encrypted parts, hashes and a receipt, and no plaintext dump", () => {
    const d = fixtures("lx-ok");
    const out = path.join(scratch, "lx-ok-out");
    const r = run("logical-export.sh", LOGICAL_ARGS(out), env(d));
    expect(r.stderr).toContain("PASS");
    expect(r.status).toBe(0);
    const files = (readdirSync(out) as string[]).sort();
    expect(files).toEqual(["auth-data.sql.age", "hashes.sha256", "manifest.age", "markers", "public-data.sql.age", "receipt.txt", "schema-only.sql.age", "storage-meta.sql.age"]);
    expect(readFileSync(path.join(out, "markers/public-clients.count"), "utf8").trim()).toBe("1");
    expect(readFileSync(path.join(out, "hashes.sha256"), "utf8").trim().split("\n")).toHaveLength(5);
    const receipt = readFileSync(path.join(out, "receipt.txt"), "utf8");
    expect(receipt).toContain("snapshot=00000003-00000002-1");
    expect(receipt).not.toMatch(/Synthetic Client|u:p@|postgresql:/);
    // nothing but the shim-"encrypted" parts holds row text; markers and receipt do not
    for (const f of ["markers/public.tables", "markers/auth.tables", "markers/public-clients.count", "receipt.txt"]) {
      expect(readFileSync(path.join(out, f), "utf8")).not.toContain("Synthetic Client");
    }
  });

  it("verify-export.sh: passes a good export, fails a flipped byte, a wrong key and a missing marker match", () => {
    const d = fixtures("lx-v");
    const out = path.join(scratch, "lx-v-out");
    expect(run("logical-export.sh", LOGICAL_ARGS(out), env(d)).status).toBe(0);
    const key = path.join(scratch, "key.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const ok = run("verify-export.sh", ["logical", out, "--identity", key]);
    expect(ok.stdout).toContain("VERIFY PASS");
    // flip one byte of a ciphertext: V1
    const part = path.join(out, "public-data.sql.age");
    writeFileSync(part, readFileSync(part, "utf8").replace("c1", "cX"));
    const bad = run("verify-export.sh", ["logical", out, "--identity", key]);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toContain("V1");
    // wrong key
    const wrong = run("verify-export.sh", ["logical", out, "--identity", key], { SHIM_AGE_WRONG_KEY: "1" });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stdout).toContain("VERIFY FAIL");
  });
});

describe("object-export.sh", () => {
  const sizeOf = (p: string) =>
    Buffer.byteLength(`https://${REF}.supabase.co/storage/v1/object/treatment-images/${p.split("/").map(encodeURIComponent).join("/")}`);
  const list = (paths: string[]) => paths.map((p) => `${p}${US}${sizeOf(p)}`).join("\n") + "\n";
  const OBJ_ARGS = (out: string) => ["--out", out, "--recipient", "age1testrecipient", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`, "--sample", "2"];
  const env = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, SERVICE_KEY: "shim-service-key", EXPORT_REHEARSAL: "1", SHIM_DUMP_DIR: d, ...extra });
  const prep = (name: string, paths: string[]) => {
    const d = fixtures(name);
    writeFileSync(path.join(d, "list.txt"), list(paths));
    writeFileSync(path.join(d, "coverage.txt"), `rows_total=${paths.length} rows_without_object=0 objects_total=${paths.length} objects_without_row=0\n`);
    return d;
  };

  it("NEGATIVE: outside rehearsal a secret already in the environment is refused, never used", () => {
    const d = prep("ox-key", ["s/c/a.png"]);
    const r = spawnSync("bash", [path.join(OPS, "object-export.sh"), ...OBJ_ARGS(path.join(scratch, "ox-key-out"))], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: scratch, DB_URL, SERVICE_KEY: "k", SHIM_DUMP_DIR: d } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is set in the environment");
  });

  it("NEGATIVE: a storage URL that does not name the typed ref is refused", () => {
    const d = prep("ox-url", ["s/c/a.png"]);
    const args = OBJ_ARGS(path.join(scratch, "ox-url-out")); args[args.indexOf("--storage-url") + 1] = "https://evil.example";
    const r = run("object-export.sh", args, env(d));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not name project ref");
  });

  it("NEGATIVE: an empty bucket is not a backup", () => {
    const d = prep("ox-empty", []);
    writeFileSync(path.join(d, "list.txt"), "");
    const r = run("object-export.sh", OBJ_ARGS(path.join(scratch, "ox-empty-out")), env(d));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("nothing to export");
  });

  it("NEGATIVE: an object that vanishes between listing and download fails the export", () => {
    const d = prep("ox-gone", ["s/c/a.png", "s/c/b.png", "s/c/c.png"]);
    const r = run("object-export.sh", OBJ_ARGS(path.join(scratch, "ox-gone-out")), env(d, { SHIM_CURL_FAIL_MATCH: "b.png" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not be downloaded");
  });

  it("NEGATIVE: a downloaded size that differs from the listed size fails", () => {
    const d = prep("ox-size", ["s/c/a.png", "s/c/b.png"]);
    const r = run("object-export.sh", OBJ_ARGS(path.join(scratch, "ox-size-out")), env(d, { SHIM_CURL_LIE_MATCH: "b.png" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/downloaded \d+ byte\(s\), the list says/);
  });

  it("POSITIVE: every object is encrypted by index, the manifest holds paths, and no path is a file name", () => {
    const paths = ["s1/c1/a b.png", "s1/c1/b+c.png", "s1/c1/a b.thumb.webp"];
    const d = prep("ox-ok", paths);
    const out = path.join(scratch, "ox-ok-out");
    const r = run("object-export.sh", OBJ_ARGS(out), env(d));
    expect(r.stderr).toContain("PASS: 3 object(s)");
    expect(r.status).toBe(0);
    expect((readdirSync(path.join(out, "objects")) as string[]).sort()).toEqual(["000000.age", "000001.age", "000002.age"]);
    expect(existsSync(path.join(out, "tmp"))).toBe(false);
    const names = (readdirSync(out, { recursive: true }) as string[]).join("\n");
    expect(names).not.toMatch(/s1|png|webp/);
    const manifest = readFileSync(path.join(out, "manifest.age"), "utf8");
    expect(manifest).toContain("count=3 total_bytes=");
    expect(readFileSync(path.join(out, "receipt.txt"), "utf8")).not.toMatch(/s1\/c1/);
    expect(readFileSync(path.join(out, "coverage.txt"), "utf8")).toContain("rows_without_object=0");
    // URL encoding reached the Storage API: a space is %20 and '+' is %2B
    // (the shim echoes the URL as the object body, which is hashed into the manifest).
    const key = path.join(scratch, "key2.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const v = run("verify-export.sh", ["objects", out, "--identity", key], env(d));
    expect(v.stdout).toContain("VERIFY PASS (objects)");
  });

  it("verify-export.sh objects: a flipped object byte and a deleted object file are both caught", () => {
    const d = prep("ox-v", ["s/c/a.png", "s/c/b.png"]);
    const out = path.join(scratch, "ox-v-out");
    expect(run("object-export.sh", OBJ_ARGS(out), env(d)).status).toBe(0);
    const key = path.join(scratch, "key3.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const obj = path.join(out, "objects/000001.age");
    const original = readFileSync(obj, "utf8");
    writeFileSync(obj, original.replace("b.png", "b.pnX"));
    const flipped = run("verify-export.sh", ["objects", out, "--identity", key]);
    expect(flipped.status).not.toBe(0);
    expect(flipped.stdout).toContain("V1");
    // Even with the hash file regenerated to match, the manifest hash catches it (V5).
    execFileSync("bash", ["-c", `cd ${out} && sha256sum -- manifest.age objects/*.age > hashes.sha256`]);
    const rehashed = run("verify-export.sh", ["objects", out, "--identity", key]);
    expect(rehashed.status).not.toBe(0);
    expect(rehashed.stdout).toContain("re-hashes differently");
    writeFileSync(obj, original);
    execFileSync("bash", ["-c", `cd ${out} && sha256sum -- manifest.age objects/*.age > hashes.sha256 && rm objects/000000.age`]);
    const missing = run("verify-export.sh", ["objects", out, "--identity", key]);
    expect(missing.status).not.toBe(0);
  });
});

describe("export-restore.sh never commits a truncation without its rows (Codex P1)", () => {
  it("NEGATIVE: a wrong identity stops BEFORE the database is touched; the session never sees a truncate or a commit", () => {
    const d = fixtures("rs-key");
    const out = path.join(scratch, "rs-key-out");
    expect(run("logical-export.sh", LOGICAL_ARGS(out), { DB_URL, EXPORT_REHEARSAL: "1", SHIM_DUMP_DIR: d }).status).toBe(0);
    const key = path.join(scratch, "key5.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const log = path.join(scratch, "rs-key-psql.log"); writeFileSync(log, "");
    const r = run("export-restore.sh", ["logical", out, "--identity", key, "--target-ref", REF, "--production-ref", "prod"], {
      DB_URL, EXPORT_REHEARSAL: "1", SHIM_DUMP_DIR: d, SHIM_AGE_WRONG_KEY: "1", SHIM_PSQL_LOG: log,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not decrypt");
    expect(readFileSync(log, "utf8")).not.toMatch(/truncate|commit/i);
  });

  it("NEGATIVE: a decryption that fails MID-LOAD sends ROLLBACK, never COMMIT", () => {
    const d = fixtures("rs-mid");
    const out = path.join(scratch, "rs-mid-out");
    expect(run("logical-export.sh", LOGICAL_ARGS(out), { DB_URL, EXPORT_REHEARSAL: "1", SHIM_DUMP_DIR: d }).status).toBe(0);
    const key = path.join(scratch, "key6.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    // the shim age fails only for the auth part, and only after the pre-flight (a counter file)
    const flaky = path.join(scratch, "flaky-bin"); mkdirSync(flaky, { recursive: true });
    write(path.join(flaky, "age"), `#!/usr/bin/env bash
file=""; while [ $# -gt 0 ]; do case "$1" in -d) shift;; -i) shift 2;; *) file="$1"; shift;; esac; done
n=$(cat "${path.join(scratch, "flaky.count")}" 2>/dev/null || echo 0)
case "$file" in *auth-data*) n=$((n + 1)); echo $n >"${path.join(scratch, "flaky.count")}"; if [ "$n" -ge 2 ]; then exit 1; fi;; esac
cat "$file"
`, 0o755);
    writeFileSync(path.join(scratch, "flaky.count"), "0");
    const log = path.join(scratch, "rs-mid-psql.log"); writeFileSync(log, "");
    const r = spawnSync("bash", [path.join(OPS, "export-restore.sh"), "logical", out, "--identity", key, "--target-ref", REF, "--production-ref", "prod"], {
      encoding: "utf8",
      env: { PATH: `${flaky}:${bin}:${process.env.PATH}`, HOME: scratch, DB_URL, EXPORT_REHEARSAL: "1", SHIM_DUMP_DIR: d, SHIM_PSQL_LOG: log } as unknown as NodeJS.ProcessEnv,
      timeout: 30_000,
    });
    const seen = readFileSync(log, "utf8");
    expect(seen).toMatch(/rollback/i);
    expect(seen).not.toMatch(/commit/i);
    expect(r.status === 0 ? "restore unexpectedly passed" : "refused").toBe("refused");
  });
});

describe("export-restore.sh refusals", () => {
  it("NEGATIVE: the target ref equal to production is refused, as is a target host naming production", () => {
    const d = path.join(scratch, "rs");
    mkdirSync(d, { recursive: true });
    const key = path.join(scratch, "key4.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const same = run("export-restore.sh", ["logical", d, "--identity", key, "--target-ref", REF, "--production-ref", REF], { DB_URL, EXPORT_REHEARSAL: "1" });
    expect(same.stderr).toContain("equals the production ref");
    const prodHost = run("export-restore.sh", ["logical", d, "--identity", key, "--target-ref", REF, "--production-ref", "db"], { DB_URL, EXPORT_REHEARSAL: "1" });
    expect(prodHost.stderr).toContain("names the PRODUCTION ref");
  });
});

describe("source contract: what the tools must never do", () => {
  const files = ["export-lib.sh", "logical-export.sh", "object-export.sh", "verify-export.sh", "export-restore.sh", "export-rehearsal.sh"];
  const src = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(OPS, f), "utf8")]));

  it("every tool is strict (set -euo pipefail) and sets a private umask", () => {
    for (const f of files.filter((x) => x !== "export-lib.sh")) {
      expect(src[f], f).toContain("set -euo pipefail");
    }
    for (const f of ["logical-export.sh", "object-export.sh", "verify-export.sh", "export-restore.sh"]) {
      expect(src[f], f).toContain("umask 077");
    }
  });

  it("no tool writes, echoes or logs a connection string or a key", () => {
    for (const f of files) {
      expect(src[f], f).not.toMatch(/(echo|printf)[^\n]*\$\{?(DB_URL|SERVICE_KEY)\b/);
      expect(src[f], f).not.toMatch(/(>|>>|tee)\s*[^\n|]*\$\{?(DB_URL|SERVICE_KEY)/);
    }
  });

  it("secrets are prompted, never read from an argument or file (and the prompt is hidden)", () => {
    expect(src["export-lib.sh"]).toContain("read -r -s");
    for (const f of ["logical-export.sh", "object-export.sh", "export-restore.sh"]) {
      expect(src[f], f).not.toMatch(/--(db-url|service-key|key)\)/);
    }
  });

  it("the rehearsal-only switches are all guarded by EXPORT_REHEARSAL=1", () => {
    expect(src["export-lib.sh"]).toMatch(/EXPORT_PG_DUMP:-\}\$\{EXPORT_PSQL:-\}" \] && \[ "\$\{EXPORT_REHEARSAL:-\}" != 1 \]/);
    expect(src["object-export.sh"]).toMatch(/\[ "\$\{EXPORT_REHEARSAL:-\}" = 1 \] && \[ -n "\$\{EXPORT_TEST_HOOK_AFTER_LIST:-\}" \]/);
    expect(src["export-lib.sh"]).toMatch(/EXPORT_REHEARSAL:-\}" = 1 \] && is_loopback_host "\$host" && \[ "\$ref" = "\$\{EXPORT_REHEARSAL_REF:-\}" \]/);
  });

  it("the three dump parts are separate pg_dump calls (--table overrides --schema) and use one snapshot", () => {
    const s = src["logical-export.sh"];
    expect(s).toContain("--data-only --schema=public");
    expect(s).toContain("--data-only --schema=auth --exclude-table=auth.schema_migrations");
    expect(s).toContain("--data-only --table=storage.buckets --table=storage.objects");
    expect(s).toContain('--snapshot="$SNAPSHOT_ID"');
    expect(s).not.toMatch(/pg_dumpall|--globals|--roles-only/);
  });

  it("the rehearsal workflow is not required, pinned, read-only and never uploads ciphertext", () => {
    const wf = readFileSync(path.join(ROOT, ".github/workflows/export-rehearsal.yml"), "utf8");
    expect(wf).toContain("(not required)");
    expect(wf).toContain("persist-credentials: false");
    expect(wf).toMatch(/permissions:\n  contents: read/);
    for (const m of wf.matchAll(/uses: ([^\s@]+)@([^\s]+)/g)) expect(m[2], m[0]).toMatch(/^[0-9a-f]{40}$/);
    expect(wf).toContain("export-evidence/");
    expect(wf).not.toMatch(/export-(logical|objects)/);
  });
});
