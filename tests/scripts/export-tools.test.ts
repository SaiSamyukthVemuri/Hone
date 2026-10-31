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
/** The content type the fixtures give each object: three types, so a restore that defaulted would be caught. */
const MIME_OF = (p: string) => (p.endsWith(".webp") ? "image/webp" : p.endsWith("b.png") ? "image/jpeg" : "image/png");

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
  // the operator's pinned Supabase root CA for verify-full (a synthetic placeholder: the shims never speak TLS)
  mkdirSync(path.join(scratch, ".postgresql"));
  writeFileSync(path.join(scratch, ".postgresql", "root.crt"), "synthetic-root-ca-placeholder\n");
  write(
    path.join(bin, "age"),
    `#!/usr/bin/env bash
mode=enc; out=""; file=""
while [ $# -gt 0 ]; do case "$1" in -r) shift 2;; -o) out="$2"; shift 2;; -d) mode=dec; shift;; -i) shift 2;; *) file="$1"; shift;; esac; done
if [ "$mode" = enc ]; then cat >"$out"; else
  if [ -n "\${SHIM_AGE_WRONG_KEY:-}" ]; then echo "age: no identity matched" >&2; exit 1; fi
  cat "$file"
  # a truncated or corrupt stream: real age emits what it could read, then fails (authentication / unexpected EOF)
  if [ -n "\${SHIM_AGE_TRUNCATED:-}" ] && [ "$(basename "$file")" = "$SHIM_AGE_TRUNCATED" ]; then echo "age: error: unexpected EOF" >&2; exit 1; fi
  fi
`,
    0o755,
  );
  // pg_dump: a fixture per part, chosen by the arguments; the tools must pass --snapshot.
  write(
    path.join(bin, "pg_dump"),
    `#!/usr/bin/env bash
if [ -n "\${SHIM_ARGV_LOG:-}" ]; then { printf 'pg_dump argv:'; printf ' [%s]' "$@"; printf '\\nPGPASSWORD=%s\\nPGSSLMODE=%s\\nPGPASSFILE=%s\\n' "\${PGPASSWORD:-}" "\${PGSSLMODE:-}" "\${PGPASSFILE:-}"; } >>"$SHIM_ARGV_LOG"; fi
case " $* " in *" --snapshot="*) ;; *) echo "pg_dump called without --snapshot" >&2; exit 9;; esac
D="$SHIM_DUMP_DIR"
case " $* " in
  *" --schema-only "*) cat "$D/schema.sql";;
  *"--table=storage.buckets"*) cat "$D/storage.sql";;
  *"--schema=auth"*) if [ -n "\${SHIM_PG_DUMP_DIES_IN_AUTH:-}" ]; then head -n 2 "$D/auth.sql"; echo "pg_dump: error: connection to server was lost" >&2; exit 3; fi; cat "$D/auth.sql";;
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
if [ -n "\${SHIM_ARGV_LOG:-}" ]; then { printf 'psql argv:'; printf ' [%s]' "$@"; printf '\\nPGPASSWORD=%s\\nPGSSLMODE=%s\\nPGPASSFILE=%s\\n' "\${PGPASSWORD:-}" "\${PGSSLMODE:-}" "\${PGPASSFILE:-}"; } >>"$SHIM_ARGV_LOG"; fi
eofs=0
while IFS= read -r line; do
  [ -n "\${SHIM_PSQL_LOG:-}" ] && printf '%s\\n' "$line" >>"$SHIM_PSQL_LOG"
  case "$line" in
    begin*) echo BEGIN;;
    *pg_export_snapshot*) echo "00000003-00000002-1";;
    *EXPORT-EOF*) echo EXPORT-EOF; eofs=$((eofs + 1)); [ -n "\${SHIM_PSQL_EXIT_AFTER_EOF:-}" ] && [ "$eofs" -ge "$SHIM_PSQL_EXIT_AFTER_EOF" ] && exit 0;;
    *pg_stat_user_tables*) cat "$SHIM_DUMP_DIR/manifest.txt";;
    *"bucket_id || '|'"*) if [ -n "\${SHIM_WORK_PROBE:-}" ]; then { for w in "\${XDG_RUNTIME_DIR:-/nonexistent}"/export-work.*; do [ -d "$w" ] && { printf 'workdir-mode=%s\\n' "$(stat -c %a "$w")"; ls "$w"; grep -l 's/c/' "$w"/* 2>/dev/null | wc -l | sed 's/^/files-with-object-paths=/'; }; done; ls "\${TMPDIR:-/tmp}" | wc -l | sed 's/^/default-tmp-entries=/'; } >>"$SHIM_WORK_PROBE"; fi; cat "\${SHIM_PROJECTION:-/dev/null}";;
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
case " $* " in *" --data-binary @- "*) cat >/dev/null;; esac   # drain the body like the real curl, or the writer gets SIGPIPE
if [ -n "\${SHIM_ARGV_LOG:-}" ]; then
  { printf 'curl argv:'; printf ' [%s]' "$@"; printf '\\n'; } >>"$SHIM_ARGV_LOG"
  for a in "$@"; do case "$a" in @*) printf 'header-file=%s\\n' "\${a#@}" >>"$SHIM_ARGV_LOG"; [ -f "\${a#@}" ] && { printf 'header-file-mode=%s\\n' "$(stat -c %a "\${a#@}")" >>"$SHIM_ARGV_LOG"; cat "\${a#@}" >>"$SHIM_ARGV_LOG"; };; esac; done
fi
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
    expect(lib(`EXPORT_REHEARSAL=1; GITHUB_ACTIONS=true; url_matches_ref 'postgresql://u:p@127.0.0.1:5432/x' ${REF}`).status).not.toBe(0);
    expect(lib(`EXPORT_REHEARSAL=1; GITHUB_ACTIONS=true; EXPORT_REHEARSAL_REF=${REF}; url_matches_ref 'postgresql://u:p@127.0.0.1:5432/x' ${REF}`).status).toBe(0);
    expect(lib(`EXPORT_REHEARSAL=1; GITHUB_ACTIONS=true; EXPORT_REHEARSAL_REF=${REF}; url_matches_ref 'postgresql://u:p@127.0.0.1:5432/x' wrongref`).status).not.toBe(0);
    // A non-loopback host that does not name the ref is refused in rehearsal exactly as in production (Codex P2).
    expect(lib(`EXPORT_REHEARSAL=1; GITHUB_ACTIONS=true; EXPORT_REHEARSAL_REF=${REF}; url_matches_ref 'postgresql://u:p@db.other.example/x' ${REF}`).status).not.toBe(0);
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
    const line = (i: number, hash = h, size = "10", mime = "image/png") => `00000${i}${US}p${i}${US}${size}${US}${hash}${US}${mime}`;
    const f = path.join(scratch, "om");
    writeFileSync(f, `${line(0)}\n${line(1)}\n`);
    expect(lib(`object_manifest_check ${f} 2`).status).toBe(0);
    expect(lib(`object_manifest_check ${f} 3`).stdout).toContain("2 line(s), 3 object(s)");
    writeFileSync(f, `${line(0)}\n${line(1, "zz")}\n`);
    expect(lib(`object_manifest_check ${f} 2`).stdout).toContain("malformed");
    writeFileSync(f, `${line(0)}\n${line(0)}\n`);
    expect(lib(`object_manifest_check ${f} 2`).stdout).toContain("repeats an index");
    // five fields with a real type/subtype; a missing, empty or malformed content type is malformed
    writeFileSync(f, `${line(0)}\n${line(1, h, "10", "image/webp")}\n`);
    expect(lib(`object_manifest_check ${f} 2`).status).toBe(0);
    for (const bad of ["", "png", "image/", "Image/PNG", "image/png; charset=x"]) {
      writeFileSync(f, `${line(0)}\n${line(1, h, "10", bad)}\n`);
      expect(lib(`object_manifest_check ${f} 2`).stdout, bad).toContain("malformed");
    }
    writeFileSync(f, `0000000${US}p${US}10${US}${h}\n0000001${US}p${US}10${US}${h}\n`);   // the old four-field line
    expect(lib(`object_manifest_check ${f} 2`).stdout).toContain("malformed");
  });
});

describe("logical-export.sh", () => {
  const env = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, ...extra });

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
    expect(ov.stderr).toContain("exist only for the CI rehearsal");
    expect(
      lib("EXPORT_REHEARSAL=1; GITHUB_ACTIONS=true; EXPORT_REHEARSAL_REF=testref; DB_URL=postgresql://u@127.0.0.1:5432/postgres; EXPORT_PG_DUMP='docker exec -i supabase_db_testref pg_dump -U postgres -d postgres'; export_configure_commands; echo ok").stdout,
    ).toContain("ok");
    const env2 = lib("DB_URL='postgresql://u:p@h/x'; secret_input DB_URL 'p: '");
    expect(env2.status).not.toBe(0);
    expect(env2.stderr).toContain("set in the environment");
    const rehearsal = lib("EXPORT_REHEARSAL=1; GITHUB_ACTIONS=true; secret_input DB_URL 'p: '");
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
    // L3: the failed export leaves NO output directory behind at all.
    expect(existsSync(out)).toBe(false);
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
  const list = (paths: string[]) => paths.map((p) => `${p}${US}${sizeOf(p)}${US}${MIME_OF(p)}`).join("\n") + "\n";
  const OBJ_ARGS = (out: string) => ["--out", out, "--recipient", "age1testrecipient", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`, "--sample", "2"];
  const env = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, SERVICE_KEY: "shim-service-key", EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, ...extra });
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
    expect(run("logical-export.sh", LOGICAL_ARGS(out), { DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d }).status).toBe(0);
    const key = path.join(scratch, "key5.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const log = path.join(scratch, "rs-key-psql.log"); writeFileSync(log, "");
    const r = run("export-restore.sh", ["logical", out, "--identity", key, "--target-ref", REF, "--production-ref", "prod"], {
      DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, SHIM_AGE_WRONG_KEY: "1", SHIM_PSQL_LOG: log,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not decrypt");
    expect(readFileSync(log, "utf8")).not.toMatch(/truncate|commit/i);
  });

  it("NEGATIVE: a decryption that fails MID-LOAD sends ROLLBACK, never COMMIT", () => {
    const d = fixtures("rs-mid");
    const out = path.join(scratch, "rs-mid-out");
    expect(run("logical-export.sh", LOGICAL_ARGS(out), { DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d }).status).toBe(0);
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
      env: { PATH: `${flaky}:${bin}:${process.env.PATH}`, HOME: scratch, DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, SHIM_PSQL_LOG: log } as unknown as NodeJS.ProcessEnv,
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
    const same = run("export-restore.sh", ["logical", d, "--identity", key, "--target-ref", REF, "--production-ref", REF], { DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true" });
    expect(same.stderr).toContain("equals the production ref");
    const prodHost = run("export-restore.sh", ["logical", d, "--identity", key, "--target-ref", REF, "--production-ref", "db"], { DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true" });
    expect(prodHost.stderr).toContain("names the PRODUCTION ref");
  });
});

describe("Privacy PEER-1155: rehearsal is CI-only, no secret in argv, ref checks, partial output", () => {
  const ciEnv = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, ...extra });

  it("M1 NEGATIVE: EXPORT_REHEARSAL=1 without GITHUB_ACTIONS is refused by every tool, and so is any rehearsal-only variable alone", () => {
    const d = fixtures("m1fx");
    const key = path.join(scratch, "key7.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const noCi = { DB_URL, SERVICE_KEY: "k", EXPORT_REHEARSAL: "1", SHIM_DUMP_DIR: d };
    const runs = [
      run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, "m1-a")), noCi),
      run("object-export.sh", ["--out", path.join(scratch, "m1-b"), "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`], noCi),
      run("export-restore.sh", ["logical", d, "--identity", key, "--target-ref", REF, "--production-ref", "prod"], noCi),
    ];
    for (const r of runs) {
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("exist only for the CI rehearsal");
    }
    // each rehearsal-only variable on its own (no EXPORT_REHEARSAL at all) is refused too
    for (const v of ["EXPORT_PSQL", "EXPORT_PG_DUMP", "EXPORT_TEST_HOOK_AFTER_LIST", "EXPORT_REHEARSAL_REF"]) {
      const r = run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, `m1-${v}`)), { DB_URL: DB_URL, SHIM_DUMP_DIR: d, [v]: "docker exec -i x psql" });
      expect(r.status, v).not.toBe(0);
      expect(r.stderr, v).toContain("exist only for the CI rehearsal");
    }
    // a value other than 1 is refused too
    const odd = run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, "m1-odd")), { DB_URL, SHIM_DUMP_DIR: d, EXPORT_REHEARSAL: "true", GITHUB_ACTIONS: "true" });
    expect(odd.stderr).toContain("exist only for the CI rehearsal");
  });

  it("M1 NEGATIVE: an override may only be docker exec -i supabase_db_<rehearsal ref> psql|pg_dump -U postgres -d postgres", () => {
    const lib = (body: string) => spawnSync("bash", ["-c", `. ${path.join(OPS, "export-lib.sh")}; EXPORT_REHEARSAL_REF=${REF}; ${body}`], { encoding: "utf8" });
    const ok = (tool: string, cmd: string) => lib(`rehearsal_override_ok ${tool} ${cmd}`).status === 0;
    const base = `docker exec -i supabase_db_${REF}`;
    expect(ok("psql", `${base} psql -U postgres -d postgres`)).toBe(true);
    expect(ok("pg_dump", `${base} pg_dump -U postgres -d postgres`)).toBe(true);
    expect(ok("pg_dump", `${base} pg_dump -U postgres -d postgres --exclude-table=public.clients`)).toBe(true);
    for (const bad of [
      `docker exec -i supabase_db_other psql -U postgres -d postgres`,        // another container
      `${base} psql -h prod.example -U postgres -d postgres`,                  // another host
      `${base} psql -U postgres -d postgres -c "drop table x"`,               // extra arguments
      `${base} psql -U postgres -d postgres --exclude-table=x`,                // pg_dump-only option on psql
      `docker exec -e PGHOST=prod -i supabase_db_${REF} psql -U postgres -d postgres`, // environment injection
      `docker run -i supabase_db_${REF} psql -U postgres -d postgres`,         // not exec
      `bash ${base} psql`,                                                      // a wrapper
      `/tmp/pgdump-wrapper.sh`,                                                 // a script
      `psql`,
    ]) {
      expect(ok("psql", bad), bad).toBe(false);
    }
    expect(lib("EXPORT_REHEARSAL_REF=; rehearsal_override_ok psql docker exec -i supabase_db_ psql -U postgres -d postgres").status).not.toBe(0);
    expect(ok("pg_dump", `${base} pg_dump -U postgres -d postgres --schema=public`)).toBe(false);
  });

  it("M1 NEGATIVE: an override naming another target is refused by the tool itself", () => {
    const d = fixtures("m1-ov");
    const r = run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, "m1-ov-out")), ciEnv(d, { EXPORT_REHEARSAL_REF: REF, EXPORT_PSQL: "docker exec -i supabase_db_prod psql -U postgres -d postgres" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not the allow-listed rehearsal form");
  });

  it("M2: psql and pg_dump get the connection string WITHOUT its password; the password is PGPASSWORD in the child only", () => {
    const d = fixtures("m2-pw");
    const log = path.join(scratch, "m2-pw-argv.log"); writeFileSync(log, "");
    const withPw = `postgresql://u:s3kr%40t@db.${REF}.supabase.co:5432/postgres`;
    const r = run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, "m2-pw-out")), ciEnv(d, { DB_URL: withPw, SHIM_ARGV_LOG: log }));
    expect(r.status, r.stderr).toBe(0);
    const argv = readFileSync(log, "utf8");
    expect(argv).toContain("psql argv:");
    expect(argv).toContain("pg_dump argv:");
    // no argument carries the password in any form
    for (const line of argv.split("\n").filter((l) => /argv:/.test(l))) {
      expect(line).not.toMatch(/s3kr|%40t/);
      expect(line).toContain(`[postgresql://u@db.${REF}.supabase.co:5432/postgres]`);
    }
    // the child's environment got the DECODED password
    expect(argv).toMatch(/PGPASSWORD=s3kr@t/);
    expect(r.stdout + r.stderr).not.toMatch(/s3kr/);
  });

  it("M2: curl gets the service-role key through a private 0600 header file, never an argument, and the file is removed", () => {
    const paths = ["s/c/a.png", "s/c/b.png"];
    const d = fixtures("m2-key");
    const enc = (p: string) => Buffer.byteLength(`https://${REF}.supabase.co/storage/v1/object/treatment-images/${p}`);
    writeFileSync(path.join(d, "list.txt"), paths.map((p) => `${p}${US}${enc(p)}${US}${MIME_OF(p)}`).join("\n") + "\n");
    writeFileSync(path.join(d, "coverage.txt"), "rows_total=2 rows_without_object=0 objects_total=2 objects_without_row=0\n");
    const log = path.join(scratch, "m2-key-argv.log"); writeFileSync(log, "");
    const KEYV = "service-key-ABCDEF-0123456789";
    const r = run("object-export.sh", ["--out", path.join(scratch, "m2-key-out"), "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`, "--sample", "1"], ciEnv(d, { SERVICE_KEY: KEYV, SHIM_ARGV_LOG: log }));
    expect(r.status, r.stderr).toBe(0);
    const argv = readFileSync(log, "utf8");
    for (const line of argv.split("\n").filter((l) => /^curl argv:/.test(l))) {
      expect(line).not.toContain(KEYV);
      expect(line).not.toMatch(/Bearer|apikey/i);
      expect(line).toMatch(/\[-H\] \[@\//);
    }
    expect(argv).toContain(`Authorization: Bearer ${KEYV}`);          // the file carried it
    expect(argv).toMatch(/header-file-mode=600/);
    const file = argv.split("\n").find((l) => l.startsWith("header-file="))!.slice("header-file=".length);
    expect(existsSync(file), "the header file is removed on exit").toBe(false);
    expect(r.stdout + r.stderr).not.toContain(KEYV);
  });

  it("L1: --production-ref must match supabase/.temp/project-ref when the checkout is linked", () => {
    const d = path.join(scratch, "l1"); mkdirSync(d, { recursive: true });
    const linkFile = path.join(scratch, "l1-project-ref"); writeFileSync(linkFile, "the-linked-ref\n");
    const key = path.join(scratch, "key8.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const args = (prod: string) => ["logical", d, "--identity", key, "--target-ref", REF, "--production-ref", prod];
    const bad = run("export-restore.sh", args("another-ref"), ciEnv(d, { EXPORT_PROJECT_REF_FILE: linkFile }));
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("--production-ref 'another-ref' does not match");
    // a matching ref is not refused for that reason (it fails later, on the empty export directory)
    const good = run("export-restore.sh", args("the-linked-ref"), ciEnv(d, { EXPORT_PROJECT_REF_FILE: linkFile }));
    expect(good.stderr).not.toContain("--production-ref");
    // no link file: no check
    const none = run("export-restore.sh", args("another-ref"), ciEnv(d, { EXPORT_PROJECT_REF_FILE: path.join(scratch, "no-such-file") }));
    expect(none.stderr).not.toContain("--production-ref");
  });

  it("L2: outside rehearsal the ref must be a whole host label, not a substring", () => {
    const lib = (body: string) => spawnSync("bash", ["-c", `. ${path.join(OPS, "export-lib.sh")}; ${body}`], { encoding: "utf8" });
    expect(lib(`url_matches_ref 'postgresql://u:p@db.${REF}.supabase.co/x' ${REF}`).status).toBe(0);
    expect(lib(`url_matches_ref 'https://${REF}.supabase.co' ${REF}`).status).toBe(0);
    for (const host of [`db.my${REF}.supabase.co`, `db.${REF}x.supabase.co`, `${REF}evil.example`, `evil-${REF}.example`]) {
      expect(lib(`url_matches_ref 'postgresql://u:p@${host}/x' ${REF}`).status, host).not.toBe(0);
    }
    // the substring was accepted before: prove the old rule would have passed these
    expect(`db.my${REF}.supabase.co`.includes(REF)).toBe(true);
  });

  it("L3: a failed export deletes its partial output; an existing EMPTY directory is emptied, not removed; a good export is kept", () => {
    const d = fixtures("l3", { withClients: false });
    const created = path.join(scratch, "l3-created");
    expect(run("logical-export.sh", LOGICAL_ARGS(created), ciEnv(d)).status).not.toBe(0);
    expect(existsSync(created)).toBe(false);
    const preexisting = path.join(scratch, "l3-pre"); mkdirSync(preexisting);
    expect(run("logical-export.sh", LOGICAL_ARGS(preexisting), ciEnv(d)).status).not.toBe(0);
    expect(existsSync(preexisting)).toBe(true);
    expect(readdirSync(preexisting)).toEqual([]);
    // a NON-empty directory is refused and left untouched
    const full = path.join(scratch, "l3-full"); mkdirSync(full); writeFileSync(path.join(full, "keep.txt"), "mine");
    expect(run("logical-export.sh", LOGICAL_ARGS(full), ciEnv(d)).status).not.toBe(0);
    expect(readFileSync(path.join(full, "keep.txt"), "utf8")).toBe("mine");
    // the object export: a vanished object leaves no directory
    const d2 = fixtures("l3-obj");
    const enc = (p: string) => Buffer.byteLength(`https://${REF}.supabase.co/storage/v1/object/treatment-images/${p}`);
    writeFileSync(path.join(d2, "list.txt"), ["s/c/a.png", "s/c/b.png"].map((p) => `${p}${US}${enc(p)}${US}${MIME_OF(p)}`).join("\n") + "\n");
    writeFileSync(path.join(d2, "coverage.txt"), "rows_total=2 rows_without_object=0 objects_total=2 objects_without_row=0\n");
    const objOut = path.join(scratch, "l3-objout");
    const r = run("object-export.sh", ["--out", objOut, "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`], ciEnv(d2, { SERVICE_KEY: "k", SHIM_CURL_FAIL_MATCH: "b.png" }));
    expect(r.status).not.toBe(0);
    expect(existsSync(objOut)).toBe(false);
    // and a good export keeps its output
    const ok = fixtures("l3-ok");
    const okOut = path.join(scratch, "l3-okout");
    expect(run("logical-export.sh", LOGICAL_ARGS(okOut), ciEnv(ok)).status).toBe(0);
    expect(existsSync(path.join(okOut, "receipt.txt"))).toBe(true);
  });
});

describe("Codex P2 4371111142: a failed manifest decryption never reads as an empty PASS", () => {
  const ciEnv = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, SERVICE_KEY: "k", EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, ...extra });
  const enc = (p: string) => Buffer.byteLength(`https://${REF}.supabase.co/storage/v1/object/treatment-images/${p}`);
  const PATHS = ["s/c/a.png", "s/c/b.png", "s/c/c.png"];
  /** A real object export (shims) and a key file; returns the export dir and the env pieces. */
  function exported(name: string) {
    const d = fixtures(name);
    writeFileSync(path.join(d, "list.txt"), PATHS.map((p) => `${p}${US}${enc(p)}${US}${MIME_OF(p)}`).join("\n") + "\n");
    writeFileSync(path.join(d, "coverage.txt"), "rows_total=3 rows_without_object=0 objects_total=3 objects_without_row=0\n");
    const out = path.join(scratch, `${name}-out`);
    const r = run("object-export.sh", ["--out", out, "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`], ciEnv(d));
    expect(r.status, r.stderr).toBe(0);
    const key = path.join(scratch, `${name}-key.txt`); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    return { d, out, key };
  }
  /** The target's storage.objects projection the restore reads back (bucket|name|size|mimetype), as a file for the shim. */
  const projection = (name: string, mime: (p: string) => string = MIME_OF) => {
    const file = path.join(scratch, `${name}-projection.txt`);
    writeFileSync(file, PATHS.map((p) => `treatment-images|${p}|${enc(p)}|${mime(p)}`).join("\n") + "\n");
    return file;
  };
  const restoreArgs = (out: string, key: string) => ["objects", out, "--identity", key, "--target-ref", REF, "--production-ref", "prod", "--storage-url", `https://${REF}.supabase.co`];
  const rehash = (out: string) => execFileSync("bash", ["-c", `cd ${out} && sha256sum -- manifest.age objects/*.age > hashes.sha256`]);
  const putCalls = (log: string) => (readFileSync(log, "utf8").match(/\[-X\] \[PUT\]/g) ?? []).length;

  it("NEGATIVE: a wrong identity fails the object restore (no PASS line, no upload)", () => {
    const { d, out, key } = exported("p2b-wrong");
    const log = path.join(scratch, "p2b-wrong.log"); writeFileSync(log, "");
    const r = run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_AGE_WRONG_KEY: "1", SHIM_ARGV_LOG: log }));
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain("RESTORE PASS");
    expect(r.stderr).toContain("does not decrypt manifest.age");
    expect(putCalls(log)).toBe(0);
  });

  it("POSITIVE control: the same export restores with the right identity, and the PASS names uploaded of declared", () => {
    const { d, out, key } = exported("p2b-ok");
    const log = path.join(scratch, "p2b-ok.log"); writeFileSync(log, "");
    const r = run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_ARGV_LOG: log, SHIM_PROJECTION: projection("p2b-ok") }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("RESTORE PASS (objects): 3 of 3 declared object(s)");
    expect(putCalls(log)).toBe(3);
  });

  it("NEGATIVE: a manifest that declares zero objects, or fewer lines than it declares, is refused before any upload", () => {
    for (const [label, manifest, want] of [
      ["zero", "manifest-version=2\ncount=0 total_bytes=0\n", "declares 0"],
      ["short", null, "lists 2 object(s) but declares 3"],
      ["nocount", "manifest-version=2\n", "declares no object count"],
    ] as const) {
      const { d, out, key } = exported(`p2b-${label}`);
      const m = path.join(out, "manifest.age");
      const lines = readFileSync(m, "utf8").split("\n").filter(Boolean);
      writeFileSync(m, manifest === null ? lines.filter((_, i) => i !== 1).join("\n") + "\n" : manifest);
      rehash(out);   // the hashes match the tampered files: only the manifest check can catch it
      const log = path.join(scratch, `p2b-${label}.log`); writeFileSync(log, "");
      const r = run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_ARGV_LOG: log }));
      expect(r.status, label).not.toBe(0);
      expect(r.stderr, label).toContain(want);
      expect(r.stdout + r.stderr, label).not.toContain("RESTORE PASS");
      expect(putCalls(log), label).toBe(0);
    }
  });

  it("NEGATIVE: an object that does not hash as its manifest line says stops the restore BEFORE the first upload", () => {
    const { d, out, key } = exported("p2b-pre");
    const obj = path.join(out, "objects/000002.age");
    writeFileSync(obj, readFileSync(obj, "utf8") + "x");
    rehash(out);
    const log = path.join(scratch, "p2b-pre.log"); writeFileSync(log, "");
    const r = run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_ARGV_LOG: log }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not hash as its manifest line says");
    expect(putCalls(log)).toBe(0);
  });

  it("verify-export.sh objects: a wrong identity is a V5 FAIL with no PASS line", () => {
    const { out, key } = exported("p2b-verify");
    const r = run("verify-export.sh", ["objects", out, "--identity", key], { SHIM_AGE_WRONG_KEY: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("V5: the identity does not decrypt manifest.age");
    expect(r.stdout).toContain("VERIFY FAIL");
    expect(r.stdout).not.toContain("VERIFY PASS");
  });

  it("the lib never reads a missing table list or manifest as an empty (equal) one", () => {
    const lib = (body: string) => spawnSync("bash", ["-c", `. ${path.join(OPS, "export-lib.sh")}; ${body}`], { encoding: "utf8" });
    const empty = path.join(scratch, "p2b-empty"); writeFileSync(empty, "");
    expect(lib(`tables_equal ${empty} ${path.join(scratch, "p2b-missing")}`).status).not.toBe(0);
    expect(lib(`compare_manifests ${empty} ${empty}`).status).not.toBe(0);
    expect(lib(`compare_manifests ${path.join(scratch, "p2b-missing")} ${empty}`).status).not.toBe(0);
  });
});

