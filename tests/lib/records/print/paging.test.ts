import { describe, expect, it } from "vitest";
import { readAllPages } from "@/lib/records/print/paging";

type Row = { id: string };
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: String(i + 1).padStart(5, "0") }));

/** A fake store that honours the keyset contract and caps every response, like PostgREST max_rows. */
function store(all: Row[], pageSize: number) {
  const calls: Array<string | null> = [];
  const page = (after: string | null) => {
    calls.push(after);
    const data = all.filter((r) => after === null || r.id > after).slice(0, pageSize);
    return Promise.resolve({ data, error: null as unknown });
  };
  return { page, calls };
}

describe("readAllPages", () => {
  it("reads past the first page: 2,500 rows at a 1,000 cap are all returned, in order", async () => {
    const all = rows(2500);
    const { page, calls } = store(all, 1000);
    const out = await readAllPages(page, { pageSize: 1000 });
    expect(out).toEqual(all);
    expect(calls).toEqual([null, "01000", "02000"]);
  });
  it("an exact multiple of the page size needs one more (empty) read to know it is done", async () => {
    const all = rows(2000);
    const { page, calls } = store(all, 1000);
    expect(await readAllPages(page, { pageSize: 1000 })).toEqual(all);
    expect(calls).toHaveLength(3);
  });
  it("a short or empty first page is complete", async () => {
    expect(await readAllPages(store(rows(3), 1000).page, { pageSize: 1000 })).toEqual(rows(3));
    expect(await readAllPages(store([], 1000).page, { pageSize: 1000 })).toEqual([]);
  });
  it("fails closed (null, not partial rows) on a read error mid-way", async () => {
    let n = 0;
    const out = await readAllPages(
      () => Promise.resolve(++n === 1 ? { data: rows(2), error: null } : { data: null, error: new Error("boom") }),
      { pageSize: 2 },
    );
    expect(out).toBeNull();
  });
  it("fails closed when data is null without an error", async () => {
    expect(await readAllPages(() => Promise.resolve({ data: null, error: null }))).toBeNull();
  });
  it("fails closed when the cursor does not advance (would loop forever)", async () => {
    const same = rows(2);
    expect(await readAllPages(() => Promise.resolve({ data: same, error: null }), { pageSize: 2, maxPages: 10 })).toBeNull();
  });
  it("fails closed on saturation: more than maxPages pages", async () => {
    const { page } = store(rows(50), 5);
    expect(await readAllPages(page, { pageSize: 5, maxPages: 3 })).toBeNull();
  });
  it("fails closed if a page returns more rows than the page size", async () => {
    expect(await readAllPages(() => Promise.resolve({ data: rows(3), error: null }), { pageSize: 2 })).toBeNull();
  });
  it("anti-vacuity: a single unpaged read of the same store drops rows, which is what this guards against", async () => {
    const all = rows(2500);
    const { page } = store(all, 1000);
    const first = (await page(null)).data;
    expect(first).toHaveLength(1000);
    expect((await readAllPages(page, { pageSize: 1000 }))?.length).toBe(2500);
  });
});
