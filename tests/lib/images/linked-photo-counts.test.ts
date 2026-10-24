import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// HON-46 (photos, first slice). A per-client procedure print shows, on screen
// only, how many photos are linked to each visit. These tests pin the count,
// the exact scope of the read, that a failed read is never shown as "none",
// and that nothing photo-related reaches the printed document.

type Call = [string, ...unknown[]];
const calls: Call[] = [];
let result: { data: Array<{ session_id: string | null }> | null; error: unknown } = {
  data: [],
  error: null,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const chain = {
      from: (t: string) => (calls.push(["from", t]), chain),
      select: (c: string) => (calls.push(["select", c]), chain),
      eq: (c: string, v: unknown) => (calls.push(["eq", c, v]), chain),
      in: (c: string, v: unknown) => (calls.push(["in", c, v]), chain),
      is: (c: string, v: unknown) => (calls.push(["is", c, v]), Promise.resolve(result)),
    };
    return chain;
  },
}));

import {
  countLinkedPhotos,
  linkedPhotoLine,
  loadLinkedPhotoCounts,
} from "@/lib/images/linked-photo-counts";

beforeEach(() => {
  calls.length = 0;
  result = { data: [], error: null };
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
  it("reads only this studio's, this client's, these visits' LIVE photo rows, and only session_id", async () => {
    result = { data: [{ session_id: "s1" }, { session_id: "s2" }, { session_id: "s1" }], error: null };
    const out = await loadLinkedPhotoCounts("studio-1", "client-1", ["s1", "s2"]);
    expect(calls).toEqual([
      ["from", "treatment_images"],
      ["select", "session_id"],
      ["eq", "studio_id", "studio-1"],
      ["eq", "client_id", "client-1"],
      ["in", "session_id", ["s1", "s2"]],
      ["is", "deleted_at", null],
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) expect([...out.bySession.entries()]).toEqual([["s1", 2], ["s2", 1]]);
  });

  it("a read error is 'could not check', never zero photos", async () => {
    result = { data: null, error: { code: "42501" } };
    expect(await loadLinkedPhotoCounts("studio-1", "client-1", ["s1"])).toEqual({ ok: false });
    result = { data: null, error: null };
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