describe("Codex P2 4371272761: the restore keeps each object's content type, and verifies it", () => {
  const ciEnv = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, SERVICE_KEY: "k", EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, ...extra });
  const enc = (p: string) => Buffer.byteLength(`https://${REF}.supabase.co/storage/v1/object/treatment-images/${p}`);
  const PATHS = ["s/c/a.png", "s/c/b.png", "s/c/c.thumb.webp"];   // image/png, image/jpeg, image/webp
  const listWith = (mime: (p: string) => string) => PATHS.map((p) => `${p}${US}${enc(p)}${US}${mime(p)}`).join("\n") + "\n";
  function exported(name: string, mime: (p: string) => string = MIME_OF) {
    const d = fixtures(name);
    writeFileSync(path.join(d, "list.txt"), listWith(mime));
    writeFileSync(path.join(d, "coverage.txt"), "rows_total=3 rows_without_object=0 objects_total=3 objects_without_row=0\n");
    const out = path.join(scratch, `${name}-out`);
    const r = run("object-export.sh", ["--out", out, "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`], ciEnv(d));
    const key = path.join(scratch, `${name}-key.txt`); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    return { d, out, key, r };
  }
  const restoreArgs = (out: string, key: string) => ["objects", out, "--identity", key, "--target-ref", REF, "--production-ref", "prod", "--storage-url", `https://${REF}.supabase.co`];
  const proj = (name: string, mime: (p: string) => string) => {
    const file = path.join(scratch, `${name}-proj.txt`);
    writeFileSync(file, PATHS.map((p) => `treatment-images|${p}|${enc(p)}|${mime(p)}`).join("\n") + "\n");
    return file;
  };
  const rehash = (out: string) => execFileSync("bash", ["-c", `cd ${out} && sha256sum -- manifest.age objects/*.age > hashes.sha256`]);

  it("the export records manifest-version=2 and each object's own content type", () => {
    const { out, r } = exported("ct-manifest");
    expect(r.status, r.stderr).toBe(0);
    const lines = readFileSync(path.join(out, "manifest.age"), "utf8").split("\n").filter(Boolean);
    expect(lines[0]).toBe("manifest-version=2");
    const rows = lines.filter((l) => l.includes(US)).map((l) => l.split(US));
    expect(rows.map((c) => c.length)).toEqual([5, 5, 5]);
    expect(rows.map((c) => c[4])).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(lines[lines.length - 1]).toMatch(/^count=3 total_bytes=\d+$/);
  });

  it("NEGATIVE: an object with no content type is a refusal, not a silent default, and no output is left", () => {
    const { out, r } = exported("ct-missing", (p) => (p.endsWith("b.png") ? "" : MIME_OF(p)));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("has no content type");
    expect(r.stderr).not.toContain("s/c/b.png");
    expect(existsSync(out)).toBe(false);
    const odd = exported("ct-odd", (p) => (p.endsWith("b.png") ? "Image/PNG" : MIME_OF(p)));
    expect(odd.r.status).not.toBe(0);
    expect(odd.r.stderr).toContain("unsupported content type");
    expect(existsSync(odd.out)).toBe(false);
  });

  it("the restore uploads each object with ITS content type, never a default", () => {
    const { d, out, key, r } = exported("ct-restore");
    expect(r.status, r.stderr).toBe(0);
    const log = path.join(scratch, "ct-restore.log"); writeFileSync(log, "");
    const rr = run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_ARGV_LOG: log, SHIM_PROJECTION: proj("ct-restore", MIME_OF) }));
    expect(rr.status, rr.stderr).toBe(0);
    const puts = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("curl argv:") && l.includes("[-X] [PUT]"));
    expect(puts).toHaveLength(3);
    expect(puts.map((l) => /\[Content-Type: ([^\]]+)\]/.exec(l)?.[1])).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(puts.join("\n")).not.toContain("application/octet-stream");
  });

  it("NEGATIVE: a restored object whose type differs from the original fails verification (no PASS)", () => {
    const { d, out, key } = exported("ct-wrong");
    const wrong = proj("ct-wrong", (p) => (p.endsWith("b.png") ? "image/gif" : MIME_OF(p)));   // the target ended with another type
    const r = run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_PROJECTION: wrong }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("content type or size differs from the original");
    expect(r.stdout + r.stderr).not.toContain("RESTORE PASS");
    expect(r.stdout + r.stderr).not.toContain("s/c/b.png");   // the diff (which names paths) is never printed
    // the size too, and an extra object on the target
    const size = path.join(scratch, "ct-size-proj.txt");
    writeFileSync(size, PATHS.map((p) => `treatment-images|${p}|${enc(p) + 1}|${MIME_OF(p)}`).join("\n") + "\n");
    expect(run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_PROJECTION: size })).status).not.toBe(0);
    const extra = proj("ct-extra", MIME_OF);
    writeFileSync(extra, readFileSync(extra, "utf8") + `treatment-images|other|1|image/png\n`);
    expect(run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_PROJECTION: extra })).status).not.toBe(0);
    // an empty projection (the objects are not there at all) is not a pass either
    const none = path.join(scratch, "ct-none-proj.txt"); writeFileSync(none, "");
    expect(run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_PROJECTION: none })).status).not.toBe(0);
  });

  it("NEGATIVE: an old-format (version 1) manifest and an unknown version are refused by name, by the restore AND by verify", () => {
    for (const [label, rewrite, want] of [
      ["v1", (lines: string[]) => lines.filter((l) => !l.startsWith("manifest-version=")).map((l) => (l.includes(US) ? l.split(US).slice(0, 4).join(US) : l)), "old-format manifest"],
      ["v3", (lines: string[]) => lines.map((l) => l.replace("manifest-version=2", "manifest-version=3")), "unsupported manifest version '3'"],
    ] as const) {
      const { d, out, key } = exported(`ct-${label}`);
      const m = path.join(out, "manifest.age");
      writeFileSync(m, rewrite(readFileSync(m, "utf8").split("\n").filter(Boolean)).join("\n") + "\n");
      rehash(out);   // hashes match the rewritten file: only the version check can refuse it
      const log = path.join(scratch, `ct-${label}.log`); writeFileSync(log, "");
      const rr = run("export-restore.sh", restoreArgs(out, key), ciEnv(d, { SHIM_ARGV_LOG: log, SHIM_PROJECTION: proj(`ct-${label}`, MIME_OF) }));
      expect(rr.status, label).not.toBe(0);
      expect(rr.stderr, label).toContain(want);
      expect((readFileSync(log, "utf8").match(/\[-X\] \[PUT\]/g) ?? []).length, label).toBe(0);
      const v = run("verify-export.sh", ["objects", out, "--identity", key]);
      expect(v.status, label).not.toBe(0);
      expect(v.stdout, label).toContain(want);
      expect(v.stdout, label).not.toContain("VERIFY PASS");
    }
  });
});

