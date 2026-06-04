import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// PR #155: lib/supabase/admin-server.ts holds the SUPABASE_SERVICE_ROLE_KEY
// reader. If a "use client" module ever imports it the service-role key
// would be exposed to the browser bundle. Two defences in this file:
//   1. The admin-server module itself starts with `import "server-only";`
//      so a client import fails at build time.
//   2. We also source-grep every "use client" file in the tree to confirm
//      none of them transitively import the admin client. If a future PR
//      adds a client-side import the grep test fails before the build
//      gate fires.

const REPO_ROOT = path.resolve(__dirname, "../../..");
const ADMIN_PATH = path.join(REPO_ROOT, "lib/supabase/admin-server.ts");
const ADMIN_SOURCE = readFileSync(ADMIN_PATH, "utf8");

describe("lib/supabase/admin-server.ts has the server-only boundary", () => {
  it("starts with (or contains near the top) `import \"server-only\";`", () => {
    // The exact line must appear in the first 50 lines so a future
    // refactor cannot accidentally remove it without this test firing.
    const head = ADMIN_SOURCE.split("\n").slice(0, 50).join("\n");
    expect(head).toMatch(/^\s*import\s+"server-only";/m);
  });

  it("still exports createAdminClient", () => {
    expect(ADMIN_SOURCE).toMatch(/export function createAdminClient\(/);
  });
});

// ---------------------------------------------------------------------------
// No `"use client"` file imports the admin client.
// ---------------------------------------------------------------------------

const SCAN_DIRS = ["app", "lib", "components"];
const INCLUDE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "tests",
]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = path.join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walk(full);
    } else if (stats.isFile() && INCLUDE_EXTENSIONS.has(path.extname(full))) {
      yield full;
    }
  }
}

const ADMIN_SERVER_SOURCE_RELATIVE = "lib/supabase/admin-server.ts";

// Match a real `"use client"` directive at the top of the file, not the
// literal string appearing in a comment somewhere. The directive is a
// statement that must precede every import; we allow leading whitespace
// or block/line comments before it. A naive `"use client"` substring
// search produced false positives on a comment in admin-server.ts that
// itself describes the boundary it enforces.
function hasUseClientDirective(source: string): boolean {
  // Skip leading whitespace + comments.
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const eol = source.indexOf("\n", i);
      i = eol === -1 ? source.length : eol + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return (
    source.startsWith('"use client"', i) || source.startsWith("'use client'", i)
  );
}

// Match a real `import` statement that resolves to the admin-server
// module. Comments that mention the module by name are NOT a real
// import; QuickBookDrawer.tsx for example contains the literal word
// `createAdminClient` in a comment that explicitly says "no
// createAdminClient" and must not be flagged.
const ADMIN_IMPORT_REGEX =
  /^\s*import\s+[^;]*\bfrom\s+["'][^"']*lib\/supabase\/admin-server["']/m;

function findClientFilesImportingAdminServer(): string[] {
  const offenders: string[] = [];
  for (const root of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, root);
    for (const file of walk(abs)) {
      const rel = path.relative(REPO_ROOT, file);
      // Don't flag the boundary module itself.
      if (rel === ADMIN_SERVER_SOURCE_RELATIVE) continue;
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!hasUseClientDirective(source)) continue;
      if (ADMIN_IMPORT_REGEX.test(source)) {
        offenders.push(rel);
      }
    }
  }
  return offenders;
}

describe("no client component imports the Supabase admin client", () => {
  it("returns an empty offender list", () => {
    const offenders = findClientFilesImportingAdminServer();
    expect(offenders).toEqual([]);
  });
});
