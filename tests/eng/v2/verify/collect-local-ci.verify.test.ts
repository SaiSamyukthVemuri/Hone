import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { LOCAL_ROOT, gitBlobSha, loadLocalCi, tablePinnedTo } from "../../../../scripts/eng/v2/adapter/local-ci.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { classify } from "../../../../scripts/classify-changes.mjs";
import { BLOB_CI, BLOB_CLASSIFY, gitBlob } from "./support/collector";
import { REAL_810_FILES } from "./support/world";

// ===========================================================================
// INDEPENDENT VERIFIER — SPEC-05A §5.2 (f75ca255): the CI definition the shepherd
// executes. The blob vectors below were computed with `git hash-object --stdin`
// (git 2.x, 2026-10-07), not with the code under test.
// ===========================================================================

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const JOB_NAMES = [
  "changed-path detection",
  "browser e2e (local stack)",
  "typecheck / lint / build / test / safety gates",
  "db integration (local supabase)",
  "payment browser e2e (fake stripe)",
  "mobile completion e2e (chromium iphone-profile)",
  "google browser e2e (fake google)",
];

describe("§5.2 gitBlobSha: exactly as git hashes a blob (sha1 of 'blob <size>\\0' + bytes)", () => {
  const vectors: Array<[string, string | Buffer, string]> = [
    ["the empty blob", "", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
    ["'hello\\n'", "hello\n", "ce013625030ba8dba906f756967f9e9ca394464a"],
    ["'hello\\n' as bytes", Buffer.from("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a"],
    ["a multi-byte character: the size is in BYTES (3), not characters (2)", Buffer.from("é\n", "utf8"), "c6003325155f475bd7c87731607525dce73be9cf"],
    ["every byte value 0..255", Buffer.from(Array.from({ length: 256 }, (_, i) => i)), "c86626638e0bc8cf47ca49bb1525b40e9737ee64"],
    ["CRLF bytes are hashed as they are (no line-ending conversion)", Buffer.from("line1\r\nline2\r\n"), "8561d5d6dca37a4e5d7a60b130242f748fcfec84"],
  ];
  for (const [label, input, sha] of vectors)
    it(label, () => {
      expect(gitBlobSha(input)).toBe(sha);
      expect(gitBlob(input), "the verifier's own hash agrees with git").toBe(sha);
    });
});

describe("§5.2 loadLocalCi: this checkout's classifier and ci.yml", () => {
  it("LOCAL_ROOT is this checkout", () => {
    expect(path.resolve(LOCAL_ROOT)).toBe(ROOT);
  });

  it("the blobs are git's hashes of THIS checkout's two files", () => {
    const l = loadLocalCi();
    expect(Object.keys(l.blobs).sort()).toEqual([BLOB_CI, BLOB_CLASSIFY].sort());
    for (const p of [BLOB_CI, BLOB_CLASSIFY]) expect(l.blobs[p], p).toBe(gitBlob(readFileSync(path.join(ROOT, p))));
  });

  it("the table is pinned to this checkout's ci.yml", () => {
    expect(loadLocalCi().tablePinned).toBe(true);
  });

  it("its classifier is this checkout's classify-changes.mjs: same answers on real and edge inputs", () => {
    const l = loadLocalCi();
    for (const files of [[], ["README.md"], ["docs/x.md"], ["supabase/migrations/0001_x.sql"], ["app/page.tsx"], REAL_810_FILES])
      expect(JSON.stringify(l.classify(files)), JSON.stringify(files)).toBe(JSON.stringify(classify(files)));
  });
});

describe("§5.2 tablePinnedTo: every §3.3 job name appears as `name: <job>`", () => {
  const ciYml = () => readFileSync(path.join(ROOT, BLOB_CI), "utf8");

  it("this checkout's ci.yml pins all seven names", () => {
    expect(tablePinnedTo(ciYml())).toBe(true);
    for (const n of JOB_NAMES) expect(ciYml(), n).toContain(`name: ${n}`);
  });

  for (const n of JOB_NAMES)
    it(`a ci.yml without \`name: ${n}\` is not pinned`, () => {
      const text = ciYml().split(`name: ${n}`).join(`name: renamed`);
      expect(text).not.toContain(`name: ${n}`);
      expect(tablePinnedTo(text)).toBe(false);
    });

  it("a minimal text naming all seven is pinned; an empty one is not", () => {
    expect(tablePinnedTo(JOB_NAMES.map((n) => `    name: ${n}`).join("\n"))).toBe(true);
    expect(tablePinnedTo("")).toBe(false);
  });
});
