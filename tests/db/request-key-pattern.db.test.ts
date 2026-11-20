import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import { REQUEST_KEY_SQL_PATTERN } from "../../lib/booking/request-key";
import { REQUEST_KEY_VECTORS } from "../fixtures/request-key-vectors";

// The booking request key is checked in the database with PostgreSQL's `~` and an END-ANCHORED pattern. This proves, with the SAME vectors the
// TypeScript rule is tested against, that the database accepts and rejects exactly the same strings. The case that matters most is the trailing newline:
// in some regex dialects `$` also matches just before a final newline, which would let "<32 hex>\n" through as a second spelling of one key.
// Read-only (select of a constant); it writes nothing.

afterAll(async () => {
  await closePool();
});

describe("PostgreSQL `~` with the end-anchored key pattern agrees with the shared vectors", () => {
  const strings = REQUEST_KEY_VECTORS.filter((v) => typeof v.input === "string");

  for (const v of strings) {
    it(`${v.valid ? "accepts" : "rejects"}: ${v.name}`, async () => {
      const input = v.input as string;
      if (input.includes("\u0000")) {
        // PostgreSQL text cannot hold a NUL: the value cannot reach the pattern at all, which is a rejection.
        await expect(adminQuery(`select $1::text ~ $2::text as ok`, [input, REQUEST_KEY_SQL_PATTERN])).rejects.toBeDefined();
        return;
      }
      const r = await adminQuery(`select $1::text ~ $2::text as ok`, [input, REQUEST_KEY_SQL_PATTERN]);
      expect(r.rows[0].ok).toBe(v.valid);
    });
  }

  it("the trailing-newline vector is in the shared set (so this proof cannot pass by omission)", () => {
    expect(strings.some((v) => v.input === "0123456789abcdef0123456789abcdef\n")).toBe(true);
  });

  it("and a start/end-less variant WOULD have accepted the newline-free embeds, so the anchors are what is under test", async () => {
    const r = await adminQuery(`select ('x' || repeat('a',32)) ~ '[0-9a-f]{32}' as loose, ('x' || repeat('a',32)) ~ $1::text as strict`, [REQUEST_KEY_SQL_PATTERN]);
    expect(r.rows[0]).toEqual({ loose: true, strict: false });
  });
});
