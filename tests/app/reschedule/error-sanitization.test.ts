import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #149: a public token route MUST NOT return raw DB or RPC error
// text to the client. The reschedule action file is the surface that
// has historically leaked `error.message`, `lookupErr.message`, and
// `rpcErr.message`. We codify "no raw .message leak" as a textual
// invariant of the file so a regression PR that re-introduces the
// pattern is caught by `npm test`.

const ACTIONS_PATH = path.resolve(
  __dirname,
  "../../../app/reschedule/[token]/actions.ts",
);
const ACTIONS_SOURCE = readFileSync(ACTIONS_PATH, "utf8");

function countMatches(haystack: string, needle: RegExp): number {
  const m = haystack.match(needle);
  return m ? m.length : 0;
}

describe("reschedule actions do not return raw DB / RPC error text", () => {
  it("never `return { ok: false, error: <ident>.message ... }` (no plain access)", () => {
    // Pattern: a return literal whose error field directly takes a
    // DB/RPC error's .message. The body after `error:` may close with
    // `}`, `,`, `??`, or newline; we anchor on `.message` after an
    // identifier. We allow `logInternal({ message: ... })` for the
    // structured server log, which is on a different line shape.
    const hits = countMatches(
      ACTIONS_SOURCE,
      /return\s*\{\s*ok:\s*false,\s*error:\s*[A-Za-z_$][A-Za-z0-9_$]*\.message/g,
    );
    expect(hits).toBe(0);
  });

  it("never `return { ok: false, error: <ident>?.message ... }` (no optional chain)", () => {
    // PR #155: the prior regex set caught only the plain `.message`
    // shape. `fetchErr?.message` slipped through because the optional
    // chaining marker `?` between the identifier and `.message` was
    // not in the alternation. This test covers the exact regression
    // PR #155 fixed at app/reschedule/[token]/actions.ts:762.
    const hits = countMatches(
      ACTIONS_SOURCE,
      /return\s*\{\s*ok:\s*false,\s*error:\s*[A-Za-z_$][A-Za-z0-9_$]*\?\.message/g,
    );
    expect(hits).toBe(0);
  });

  it("never `return { ok: false, error: lookupErr(?)?.message }`", () => {
    const hits = countMatches(
      ACTIONS_SOURCE,
      /return\s*\{\s*ok:\s*false,\s*error:\s*lookupErr\??\.message/g,
    );
    expect(hits).toBe(0);
  });

  it("never `return { ok: false, error: rpcErr(?)?.message }`", () => {
    const hits = countMatches(
      ACTIONS_SOURCE,
      /return\s*\{\s*ok:\s*false,\s*error:\s*rpcErr\??\.message/g,
    );
    expect(hits).toBe(0);
  });

  it("never `return { ok: false, error: fetchErr(?)?.message }`", () => {
    const hits = countMatches(
      ACTIONS_SOURCE,
      /return\s*\{\s*ok:\s*false,\s*error:\s*fetchErr\??\.message/g,
    );
    expect(hits).toBe(0);
  });

  it("references the generic public copy at least once", () => {
    // The constant lives at the top of the file. The action file
    // must keep referencing it (the easiest way to verify the
    // generic-collapse pattern is in use).
    expect(ACTIONS_SOURCE).toMatch(/PUBLIC_RESCHEDULE_GENERIC_ERROR/);
  });

  it("uses logInternal to record structured server-side errors", () => {
    // PR #149 added a logInternal helper used to capture DB / RPC
    // failure detail server-side without exposing it to the client.
    expect(ACTIONS_SOURCE).toMatch(/logInternal\(/);
  });
});
