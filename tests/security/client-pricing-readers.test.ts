import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Finance DB closure M2 (precedes 0303). client_pricing is readable through the Data API only by the studio
// OWNER. A user-token reader reachable by a non-owner would silently read zero rows, and the price
// resolvers read zero rows as "no custom price" (a positive custom price vanishes). So every
// application reader must be either on the service role (receiver admin*, or an inline
// createAdminClient()) or in a file on the OWNER-GATED list below. A new reader outside both fails here.

const ROOT = join(__dirname, "..", "..");
const DIRS = ["app", "lib", "components"];
// User-client readers that are owner-gated by their callers (viewerIsOwner / role === "owner" checks).
export const OWNER_GATED = new Set([
  "app/(app)/settings/data/actions.ts",
  "lib/dashboard/unpaid-attention.ts",
  "lib/supabase/queries.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const READER = /([\w)(]+)\s*\n?\s*\.from\(\s*["']client_pricing["']\s*\)\s*\n?\s*\.(select|insert|update|delete|upsert)\b/g;

export function findPricingReaders(files: Array<{ file: string; text: string }>) {
  const hits: { file: string; receiver: string; op: string }[] = [];
  for (const { file, text } of files) {
    for (const m of text.matchAll(READER)) hits.push({ file, receiver: m[1], op: m[2] });
  }
  return hits;
}

export function badReaders(hits: ReturnType<typeof findPricingReaders>) {
  return hits.filter(
    (h) => h.op === "select" && !OWNER_GATED.has(h.file) && !/^admin\w*$/.test(h.receiver) && !/createAdminClient\(\)$/.test(h.receiver),
  );
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d))).map((f) => ({ file: f.slice(ROOT.length + 1), text: readFileSync(f, "utf8") }));

describe("client_pricing readers (finance M2)", () => {
  const hits = findPricingReaders(files);

  it("finds the known readers (the guard is not vacuous)", () => {
    expect(hits.filter((h) => h.op === "select").length).toBeGreaterThanOrEqual(6);
  });

  it("every select is on the service role or in an owner-gated file", () => {
    expect(badReaders(hits)).toEqual([]);
  });

  it("negative control: a user-client select in a non-gated file IS flagged", () => {
    const fake = findPricingReaders([{ file: "lib/billing/new-reader.ts", text: 'const r = await supabase\n  .from("client_pricing")\n  .select("*");' }]);
    expect(badReaders(fake)).toHaveLength(1);
    const ok = findPricingReaders([{ file: "lib/billing/new-reader.ts", text: 'await createAdminClient()\n  .from("client_pricing")\n  .select("*");' }]);
    expect(badReaders(ok)).toEqual([]);
  });
});
