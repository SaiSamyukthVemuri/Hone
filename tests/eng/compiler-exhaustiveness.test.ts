import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ===========================================================================
// The canonical states are enforced by the COMPILER, not by remembering to
// write a test.
// ===========================================================================
//
// scripts/eng/*.mjs is not covered by the root tsconfig (`allowJs: false`), so
// without this the JSDoc unions in evidence.mjs would be decorative comments.
// scripts/eng/tsconfig.json turns on checkJs for exactly those files, and this
// test runs it inside the ordinary unit lane — no new CI step, and no root
// package.json or tsconfig.json edit (both are full-matrix triggers).
//
// The second case is the anti-vacuity control. A guard nobody has seen fail is
// not a guard: it deliberately writes code with an unhandled semantic state and
// an unnarrowed payload read, and requires the compiler to REJECT it.

const REPO = path.resolve(__dirname, "../..");
const TSC = path.join(REPO, "node_modules/.bin/tsc");
const run = (args: string[]) => spawnSync(TSC, args, { cwd: REPO, encoding: "utf8", timeout: 120_000 });

describe("the engineering evidence boundary is compiler-checked", () => {
  it("scripts/eng type-checks clean under checkJs", () => {
    const r = run(["-p", "scripts/eng/tsconfig.json"]);
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`.trim()).toBe("");
    expect(r.status).toBe(0);
  }, 120_000);

  it("ANTI-VACUITY: an unhandled state and an unnarrowed read are REJECTED", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eng-exhaustiveness-"));
    const probe = path.join(dir, "probe.mjs");
    writeFileSync(
      probe,
      [
        `import { decodeActorIdentity } from ${JSON.stringify(path.join(REPO, "scripts/eng/evidence.mjs"))};`,
        // Reading a payload field that the UNKNOWN member does not carry.
        "export function unnarrowed(u) { return decodeActorIdentity(u).id; }",
        // Handling only two of the three states, then claiming exhaustiveness.
        // Deliberately an if-chain: a `switch` with a `default` collapses the
        // residual to `never` by itself, so that form would pass here while
        // proving nothing. The production code avoids it for the same reason.
        "export function unhandled(u) {",
        "  const a = decodeActorIdentity(u);",
        '  if (a.kind === "KNOWN_TRUSTED") return a.id;',
        '  if (a.kind === "KNOWN_UNTRUSTED") return a.id;',
        "  /** @type {never} */ const x = a;",
        "  return x;",
        "}",
      ].join("\n"),
    );

    const r = run([
      "--noEmit", "--allowJs", "--checkJs", "--strict", "--noImplicitAny", "false",
      "--target", "ES2022", "--module", "esnext", "--moduleResolution", "bundler",
      "--skipLibCheck", probe,
    ]);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

    expect(r.status).not.toBe(0);
    // The unnarrowed read: the UNKNOWN member has no `id`.
    expect(out).toMatch(/TS2339/);
    // The unhandled state: it does not reduce to `never`.
    expect(out).toMatch(/TS2322/);
    expect(out).toMatch(/not assignable to type 'never'/);
    // It must name the state that was left unhandled, not fail generically.
    expect(out).toMatch(/UnknownState/);
  }, 120_000);
});
