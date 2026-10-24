import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// HON-46 (photos, first slice). A per-client procedure print shows, on screen
// only, how many photos are linked to each visit. These tests pin the count,
// the exact scope of the read, that a failed read is never shown as "none",
// and that nothing photo-related reaches the printed document.

type Call = [string, ...unknown[]];
type Row = { id: string; session_id: string | null };
const calls: Call[] = [];
// The fake server: the rows that match, the API row cap it enforces, and an
// optional error on the Nth range() call.
let dataset: Row[] = [];
let serverCap = 1000;
let errorOnRangeCall: number | null = null;
let rangeCalls = 0;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const chain = {
      from: (t: string) => (calls.push(["from", t]), chain),
      select: (c: string) => (calls.push(["select", c]), chain),
      eq: (c: string, v: unknown) => (calls.push(["eq", c, v]), chain),
      in: (c: string, v: unknown) => (calls.push(["in", c, v]), chain),
      is: (c: string, v: unknown) => (calls.push(["is", c, v]), chain),
      order: (c: string, o: unknown) => (calls.push(["order", c, o]), chain),
      range: (from: number, to: number) => {
        calls.push(["range", from, to]);
        rangeCalls += 1;
        if (errorOnRangeCall === rangeCalls) {
          return Promise.resolve({ data: null, error: { code: "57014" } });
        }
        const end = Math.min(to + 1, from + serverCap);
        return Promise.resolve({ data: dataset.slice(from, end), error: null });
      },
    };
    return chain;
  },
}));

function rowsFor(sessionId: string, n: number, start = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${sessionId}-${String(start + i).padStart(6, "0")}`,
    session_id: sessionId,
  }));
}

import {
  countLinkedPhotos,
  LINKED_PHOTO_MAX_PAGES,
  LINKED_PHOTO_PAGE_SIZE,
  linkedPhotoLine,
  loadLinkedPhotoCounts,
} from "@/lib/images/linked-photo-counts";

beforeEach(() => {
  calls.length = 0;
  dataset = [];
  serverCap = 1000;
  errorOnRangeCall = null;
  rangeCalls = 0;
});

describe("countLinkedPhotos", () => {
  it("counts per visit, gives every printed visit an entry, ignores others", () => {
    const counts = countLinkedPhotos(
      [
        { session_id: "s1" },
        { session_id: "s1" },
        { session_id: "s3" },
        { session_id: "other-visit" },
        { session_id: null },
      ],
      ["s1", "s2", "s3"],
    );
    expect([...counts.entries()]).toEqual([
      ["s1", 2],
      ["s2", 0],
      ["s3", 1],
    ]);
  });
});

describe("loadLinkedPhotoCounts", () => {
  it("reads only this studio's, this client's, these visits' LIVE photo rows, in stable id order", async () => {
    dataset = [...rowsFor("s1", 2), ...rowsFor("s2", 1)];
    const out = await loadLinkedPhotoCounts("studio-1", "client-1", ["s1", "s2"]);
    expect(calls.slice(0, 8)).toEqual([
      ["from", "treatment_images"],
      ["select", "id, session_id"],
      ["eq", "studio_id", "studio-1"],
      ["eq", "client_id", "client-1"],
      ["in", "session_id", ["s1", "s2"]],
      ["is", "deleted_at", null],
      ["order", "id", { ascending: true }],
      ["range", 0, LINKED_PHOTO_PAGE_SIZE - 1],
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) expect([...out.bySession.entries()]).toEqual([["s1", 2], ["s2", 1]]);
  });

  it("counts EVERY row past the API row cap (Codex P2 / Team L1): no silent undercount", async () => {
    dataset = [...rowsFor("s1", 1500), ...rowsFor("s2", 700)];
    const out = await loadLinkedPhotoCounts("studio-1", "client-1", ["s1", "s2"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect([...out.bySession.entries()]).toEqual([["s1", 1500], ["s2", 700]]);
  });

  it("a server cap SMALLER than the page size shortens pages but cannot end the loop early", async () => {
    serverCap = 300; // e.g. a hosted max_rows lower than the local 1000
    dataset = rowsFor("s1", 1250);
    const out = await loadLinkedPhotoCounts("studio-1", "client-1", ["s1"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.bySession.get("s1")).toBe(1250);
    const ranges = calls.filter((c) => c[0] === "range").map((c) => c[1]);
    // The cursor advances by rows actually returned; only an empty page stops it.
    expect(ranges).toEqual([0, 300, 600, 900, 1200, 1250]);
  });

  it("an error on ANY page is 'could not check', never a partial count", async () => {
    dataset = rowsFor("s1", 2500);
    errorOnRangeCall = 2;
    expect(await loadLinkedPhotoCounts("studio-1", "client-1", ["s1"])).toEqual({ ok: false });
  });

  it("more pages than the bound is 'could not check', never a confident number", async () => {
    serverCap = 1;
    dataset = rowsFor("s1", LINKED_PHOTO_MAX_PAGES + 5);
    expect(await loadLinkedPhotoCounts("studio-1", "client-1", ["s1"])).toEqual({ ok: false });
  });

  it("no visits means no query", async () => {
    const out = await loadLinkedPhotoCounts("studio-1", "client-1", []);
    expect(calls).toEqual([]);
    expect(out.ok).toBe(true);
  });
});

describe("linkedPhotoLine", () => {
  it("states the count, that photos are not printed, and an unknown read honestly", () => {
    expect(linkedPhotoLine(0)).toBe("No photos linked to this visit.");
    expect(linkedPhotoLine(1)).toBe(
      "1 photo is linked to this visit. Photos are not included in this printout.",
    );
    expect(linkedPhotoLine(3)).toBe(
      "3 photos are linked to this visit. Photos are not included in this printout.",
    );
    expect(linkedPhotoLine(undefined)).toBe("Linked photos could not be checked.");
  });
});

describe("the print page (source)", () => {
  const code = readFileSync("app/(app)/records/print/page.tsx", "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const lib = readFileSync("lib/images/linked-photo-counts.ts", "utf8");

  it("loads counts only for a per-client pull", () => {
    expect(code).toMatch(
      /const photoCounts = filter\.clientId\s*\?\s*await loadLinkedPhotoCounts\(\s*studioId,\s*filter\.clientId,/,
    );
  });

  it("the note is screen-only (print:hidden) and links to the client's photos page", () => {
    const note = code.slice(code.indexOf('data-testid="linked-photos-note"') - 40);
    const block = note.slice(0, note.indexOf("</p>"));
    expect(block).toContain("print:hidden");
    expect(block).toContain("href={`/clients/${r.clientId}/images`}");
  });

  it("puts no image, signed URL, storage path or filename into the print", () => {
    expect(code).not.toMatch(/<img\b|createSignedUrl|storage_path|original_filename|signedUrl/);
    expect(code).not.toMatch(/createAdminClient|service[_-]?role/i);
  });

  it("the loader uses the RLS client, never the admin client or storage", () => {
    expect(lib).toContain('import { createClient } from "@/lib/supabase/server"');
    expect(lib).not.toMatch(/createAdminClient|\.storage\b|createSignedUrl/);
  });
});