describe("Codex P2 4371272758: the snapshot coprocess may exit before it is closed", () => {
  const ciEnv = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, SERVICE_KEY: "k", EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, ...extra });

  it("RED control: closing a coprocess that already exited, the OLD way, aborts under set -u", () => {
    const script = `set -euo pipefail
coproc P { while IFS= read -r l; do echo "$l"; [ "$l" = go ] && exit 0; done; }
printf 'go\\n' >&"\${P[1]}"
IFS= read -r -u "\${P[0]}" x
sleep 0.3
printf 'commit\\n' >&"\${P[1]}" 2>/dev/null || true
eval "exec \${P[1]}>&-" 2>/dev/null || true
wait "$P_PID" 2>/dev/null || true
echo survived`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(r.stdout).not.toContain("survived");
    expect(r.stderr).toMatch(/unbound variable/);
    expect(r.status).not.toBe(0);
  });

  it("GREEN: the logical export completes and writes its receipt when psql exits right after the fingerprint", () => {
    const d = fixtures("snap-fast-l");
    const out = path.join(scratch, "snap-fast-l-out");
    const r = run("logical-export.sh", LOGICAL_ARGS(out), ciEnv(d, { SHIM_PSQL_EXIT_AFTER_EOF: "1" }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/unbound variable/);
    expect(existsSync(path.join(out, "receipt.txt"))).toBe(true);
  });

  it("GREEN: the object export completes and writes its receipt when psql exits right after the coverage query", () => {
    const d = fixtures("snap-fast-o");
    const enc = (p: string) => Buffer.byteLength(`https://${REF}.supabase.co/storage/v1/object/treatment-images/${p}`);
    writeFileSync(path.join(d, "list.txt"), ["s/c/a.png"].map((p) => `${p}${US}${enc(p)}${US}image/png`).join("\n") + "\n");
    writeFileSync(path.join(d, "coverage.txt"), "rows_total=1 rows_without_object=0 objects_total=1 objects_without_row=0\n");
    const out = path.join(scratch, "snap-fast-o-out");
    const r = run("object-export.sh", ["--out", out, "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`], ciEnv(d, { SHIM_PSQL_EXIT_AFTER_EOF: "2" }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/unbound variable/);
    expect(existsSync(path.join(out, "receipt.txt"))).toBe(true);
  });

  it("the lib keeps the PID and both descriptors in plain variables and never re-reads $SNAP / $SNAP_PID after the open", () => {
    const lib = readFileSync(path.join(OPS, "export-lib.sh"), "utf8");
    expect(lib).toContain('SNAP_WAIT_PID="${SNAP_PID:-}"');
    expect(lib).toContain('SNAP_IN="${SNAP[1]:-}"');
    const afterOpen = lib.slice(lib.indexOf("SNAP_IS_OPEN=1"));
    expect(afterOpen.replace(/^\s*#.*$/gm, "")).not.toMatch(/\$\{?SNAP(\[|_PID)/);
  });
});

describe("Codex P2 4371357978: the verification sample is drawn from the whole index range, without replacement", () => {
  const sample = (n: number, k: number, largest: number, seed: number) => {
    const r = spawnSync("bash", ["-c", `. ${path.join(OPS, "export-lib.sh")}; pick_sample ${n} ${k} ${largest} ${seed}`], { encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split("\n").filter(Boolean).map(Number);
  };

  it("N=40000 with k=40000 terminates and samples every index exactly once", () => {
    const got = sample(40000, 40000, 123, 1);
    expect(got).toHaveLength(40000);
    expect(new Set(got).size).toBe(40000);
    expect(Math.min(...got)).toBe(0);
    expect(Math.max(...got)).toBe(39999);
  });

  it("N=40000 with k=10 can pick an index above 32767 (the $RANDOM ceiling); the same seed gives the same sample", () => {
    const high = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seed) => sample(40000, 10, -1, seed)).filter((g) => g.some((i) => i > 32767));
    expect(high.length).toBeGreaterThan(0);
    expect(sample(40000, 10, -1, 7)).toEqual(sample(40000, 10, -1, 7));
    expect(sample(40000, 10, -1, 7)).not.toEqual(sample(40000, 10, -1, 8));
    // every pick is distinct and in range
    const g = sample(40000, 10, -1, 3);
    expect(new Set(g).size).toBe(10);
    expect(g.every((i) => i >= 0 && i < 40000)).toBe(true);
  });

  it("k above N is capped at N; k=0 samples nothing but the largest; the largest is never counted twice", () => {
    const capped = sample(5, 100, 2, 9);
    expect(capped.sort()).toEqual([0, 1, 2, 3, 4]);
    expect(sample(100, 0, 42, 5)).toEqual([42]);
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const g = sample(20, 10, 7, seed);
      expect(g.filter((i) => i === 7)).toHaveLength(1);
      expect(g.length).toBeGreaterThanOrEqual(10);
      expect(g.length).toBeLessThanOrEqual(11);
      expect(new Set(g).size).toBe(g.length);
    }
    expect(sample(1, 5, 0, 1)).toEqual([0]);
  });

  it("the object export asks for its sample from pick_sample, and a --sample far above N still finishes and writes its receipt", () => {
    const enc = (p: string) => Buffer.byteLength(`https://${REF}.supabase.co/storage/v1/object/treatment-images/${p}`);
    const d = fixtures("rnd-e2e");
    const paths = ["s/c/a.png", "s/c/b.png", "s/c/c.png"];
    writeFileSync(path.join(d, "list.txt"), paths.map((p) => `${p}${US}${enc(p)}${US}image/png`).join("\n") + "\n");
    writeFileSync(path.join(d, "coverage.txt"), "rows_total=3 rows_without_object=0 objects_total=3 objects_without_row=0\n");
    const out = path.join(scratch, "rnd-e2e-out");
    const r = run("object-export.sh", ["--out", out, "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`, "--sample", "100000"], { DB_URL, SERVICE_KEY: "k", EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("sample re-download: 3 object(s)");
    expect(existsSync(path.join(out, "receipt.txt"))).toBe(true);
  });

  // The old selection was `RANDOM % N` inside a loop waiting for K distinct values.
  function badRandomOrLoop(source: string): string[] {
    const out: string[] = [];
    source.split("\n").forEach((raw, i) => {
      const line = raw.replace(/^\s*#.*$/, "");
      if (/\bS?RANDOM\b/.test(line)) out.push(`line ${i + 1}: $RANDOM/$SRANDOM (${raw.trim().slice(0, 70)})`);
      const m = /^\s*(while|until)\b(.*)$/.exec(line);
      if (m) {
        const cond = m[2];
        const allowed =
          /^\s*\[ \$# -gt 0 \]( && \[\[ "\$1" == \[A-Z_\]\*=\* \]\])?; do/.test(cond) ||   // option parsing: every branch shifts or fails
          /^\s*IFS= read -r( -t 120)?( -u "\$SNAP_OUT_FD")? line; do/.test(cond) ||                 // reads until EOF (the session read is also timed)
          /^\s*IFS= read -r line; do/.test(cond);
        if (!allowed) out.push(`line ${i + 1}: an unreviewed ${m[1]} loop (${raw.trim().slice(0, 70)})`);
      }
    });
    return out;
  }

  it("RED control: the old $RANDOM loop and an unbounded retry loop are detected; GREEN: the reviewed loops are not", () => {
    for (const bad of [
      'while [ "${#PICK[@]}" -lt "$((k + 1))" ]; do PICK[$((RANDOM % N))]=1; done',
      'x=$((RANDOM % 10))',
      'while true; do curl -fsS "$u" && break; done',
      'until curl -fsS "$u"; do sleep 1; done',
      'while ! wait_marker "$f"; do :; done',
    ]) expect(badRandomOrLoop(bad), bad).not.toEqual([]);
    for (const good of [
      'while [ $# -gt 0 ]; do',
      '  while [ $# -gt 0 ] && [[ "$1" == [A-Z_]*=* ]]; do vars+=("$1"); shift; done',
      '  while IFS= read -r -t 120 -u "$SNAP_OUT_FD" line; do',
      '  while IFS= read -r -u "$SNAP_OUT_FD" line; do',
      '  while IFS= read -r line; do',
      'for ((i = 0; i < n * 10; i++)); do',
    ]) expect(badRandomOrLoop(good), good).toEqual([]);
  });

  it("no tool uses $RANDOM for anything, and every while/until loop in the six tools is a reviewed, bounded one", () => {
    const names = ["export-lib.sh", "logical-export.sh", "object-export.sh", "verify-export.sh", "export-restore.sh", "export-rehearsal.sh"];
    for (const n of names) expect(badRandomOrLoop(readFileSync(path.join(OPS, n), "utf8")), n).toEqual([]);
    // and the sample is taken from pick_sample
    expect(readFileSync(path.join(OPS, "object-export.sh"), "utf8")).toMatch(/pick_sample "\$N" "\$SAMPLE" "\$LARGEST_I" "\$SEED"/);
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
      expect(src[f], f).not.toMatch(/(echo|printf)[^\n]*\$\{?(DB_URL|SERVICE_KEY)\b[^\n]*(>>?\s*[^\n"]*(log|txt)|\| *tee)/);
      expect(src[f], f).not.toMatch(/export_log[^\n]*\$\{?(SERVICE_KEY|DB_PASS)\b/);
    }
  });

  // Privacy PEER-1155 M2. psql, pg_dump and curl command lines are readable by any
  // process on the host (ps, /proc/<pid>/cmdline), so no tool may pass the password,
  // the service-role key or a bearer header as an ARGUMENT. The password goes in
  // PGPASSWORD in the one child's environment (with_pgpass); the key goes in a
  // private 0600 header file (curl -H @file). A line-level detector, proved RED first.
  function argvSecretViolations(source: string): string[] {
    const out: string[] = [];
    source.split("\n").forEach((raw, i) => {
      const line = raw.replace(/^\s*#.*$/, "");
      const secret = /\$\{?(SERVICE_KEY|DB_URL|DB_PASS|KEY|DBURL)\b/;
      const exec = /\b(curl|psql|pg_dump|env|docker)\b/;
      const at = `line ${i + 1}: ${raw.trim().slice(0, 90)}`;
      if (exec.test(line) && secret.test(line)) out.push(`${at} (a secret on a command line)`);
      if (/Bearer/.test(line) && !/>\s*"\$AUTH_HDR_FILE"/.test(line)) out.push(`${at} (a bearer header outside the header-file writer)`);
      if (/-H\s+["']?(Authorization|apikey)/i.test(line)) out.push(`${at} (an auth header given as an argument)`);
      if (/PGPASSWORD=/.test(line) && !/PGPASSWORD="\$DB_PASS" "\$@"/.test(line)) out.push(`${at} (PGPASSWORD outside with_pgpass)`);
    });
    return out;
  }

  // A <(...) or >(...) swallows the exit status of what runs inside it, even under
  // `set -o pipefail`: a failed decryption became an empty list and a PASS
  // (Codex P2 4371111142). Decrypting inside a substitution is therefore banned; the
  // decrypt must be a plain command substitution whose status is checked.
  function decryptInSubstitution(source: string): string[] {
    return source.split("\n").flatMap((raw, i) => {
      const line = raw.replace(/^\s*#.*$/, "");
      return /[<>]\(\s*(dec\b|age\b)/.test(line) || /[<>]\([^)]*\|\s*(dec\b|age\b)/.test(line) ? [`line ${i + 1}: ${raw.trim().slice(0, 80)}`] : [];
    });
  }

  it("RED control: a decrypt inside a process substitution is detected; GREEN: a checked command substitution is not", () => {
    for (const bad of [
      'while read -r l; do M+=("$l"); done < <(dec "$DIR/manifest.age" | grep -v count)',
      'diff <(age -d -i "$ID" a.age) <(cat b)',
      'x < <(cat f | dec "$f")',
    ]) expect(decryptInSubstitution(bad), bad).not.toEqual([]);
    for (const good of [
      'raw="$(age -d -i "$id" "$dir/manifest.age" 2>/dev/null)" || { fail; }',
      'object_manifest_check <(printf \'%s\\n\' "${MANIFEST[@]}") "$N"',
      'tee >(chk "$cre" "$cm") >(names "$nre" "$nf" "$nm")',
    ]) expect(decryptInSubstitution(good), good).toEqual([]);
  });

  it("no tool decrypts inside a process substitution (its status would be lost)", () => {
    for (const f of files) expect(decryptInSubstitution(src[f]), f).toEqual([]);
  });

  it("RED control: the argv-secret detector catches every way of putting a secret on a command line", () => {
    for (const bad of [
      'curl -fsS "$url" -H "Authorization: Bearer $SERVICE_KEY"',
      'curl -fsS "$url" -H "apikey: $SERVICE_KEY"',
      'psql "$DB_URL" -c "select 1"',
      'pg_dump "postgresql://u:$DB_PASS@h/db"',
      'docker exec -e PGPASSWORD="$DB_PASS" c psql',
      'env PGPASSWORD=x psql -h h',
      'PGDUMP_CMD=(pg_dump "$DB_URL")',
      "curl -H 'Authorization: Bearer abc' http://x",
      'printf "Authorization: Bearer %s" "$SERVICE_KEY" | curl -K - http://x',
    ]) {
      expect(argvSecretViolations(bad), bad).not.toEqual([]);
    }
  });

  it("GREEN control: the safe forms are accepted by the detector", () => {
    for (const good of [
      'curl -fsS "$url" -H @"$AUTH_HDR_FILE"',
      'with_pgpass psql "$DB_URL_NOPASS" -qAtX',
      'PGDUMP_CMD=(pg_dump "$DB_URL_NOPASS")',
      '  if [ -n "$DB_PASS" ]; then PGPASSWORD="$DB_PASS" "$@"; else "$@"; fi',
      "  printf 'Authorization: Bearer %s\\napikey: %s\\n' \"$SERVICE_KEY\" \"$SERVICE_KEY\" >\"$AUTH_HDR_FILE\"",
      'url_matches_ref "$DB_URL" "$REF" || export_fail "x"',
    ]) {
      expect(argvSecretViolations(good), good).toEqual([]);
    }
  });

  it("no tool, and not the CI rehearsal, passes a password, a service-role key or a bearer header as an argument", () => {
    for (const f of files) expect(argvSecretViolations(src[f]), f).toEqual([]);
  });

  it("secrets are prompted, never read from an argument or file (and the prompt is hidden)", () => {
    expect(src["export-lib.sh"]).toContain("read -r -s");
    for (const f of ["logical-export.sh", "object-export.sh", "export-restore.sh"]) {
      expect(src[f], f).not.toMatch(/--(db-url|service-key|key)\)/);
    }
  });

  it("rehearsal mode is CI-only: every switch goes through is_rehearsal (EXPORT_REHEARSAL=1 AND GITHUB_ACTIONS=true)", () => {
    const lib = src["export-lib.sh"];
    expect(lib).toContain('is_rehearsal() { [ "${EXPORT_REHEARSAL:-}" = 1 ] && [ "${GITHUB_ACTIONS:-}" = true ]; }');
    expect(lib).toMatch(/if is_rehearsal && is_loopback_host "\$host" && \[ "\$ref" = "\$\{EXPORT_REHEARSAL_REF:-\}" \]/);
    expect(src["object-export.sh"]).toMatch(/if is_rehearsal && \[ -n "\$\{EXPORT_TEST_HOOK_AFTER_LIST:-\}" \]/);
    // No tool tests EXPORT_REHEARSAL directly: they would bypass the CI requirement.
    for (const f of ["logical-export.sh", "object-export.sh", "export-restore.sh", "verify-export.sh"]) {
      expect(src[f].replace(/^\s*#.*$/gm, ""), f).not.toMatch(/\[ "\$\{EXPORT_REHEARSAL:-\}"/);
      if (f !== "verify-export.sh") expect(src[f], f).toContain("export_guard_rehearsal");
    }
    expect(src["export-rehearsal.sh"]).toContain('[ "${GITHUB_ACTIONS:-}" = true ] ||');
  });

  it("the rehearsal does not grep ciphertext for plaintext (it proves nothing) and has no bash -c control strings holding a key", () => {
    const r = src["export-rehearsal.sh"];
    expect(r).not.toMatch(/--include='\*\.age'/);
    expect(r).not.toMatch(/bash -c "\$\(declare/);
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

describe("Insurance PEER-1155 J1/J2 and Codex P2 4371423762", () => {
  const env = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, ...extra });
  const key = () => { const k = path.join(scratch, "j-key.txt"); writeFileSync(k, "AGE-SECRET-KEY-SHIM"); return k; };

  it("J1 NEGATIVE: pg_dump dying part-way fails the run: no receipt, no hashes, no output directory, no temp files", () => {
    const d = fixtures("j1");
    const out = path.join(scratch, "j1-out");
    const tmp = path.join(scratch, "j1-tmp"); mkdirSync(tmp);
    const r = run("logical-export.sh", LOGICAL_ARGS(out), env(d, { SHIM_PG_DUMP_DIES_IN_AUTH: "1", TMPDIR: tmp }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("PASS");
    expect(existsSync(path.join(out, "receipt.txt"))).toBe(false);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
    // an existing EMPTY output directory is emptied, not left holding the earlier parts
    const pre = path.join(scratch, "j1-pre"); mkdirSync(pre);
    const r2 = run("logical-export.sh", LOGICAL_ARGS(pre), env(d, { SHIM_PG_DUMP_DIES_IN_AUTH: "1", TMPDIR: tmp }));
    expect(r2.status).not.toBe(0);
    expect(readdirSync(pre)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
    // POSITIVE control: the same fixtures without the failure produce a receipt
    const ok = path.join(scratch, "j1-ok");
    expect(run("logical-export.sh", LOGICAL_ARGS(ok), env(d, { TMPDIR: tmp })).status).toBe(0);
    expect(existsSync(path.join(ok, "receipt.txt"))).toBe(true);
  });

  it("J2 NEGATIVE: a truncated ciphertext whose readable prefix still holds every marker line FAILS verification", () => {
    const d = fixtures("j2");
    const out = path.join(scratch, "j2-out");
    expect(run("logical-export.sh", LOGICAL_ARGS(out), env(d)).status).toBe(0);
    const k = key();
    expect(run("verify-export.sh", ["logical", out, "--identity", k]).stdout).toContain("VERIFY PASS");
    // truncate the final line of the part, then re-record the hashes so V1 passes: only the decrypt can tell
    const part = path.join(out, "public-data.sql.age");
    const full = readFileSync(part, "utf8");
    writeFileSync(part, full.slice(0, full.lastIndexOf("\\.")));
    execFileSync("bash", ["-c", "cd \"$0\" && sha256sum -- *.age >hashes.sha256", out]);
    // the shim, like real age on a truncated stream, emits the prefix and then fails
    const bad = run("verify-export.sh", ["logical", out, "--identity", k], { SHIM_AGE_TRUNCATED: "public-data.sql.age" });
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toContain("VERIFY FAIL");
    expect(bad.stdout).toContain("public-data.sql.age does not decrypt cleanly");
    expect(bad.stdout).not.toContain("VERIFY PASS");
    // the marker count of the readable prefix alone WOULD have matched: this is the gap J2 named
    expect(bad.stdout).not.toContain("decrypts to 0 line(s)");
    // and a truncated schema-only part and manifest fail too
    for (const name of ["schema-only.sql.age", "manifest.age", "auth-data.sql.age", "storage-meta.sql.age"]) {
      const o = path.join(scratch, `j2-${name}`);
      expect(run("logical-export.sh", LOGICAL_ARGS(o), env(d)).status).toBe(0);
      const r = run("verify-export.sh", ["logical", o, "--identity", k], { SHIM_AGE_TRUNCATED: name });
      expect(r.status, name).not.toBe(0);
      expect(r.stdout, name).toContain("VERIFY FAIL");
    }
  });

  it("J2 source: verify-export no longer swallows a decrypt status with `| grep -c ... || true`", () => {
    const src = readFileSync(path.join(OPS, "verify-export.sh"), "utf8");
    expect(src).not.toMatch(/dec "[^"]*" \| grep -c [^\n]*\|\| true/);
    expect(src).toContain("does not decrypt cleanly");
  });

  it("Codex P2 4371423762: hashing a bucket too large for one argument list works; the old form fails under the same limit", () => {
    const dir = path.join(scratch, "argmax"); mkdirSync(path.join(dir, "objects"), { recursive: true });
    writeFileSync(path.join(dir, "manifest.age"), "m");
    const names = Array.from({ length: 12000 }, (_, i) => `objects/${String(i).padStart(6, "0")}.age`);
    for (const n of names) writeFileSync(path.join(dir, n), n);
    const lib = path.join(OPS, "export-lib.sh");
    // RED: the old one-exec form, ~230 KB of names against a 128 KB argument limit
    const old = spawnSync("bash", ["-c", `ulimit -s 256; cd "${dir}" && sha256sum -- manifest.age objects/*.age >/dev/null`], { encoding: "utf8" });
    expect(old.status).not.toBe(0);
    expect(old.stderr).toMatch(/Argument list too long/);
    // GREEN: the lib function under the same limit, then a full verification of the result
    const g = spawnSync("bash", ["-c", `set -euo pipefail; ulimit -s 256; . "${lib}"; hash_record_objects "${dir}"; hash_verify "${dir}"`], { encoding: "utf8" });
    expect(g.status, g.stderr).toBe(0);
    expect(readFileSync(path.join(dir, "hashes.sha256"), "utf8").trim().split("\n")).toHaveLength(12001);
    expect(readFileSync(path.join(OPS, "object-export.sh"), "utf8")).toContain('hash_record_objects "$OUT"');
  });
});

describe("Codex P1/P2 on 7f5246be: libpq query-string overrides cannot change the checked target", () => {
  const PROD = "db.prodref.supabase.co";
  const BASE = `postgresql://u:p@db.${REF}.supabase.co:5432/postgres`;
  const lib = (body: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", `. ${path.join(OPS, "export-lib.sh")}; ${body}`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch, ...env } as unknown as NodeJS.ProcessEnv });

  // Every way libpq (or a shell reading the URL differently) can be pointed elsewhere.
  const REFUSED: Array<[string, string]> = [
    ["host= in the query", `${BASE}?host=${PROD}`],
    ["hostaddr= in the query", `${BASE}?hostaddr=10.1.2.3`],
    ["port= in the query", `${BASE}?port=6543`],
    ["dbname= in the query", `${BASE}?dbname=other`],
    ["user= in the query", `${BASE}?user=admin`],
    ["service= in the query", `${BASE}?service=prod`],
    ["password= in the query", `${BASE}?password=s3kr3t`],
    ["an unknown parameter", `${BASE}?application_name=x`],
    ["sslmode followed by host=", `${BASE}?sslmode=require&host=${PROD}`],
    ["host= followed by sslmode", `${BASE}?host=${PROD}&sslmode=require`],
    ["multi-host in the query (h1,h2)", `${BASE}?host=db.${REF}.supabase.co,${PROD}`],
    ["multi-host with the production host first", `${BASE}?host=${PROD},db.${REF}.supabase.co`],
    ["percent-encoded value", `${BASE}?host=db%2Eprodref%2Esupabase%2Eco`],
    ["percent-encoded KEY (%68ost)", `${BASE}?%68ost=${PROD}`],
    ["percent-encoded key hostaddr", `${BASE}?hostadd%72=10.1.2.3`],
    ["uppercase key", `${BASE}?HOST=${PROD}`],
    ["sslmode with a percent-encoded value", `${BASE}?sslmode=requ%69re`],
    ["sslmode given twice", `${BASE}?sslmode=require&sslmode=disable`],
    ["an empty pair", `${BASE}?&sslmode=require`],
    ["a fragment", `${BASE}#host=${PROD}`],
    ["multi-host in the authority", `postgresql://u:p@db.${REF}.supabase.co,${PROD}:5432/postgres`],
    ["a percent-encoded authority host", `postgresql://u:p@db.prodref%2Esupabase.co/postgres`],
    ["a socket directory host", `postgresql://u:p@%2Ftmp/postgres`],
    ["an empty host", `postgresql://u:p@/postgres`],
    ["a non-numeric port", `postgresql://u:p@db.${REF}.supabase.co:abc/postgres`],
    ["a port out of range", `postgresql://u:p@db.${REF}.supabase.co:70000/postgres`],
    ["a percent-encoded database name", `postgresql://u:p@db.${REF}.supabase.co/post%67res`],
    ["J4: an unencoded '@' in the password", `postgresql://u:pa@ss@${PROD}/postgres`],
    ["J4: an unencoded '@' with the disposable host last", `postgresql://u:pa@${PROD}@db.${REF}.supabase.co/postgres`],
    ["a whitespace character", `postgresql://u:p@db.${REF}.supabase.co/post gres`],
    ["a backslash", `postgresql://u:p@db.${REF}.supabase.co\\@${PROD}/postgres`],
    ["an unsupported scheme", `mysql://u:p@db.${REF}.supabase.co/x`],
  ];

  it("RED control: the OLD authority-only reader accepts a query-string host= and names the disposable host", () => {
    const oldHostOf = `old_host_of() { local s="\${1#*://}"; s="\${s#*@}"; s="\${s%%/*}"; s="\${s%%:*}"; printf '%s' "$s"; }`;
    const r = lib(`${oldHostOf}; old_host_of '${BASE}?host=${PROD}'`);
    expect(r.stdout).toBe(`db.${REF}.supabase.co`); // the check would have PASSED while libpq connects to production
    // and the NEW reader refuses the very same string
    expect(lib(`url_matches_ref '${BASE}?host=${PROD}' ${REF}`).status).not.toBe(0);
  });

  it.each(REFUSED)("NEGATIVE: %s is refused by the parser, the ref check and host_of", (_name, url) => {
    expect(lib(`parse_conn_url '${url}'`).status, url).not.toBe(0);
    expect(lib(`url_matches_ref '${url}' ${REF}`).status, url).not.toBe(0);
    expect(lib(`host_of '${url}'`).stdout, url).toBe("");
    // and no refusal is silent: the tools quote the reason
    const q = lib(`require_conn_url '${url}' 'the connection string'`);
    expect(q.status, url).not.toBe(0);
    expect(q.stderr, url).toContain("the connection string refused:");
  });

  it("POSITIVE controls: the plain form, a port, a user without password and sslmode alone are accepted, with the effective host", () => {
    expect(lib(`parse_conn_url '${BASE}' && printf '%s|%s|%s|%s|%s' "$CONN_HOST" "$CONN_PORT" "$CONN_USER" "$CONN_DB" "$CONN_SSLMODE"`).stdout).toBe(`db.${REF}.supabase.co|5432|u|postgres|`);
    expect(lib(`parse_conn_url '${BASE}?sslmode=verify-full' && printf '%s' "$CONN_SSLMODE"`).stdout).toBe("verify-full");
    expect(lib(`parse_conn_url 'postgres://u@db.${REF}.supabase.co/postgres' && printf '%s' "$CONN_HOST"`).stdout).toBe(`db.${REF}.supabase.co`);
    expect(lib(`parse_conn_url 'postgresql://u:s3kr%40t@db.${REF}.supabase.co/postgres' && printf '%s' "$CONN_PASS"`).stdout).toBe("s3kr@t");
    expect(lib(`parse_conn_url 'https://${REF}.supabase.co/storage/v1' && printf '%s' "$CONN_HOST"`).stdout).toBe(`${REF}.supabase.co`);
    expect(lib(`url_matches_ref '${BASE}?sslmode=require' ${REF}`).status).toBe(0);
    // a Storage URL with credentials or a query string is refused
    expect(lib(`parse_conn_url 'https://k@${REF}.supabase.co'`).status).not.toBe(0);
    expect(lib(`parse_conn_url 'https://${REF}.supabase.co/?host=${PROD}'`).status).not.toBe(0);
  });

  it("libpq environment overrides (PGHOSTADDR, PGHOST, PGPORT, PGSERVICE, ...) are refused", () => {
    for (const v of ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE", "PGUSER", "PGOPTIONS"]) {
      const r = lib(`DB_URL='${BASE}'; export_configure_commands`, { [v]: "x" });
      expect(r.status, v).not.toBe(0);
      expect(r.stderr, v).toContain(`${v} is set in the environment`);
    }
  });

  it("every tool refuses a host= override BEFORE it touches the database or writes anything", () => {
    const d = fixtures("p1-tools");
    const url = `${BASE}?host=${PROD}`;
    const log = path.join(scratch, "p1-argv.log"); writeFileSync(log, "");
    const ci = { EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, SHIM_ARGV_LOG: log, DB_URL: url, SERVICE_KEY: "k" };
    const out = path.join(scratch, "p1-out");
    const a = run("logical-export.sh", LOGICAL_ARGS(out), ci);
    expect(a.status).not.toBe(0);
    expect(a.stderr).toContain("refused");
    expect(existsSync(out)).toBe(false);
    const out2 = path.join(scratch, "p1-out2");
    const b = run("object-export.sh", ["--out", out2, "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`], ci);
    expect(b.status).not.toBe(0);
    expect(existsSync(out2)).toBe(false);
    const key = path.join(scratch, "p1-key.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const psqlLog = path.join(scratch, "p1-psql.log"); writeFileSync(psqlLog, "");
    const c = run("export-restore.sh", ["logical", d, "--identity", key, "--target-ref", REF, "--production-ref", "prodref"], { ...ci, SHIM_PSQL_LOG: psqlLog });
    expect(c.status).not.toBe(0);
    expect(c.stderr).toContain("refused");
    expect(readFileSync(psqlLog, "utf8")).toBe("");
    // none of the three ran psql or pg_dump at all
    expect(readFileSync(log, "utf8")).not.toMatch(/psql argv|pg_dump argv/);
    // a storage URL with a query override is refused too
    const e = run("export-restore.sh", ["objects", d, "--identity", key, "--target-ref", REF, "--production-ref", "prodref", "--storage-url", `https://${REF}.supabase.co/?host=${PROD}`], { ...ci, DB_URL: BASE, SHIM_PSQL_LOG: psqlLog });
    expect(e.status).not.toBe(0);
    expect(e.stderr).toContain("storage URL refused");
  });

  it("P2: a password that is not in the authority never exists, and none appears in any constructed argv; a good password still goes only to PGPASSWORD", () => {
    const d = fixtures("p2-pw");
    const log = path.join(scratch, "p2-argv.log"); writeFileSync(log, "");
    const ci = (url: string) => ({ EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, SHIM_ARGV_LOG: log, DB_URL: url });
    const bad = run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, "p2-out-bad")), ci(`${BASE}?password=s3kr3t`));
    expect(bad.status).not.toBe(0);
    expect(readFileSync(log, "utf8")).not.toContain("s3kr3t");
    expect(bad.stdout + bad.stderr).not.toContain("s3kr3t");
    // good form with sslmode: the argv is rebuilt without the password and without any query
    const ok = run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, "p2-out-ok")), ci(`postgresql://u:s3kr%40t@db.${REF}.supabase.co:5432/postgres?sslmode=verify-full`));
    expect(ok.status, ok.stderr).toBe(0);
    const argv = readFileSync(log, "utf8");
    for (const line of argv.split("\n").filter((l) => /argv:/.test(l))) {
      expect(line).not.toMatch(/s3kr|%40t|\?|sslmode|password/i);
      expect(line).toContain(`[postgresql://u@db.${REF}.supabase.co:5432/postgres]`);
    }
    expect(argv).toMatch(/PGPASSWORD=s3kr@t/);
  });

  it("the strict parser is the only reader: no tool reads a host out of a URL by string slicing of its own", () => {
    for (const f of ["logical-export.sh", "object-export.sh", "export-restore.sh", "verify-export.sh"]) {
      const src = readFileSync(path.join(OPS, f), "utf8");
      expect(src, f).not.toMatch(/\$\{[A-Za-z_]*URL[A-Za-z_]*#\*@\}/);
    }
    expect(readFileSync(path.join(OPS, "export-lib.sh"), "utf8")).toContain("parse_conn_url");
  });
});

describe("Insurance PEER-1155-3B8E5CBC N1-N5: scheme, Supabase host forms, TLS floor, percent signs, slicing", () => {
  const BASE = `postgresql://u:p@db.${REF}.supabase.co:5432/postgres`;
  const lib = (body: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-c", `. ${path.join(OPS, "export-lib.sh")}; ${body}`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: scratch, ...env } as unknown as NodeJS.ProcessEnv });
  const CI = { EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true" };

  it("N1: a Storage URL must be https; http is accepted only for the rehearsal's loopback", () => {
    expect(lib(`parse_conn_url 'http://${REF}.supabase.co'`).status).not.toBe(0);
    expect(lib(`require_conn_url 'http://${REF}.supabase.co' 'the storage URL'`).stderr).toContain("must be https");
    expect(lib(`parse_conn_url 'http://127.0.0.1:54321'`).status).not.toBe(0); // loopback http outside rehearsal
    expect(lib(`parse_conn_url 'http://127.0.0.1:54321'`, CI).status).toBe(0); // the rehearsal's own form
    expect(lib(`parse_conn_url 'http://evil.example'`, CI).status).not.toBe(0); // rehearsal does not make any http host fine
    expect(lib(`parse_conn_url 'https://${REF}.supabase.co'`).status).toBe(0);
  });

  it("N1: the object tools refuse an http Storage URL before any curl, and send no key", () => {
    const d = fixtures("n1");
    const log = path.join(scratch, "n1-argv.log"); writeFileSync(log, "");
    const out = path.join(scratch, "n1-out");
    const env = { ...CI, SHIM_DUMP_DIR: d, SHIM_ARGV_LOG: log, DB_URL, SERVICE_KEY: "k-n1" };
    const r = run("object-export.sh", ["--out", out, "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `http://${REF}.supabase.co`], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("must be https");
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(log, "utf8")).not.toMatch(/curl argv|k-n1/);
  });

  it("N2: only db.<ref>.supabase.co and <ref>.supabase.co name the ref; a lookalike or deeper host is refused", () => {
    const hosts = [
      `db.${REF}.attacker.example`, `${REF}.attacker.example`, `a.b.${REF}.supabase.co`, `db.${REF}.supabase.co.attacker.example`,
      `${REF}.supabase.co.attacker.example`, `x.db.${REF}.supabase.co`, `${REF}.supabase.com`, `db.${REF}.supabase.in`,
      `aws-0-us-east-1.pooler.supabase.com`,
    ];
    for (const h of hosts) {
      expect(lib(`url_matches_ref 'postgresql://u:p@${h}:5432/postgres' ${REF}`).status, h).not.toBe(0);
      expect(lib(`url_matches_ref 'https://${h}' ${REF}`).status, h).not.toBe(0);
    }
    // RED control: the label-only rule of 3b8e5cbc accepted every host that carries the ref as a label
    for (const h of [`db.${REF}.attacker.example`, `${REF}.attacker.example`, `a.b.${REF}.supabase.co`]) {
      expect(lib(`host_has_label '${h}' ${REF}`).status, h).toBe(0);
    }
    // GREEN: the two real forms
    expect(lib(`url_matches_ref 'postgresql://u:p@db.${REF}.supabase.co:5432/postgres' ${REF}`).status).toBe(0);
    expect(lib(`url_matches_ref 'https://${REF}.supabase.co' ${REF}`).status).toBe(0);
    // the rehearsal's loopback exception still holds, for its one declared ref only
    expect(lib(`url_matches_ref 'postgresql://u:p@127.0.0.1:5432/x' ${REF}`, { ...CI, EXPORT_REHEARSAL_REF: REF }).status).toBe(0);
  });

  it("N2: the object tools never send the service-role key to a lookalike Storage host", () => {
    const d = fixtures("n2");
    const log = path.join(scratch, "n2-argv.log"); writeFileSync(log, "");
    const out = path.join(scratch, "n2-out");
    const env = { ...CI, SHIM_DUMP_DIR: d, SHIM_ARGV_LOG: log, DB_URL, SERVICE_KEY: "k-n2" };
    const r = run("object-export.sh", ["--out", out, "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.attacker.example`], env);
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(log, "utf8")).not.toMatch(/curl argv|k-n2|attacker/);
    const l = run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, "n2-lx")), { ...env, DB_URL: `postgresql://u:p@db.${REF}.attacker.example:5432/postgres` });
    expect(l.status).not.toBe(0);
    expect(readFileSync(log, "utf8")).not.toMatch(/psql argv|pg_dump argv/);
  });

  it("N3: outside the rehearsal's loopback the connection is verify-full: a weaker sslmode is refused, none given means verify-full", () => {
    for (const m of ["disable", "allow", "prefer", "require", "verify-ca"]) {
      const r = lib(`DB_URL='${BASE}?sslmode=${m}'; export_configure_commands`);
      expect(r.status, m).not.toBe(0);
      expect(r.stderr, m).toContain("weaker than verify-full");
    }
    const none = lib(`DB_URL='${BASE}'; export_configure_commands; printf '%s' "$DB_SSLMODE"`);
    expect(none.stdout).toBe("verify-full");
    const vf = lib(`DB_URL='${BASE}?sslmode=verify-full'; export_configure_commands; printf '%s' "$DB_SSLMODE"`);
    expect(vf.stdout).toBe("verify-full");
    // the rehearsal's loopback target is not forced
    const lo = lib(`DB_URL='postgresql://u:p@127.0.0.1:5432/postgres'; export_configure_commands; printf '[%s]' "$DB_SSLMODE"`, CI);
    expect(lo.stdout).toBe("[]");
  });

  it("N3: without the pinned root CA the tool refuses instead of falling back to an unverified mode", () => {
    const emptyHome = path.join(scratch, "n3-home"); mkdirSync(emptyHome, { recursive: true });
    const r = lib(`DB_URL='${BASE}'; export_configure_commands`, { HOME: emptyHome });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("root CA");
    const d = fixtures("n3-nocert");
    const out = path.join(scratch, "n3-nocert-out");
    const t = run("logical-export.sh", LOGICAL_ARGS(out), { ...CI, SHIM_DUMP_DIR: d, DB_URL, HOME: emptyHome });
    expect(t.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it("N3: the child gets PGSSLMODE=verify-full and PGPASSFILE=/dev/null; the TLS and password-file variables in the environment are refused", () => {
    const d = fixtures("n3-ok");
    const log = path.join(scratch, "n3-argv.log"); writeFileSync(log, "");
    const r = run("logical-export.sh", LOGICAL_ARGS(path.join(scratch, "n3-ok-out")), { ...CI, SHIM_DUMP_DIR: d, SHIM_ARGV_LOG: log, DB_URL });
    expect(r.status, r.stderr).toBe(0);
    const argv = readFileSync(log, "utf8");
    expect(argv).toMatch(/PGSSLMODE=verify-full/);
    expect(argv).toMatch(/PGPASSFILE=\/dev\/null/);
    expect(argv).not.toMatch(/PGSSLMODE=(require|prefer|disable|allow)/);
    for (const v of ["PGSSLMODE", "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY", "PGPASSFILE", "PGGSSENCMODE", "PGSYSCONFDIR"]) {
      const e = lib(`DB_URL='${BASE}'; export_configure_commands`, { [v]: "x" });
      expect(e.status, v).not.toBe(0);
      expect(e.stderr, v).toContain(`${v} is set in the environment`);
    }
  });

  it("N4: a malformed percent sign in the credentials is refused, not mangled; a valid escape still decodes", () => {
    for (const cred of ["u:a%zz", "u:a%", "u:a%4", "u:%%41", "u:a%00b", "u%g1:p"]) {
      const r = lib(`parse_conn_url 'postgresql://${cred}@db.${REF}.supabase.co/postgres'`);
      expect(r.status, cred).not.toBe(0);
      expect(lib(`require_conn_url 'postgresql://${cred}@db.${REF}.supabase.co/postgres' 'the connection string'`).stderr, cred).toMatch(/percent sign|encoded NUL/);
    }
    expect(lib(`parse_conn_url 'postgresql://u:50%25off%40x@db.${REF}.supabase.co/postgres' && printf '%s' "$CONN_PASS"`).stdout).toBe("50%off@x");
  });

  it("N5: no tool slices a URL variable by any parameter expansion, sed, cut, awk or tr of its own (the argument trim is the one reviewed exception)", () => {
    const violations = (src: string) =>
      src.split("\n").flatMap((raw, i) => {
        const line = raw.replace(/^\s*#.*$/, "");
        const exp = /\$\{(DB_URL|STORAGE_URL|DBURL)[A-Za-z_]*(##?|%%?|\/\/?|:)/.test(line) && !/STORAGE_URL="\$\{2%\/\}"/.test(line);
        const tool = /\b(cut|sed|awk|tr|grep)\b[^\n|]*\$\{?(DB_URL|STORAGE_URL|DBURL)\b/.test(line);
        return exp || tool ? [`line ${i + 1}: ${raw.trim().slice(0, 80)}`] : [];
      });
    // RED controls: other slicing forms are caught
    expect(violations('h="${DB_URL%%/*}"')).toHaveLength(1);
    expect(violations('h="${DB_URL:8}"')).toHaveLength(1);
    expect(violations('h="${STORAGE_URL//https:/}"')).toHaveLength(1);
    expect(violations('h=$(cut -d@ -f2 <<<"$DB_URL")')).toHaveLength(1);
    expect(violations('h=$(sed "s/a/b/" <<<"$STORAGE_URL")')).toHaveLength(1);
    expect(violations('STORAGE_URL="${2%/}"')).toHaveLength(0); // GREEN: the reviewed argument trim
    for (const f of ["logical-export.sh", "object-export.sh", "export-restore.sh", "verify-export.sh", "export-rehearsal.sh"]) {
      expect(violations(readFileSync(path.join(OPS, f), "utf8")), f).toEqual([]);
    }
    // in the lib only the parser and the rebuilt-argv line may slice the URL
    const libLines = violations(readFileSync(path.join(OPS, "export-lib.sh"), "utf8"));
    expect(libLines).toEqual([]);
  });
});

describe("Codex P2 on 29c80788: decrypted object paths never touch the default temp directory", () => {
  const ciEnv = (d: string, extra: Record<string, string> = {}) => ({ DB_URL, SERVICE_KEY: "k", EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, ...extra });
  const PATHS = ["s/c/a.png", "s/c/b.png", "s/c/c.thumb.webp"];
  const enc = (p: string) => Buffer.byteLength(`https://${REF}.supabase.co/storage/v1/object/treatment-images/${p}`);

  function exportedObjects(name: string) {
    const d = fixtures(name);
    writeFileSync(path.join(d, "list.txt"), PATHS.map((p) => `${p}${US}${enc(p)}${US}${MIME_OF(p)}`).join("\n") + "\n");
    writeFileSync(path.join(d, "coverage.txt"), "rows_total=3 rows_without_object=0 objects_total=3 objects_without_row=0\n");
    const out = path.join(scratch, `${name}-out`);
    const r = run("object-export.sh", ["--out", out, "--recipient", "age1x", "--expect-ref", REF, "--storage-url", `https://${REF}.supabase.co`], ciEnv(d));
    expect(r.status, r.stderr).toBe(0);
    const key = path.join(scratch, `${name}-key.txt`); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const proj = path.join(scratch, `${name}-proj.txt`);
    writeFileSync(proj, PATHS.map((p) => `treatment-images|${p}|${enc(p)}|${MIME_OF(p)}`).join("\n") + "\n");
    return { d, out, key, proj };
  }
  const args = (out: string, key: string) => ["objects", out, "--identity", key, "--target-ref", REF, "--production-ref", "prod", "--storage-url", `https://${REF}.supabase.co`];

  it("the projections live in a 0700 directory on the private tmpfs; the default TMPDIR gets nothing and the directory is gone afterwards", () => {
    const { d, out, key, proj } = exportedObjects("tmp-ok");
    const xdg = path.join(scratch, "tmp-ok-xdg"); mkdirSync(xdg, { mode: 0o700 });
    const defTmp = path.join(scratch, "tmp-ok-default"); mkdirSync(defTmp);
    const probe = path.join(scratch, "tmp-ok-probe.log"); writeFileSync(probe, "");
    const r = run("export-restore.sh", args(out, key), ciEnv(d, { XDG_RUNTIME_DIR: xdg, TMPDIR: defTmp, SHIM_PROJECTION: proj, SHIM_WORK_PROBE: probe }));
    expect(r.status, r.stderr).toBe(0);
    const seen = readFileSync(probe, "utf8");
    expect(seen).toContain("workdir-mode=700");
    expect(seen).toMatch(/expected/);
    expect(seen).toMatch(/actual/);
    expect(seen).toMatch(/files-with-object-paths=[12]/);   // the decrypted paths exist, but only there
    expect(seen).toContain("default-tmp-entries=0");        // while the comparison ran, nothing was in the default temp dir
    expect(readdirSync(defTmp)).toEqual([]);
    expect(readdirSync(xdg)).toEqual([]);                   // and the private directory was removed
  });

  it("NEGATIVE: with a default TMPDIR that cannot be written the restore still passes (it never uses it); a failed restore also leaves nothing behind", () => {
    const { d, out, key, proj } = exportedObjects("tmp-unwritable");
    const xdg = path.join(scratch, "tmp-unwritable-xdg"); mkdirSync(xdg, { mode: 0o700 });
    const ok = run("export-restore.sh", args(out, key), ciEnv(d, { XDG_RUNTIME_DIR: xdg, TMPDIR: path.join(scratch, "no-such-tmp"), SHIM_PROJECTION: proj }));
    expect(ok.status, ok.stderr).toBe(0);
    expect(readdirSync(xdg)).toEqual([]);
    // a restore that fails at the comparison removes the working directory too, and names no path
    const wrong = path.join(scratch, "tmp-unwritable-wrong.txt");
    writeFileSync(wrong, PATHS.map((p) => `treatment-images|${p}|${enc(p)}|image/gif`).join("\n") + "\n");
    const bad = run("export-restore.sh", args(out, key), ciEnv(d, { XDG_RUNTIME_DIR: xdg, TMPDIR: path.join(scratch, "no-such-tmp"), SHIM_PROJECTION: wrong }));
    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).not.toContain("s/c/");
    expect(readdirSync(xdg)).toEqual([]);
  });

  it("the logical restore's fingerprint files use the private directory too, and no tool makes a bare mktemp for decrypted material", () => {
    const d = fixtures("tmp-logical");
    const out = path.join(scratch, "tmp-logical-out");
    expect(run("logical-export.sh", LOGICAL_ARGS(out), { DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d }).status).toBe(0);
    const key = path.join(scratch, "tmp-logical-key.txt"); writeFileSync(key, "AGE-SECRET-KEY-SHIM");
    const xdg = path.join(scratch, "tmp-logical-xdg"); mkdirSync(xdg, { mode: 0o700 });
    const r = run("export-restore.sh", ["logical", out, "--identity", key, "--target-ref", REF, "--production-ref", "prod"], { DB_URL, EXPORT_REHEARSAL: "1", GITHUB_ACTIONS: "true", SHIM_DUMP_DIR: d, XDG_RUNTIME_DIR: xdg, TMPDIR: path.join(scratch, "no-such-tmp") });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(xdg)).toEqual([]);
    // source contract: export-restore.sh has no bare mktemp (the lib's private_workdir is the one place)
    const restoreSrc = readFileSync(path.join(OPS, "export-restore.sh"), "utf8");
    expect(restoreSrc.split("\n").filter((l) => !/^\s*#/.test(l) && /\bmktemp\b/.test(l))).toEqual([]);
    expect(restoreSrc).toContain("private_workdir");
    // RED control: the previous form (a bare mktemp for the projections) is detected by the same rule
    expect(/\bmktemp\b/.test('EXPECTED_PROJ="$(mktemp)"')).toBe(true);
  });
});
