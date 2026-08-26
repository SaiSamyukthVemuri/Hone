import { describe, expect, it } from "vitest";
import {
  fetchExportRows,
  mapExportRows,
  provenanceOf,
  rowsForResource,
  selectedColumnsByResource,
  readFinalSelect,
} from "@/lib/export/provenance";

// ===========================================================================
// ROWS MUST CARRY THE QUERY THAT PRODUCED THEM
// ===========================================================================
//
// Codex P2 on 327b3487: `writeCsv(resource, rows)` took a bare array, so rows
// fetched for one resource could be serialized as another whenever the
// DESTINATION already had a recorded select. The recorded-select check could
// not see it — it only ever asked "does this resource have a select?", never
// "did these rows come from it?".
//
// These exercise `rowsForResource`, which is the function `writeCsv` calls, so
// this is the real write-side guard and not a restatement of it.

/** A page factory shaped like postgrest-js: thenable, with a request URL. */
function page<T>(table: string, select: string, rows: T[], perPage?: string[]) {
  let call = 0;
  return () => {
    const url = new URL(`http://stub/${table}`);
    url.searchParams.set("select", perPage ? perPage[call++] ?? select : select);
    return Object.assign(Promise.resolve({ data: rows, error: null }), { url });
  };
}

const CLIENT_ROWS = [{ id: "c1", name: "Ada" }];
const SESSION_ROWS = [{ id: "s1", client_id: "c1" }];

async function clientsRead() {
  return fetchExportRows("clients", page("clients", "id, name", CLIENT_ROWS));
}
async function sessionsRead() {
  return fetchExportRows("sessions", page("sessions", "id, client_id", SESSION_ROWS));
}

describe("query provenance: rows are bound to the query that produced them", () => {
  it("CONTROL A — swapping results between two exported resources is caught", async () => {
    const clients = await clientsRead();
    const sessions = await sessionsRead();
    // Each is fine written as itself...
    expect(rowsForResource("clients", clients)).toEqual(CLIENT_ROWS);
    expect(rowsForResource("sessions", sessions)).toEqual(SESSION_ROWS);
    // ...and neither may be written as the other, even though BOTH resources
    // have a perfectly good recorded SELECT. That is precisely the case the
    // previous check waved through.
    expect(() => rowsForResource("sessions", clients)).toThrow(
      /rows produced for clients cannot be written as sessions/,
    );
    expect(() => rowsForResource("clients", sessions)).toThrow(
      /rows produced for sessions cannot be written as clients/,
    );
  });

  it("CONTROL B — transforming rows and writing them back is unaffected", async () => {
    const clients = await clientsRead();
    const joined = mapExportRows(clients, (rows) =>
      rows.map((r) => ({ ...r, display: r.name.toUpperCase() })),
    );
    expect(rowsForResource("clients", joined)).toEqual([
      { id: "c1", name: "Ada", display: "ADA" },
    ]);
  });

  it("CONTROL C — transforming rows does NOT launder them into another resource", async () => {
    const clients = await clientsRead();
    const joined = mapExportRows(clients, (rows) => rows.map((r) => ({ ...r })));
    // The join step is exactly where the binding used to be lost.
    expect(() => rowsForResource("sessions", joined)).toThrow(
      /rows produced for clients cannot be written as sessions/,
    );
  });

  it("CONTROL D — an EMPTY result still carries enough provenance to detect a swap", async () => {
    const empty = await fetchExportRows("clients", page("clients", "id, name", []));
    expect(rowsForResource("clients", empty)).toEqual([]);
    expect(() => rowsForResource("sessions", empty)).toThrow(
      /rows produced for clients cannot be written as sessions/,
    );
    // Zero rows is a real answer, not a missing one: the select is still there.
    expect(provenanceOf(empty)?.select).toBe("id, name");
  });

  it("CONTROL E — arbitrary plain rows cannot satisfy another query's contract", () => {
    expect(() =>
      rowsForResource("clients", [{ id: "c1" }] as never),
    ).toThrow(/carry no query provenance/);
    // Nor can an object hand-shaped to look like an envelope.
    const impostor = {
      data: CLIENT_ROWS,
      error: null,
      provenance: { resource: "clients", select: "id, name" },
    };
    expect(provenanceOf(impostor)).toBeNull();
    expect(() => rowsForResource("clients", impostor as never)).toThrow(
      /carry no query provenance/,
    );
  });

  it("CONTROL F — an auxiliary lookup cannot be written as an exported resource", async () => {
    // The practitioners display-name LOOKUP is a plain read: no envelope. The
    // practitioners EXPORT has a recorded select, and under the old check that
    // was enough to let the lookup's rows through.
    const lookup = { data: [{ id: "p1", display_name: "Ada" }], error: null };
    expect(() => rowsForResource("practitioners", lookup as never)).toThrow(
      /carry no query provenance/,
    );
  });
});

describe("query provenance: the select is read off the request", () => {
  it("captures the FINAL select, not the first one handed over", () => {
    const url = new URL("http://stub/clients");
    url.searchParams.set("select", "id,name,email");
    url.searchParams.set("select", "id"); // a later .select() replaces it
    expect(readFinalSelect({ url })).toBe("id");
  });

  it("refuses when the request cannot be inspected, rather than auditing nothing", async () => {
    const opaque = await fetchExportRows("clients", () =>
      Promise.resolve({ data: [], error: null }),
    );
    expect(opaque.data).toBeNull();
    expect(opaque.error?.message).toMatch(/could not read the executed SELECT/);
  });

  it("refuses when pages disagree about what they selected", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}` }));
    const read = await fetchExportRows(
      "clients",
      page("clients", "id, name", rows, ["id, name", "id"]),
      { pageSize: 1000 },
    );
    expect(read.error?.message).toMatch(/page selects disagree/);
  });

  it("feeds the registry audit in the shape it consumes", async () => {
    const clients = await clientsRead();
    const sessions = await sessionsRead();
    expect(selectedColumnsByResource([clients, sessions])).toEqual({
      clients: ["id", "name"],
      sessions: ["id", "client_id"],
    });
  });
});
