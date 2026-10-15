import { describe, expect, it } from "vitest";
import {
  grantedRoles,
  revokedRoles,
  REQUIRED_REVOKES,
  BLANKET_FUNCTION_GRANT,
} from "./helpers/grant-posture";

// The matcher that every exact grant-posture assertion now depends on, tested
// directly against adversarial SQL rather than only through the two migrations
// that use it.
//
// WHY THIS FILE EXISTS. `grantedRoles` is the thing standing between a stray
// `grant ... to public;` and a green suite, so "it works today" is not enough:
// a later refactor to line-based parsing, or a tightened regex, could silently
// reopen the hole it was written to close, and the per-migration assertions
// would keep passing because their own sources are clean. These cases pin the
// behaviour the assertions ASSUME.
//
// The same-line case came from the Sentry lane, which hit it on its own
// matcher: a grant that follows another statement on one line is invisible to
// anything anchored at line start. It is covered here because this matcher is
// statement-shaped rather than line-shaped, and now it stays covered.

const FN = "f";
const ARGS = "uuid";
const g = (sql: string) => grantedRoles(sql, FN, ARGS);

describe("grantedRoles finds a grant wherever it is written", () => {
  it("on the SAME LINE after another statement", () => {
    // Anything anchored at line start misses this. The revoke is present and
    // correct; the grant beside it is the whole defect.
    expect(
      g(
        `revoke execute on function public.f(uuid) from public; grant execute on function public.f(uuid) to public;`,
      ),
    ).toEqual(["public"]);
  });

  it("twice on one line", () => {
    expect(
      g(
        `grant execute on function public.f(uuid) to service_role; grant execute on function public.f(uuid) to anon;`,
      ),
    ).toEqual(["anon", "service_role"]);
  });

  it("trailing a long line, with `grant all` rather than `grant execute`", () => {
    // The privilege word is not fixed: `all` and `all privileges` grant execute
    // too, so a matcher hard-coded to "grant execute" is another way past.
    expect(
      g(`set local lock_timeout = '5s'; commit; grant all on function public.f(uuid) to postgres;`),
    ).toEqual(["postgres"]);
    expect(g(`grant all privileges on function public.f(uuid) to authenticator;`)).toEqual([
      "authenticator",
    ]);
  });

  it("split across newlines inside the statement", () => {
    expect(g(`grant execute\n  on function public.f(\n  uuid\n) to\n  public;`)).toEqual([
      "public",
    ]);
  });

  it("as a comma-separated role list", () => {
    // `to service_role, anon;` slips past a matcher built for one role per
    // statement -- it would report only the first.
    expect(g(`x; grant execute on function public.f(uuid) to service_role, authenticator;`)).toEqual(
      ["authenticator", "service_role"],
    );
  });

  it("with a quoted role name, and in mixed case", () => {
    expect(g(`GRANT EXECUTE ON FUNCTION public.f(uuid) TO "public";`)).toEqual(["public"]);
  });
});

describe("grantedRoles does not depend on how the signature is SPELLED", () => {
  // Measured by the History lane and then reproduced here: before
  // `normalizeSql`, the matcher tolerated whitespace between KEYWORDS but
  // matched the argument list as an escaped literal, so the separator had to be
  // exactly `, `. Each spelling below is legal SQL for the same function, and
  // each one hid a grant to `public` while the exact-set assertion stayed green
  // -- the original hole, reopened from another door.
  //
  // Multi-argument on purpose: 0222 and 0225 both have multi-argument
  // signatures, so this was live for them and not a hypothetical.
  const MULTI = "uuid, uuid, timestamptz";
  const gm = (sql: string) => grantedRoles(sql, "f", MULTI);

  it("extra whitespace between keywords", () => {
    expect(
      gm(`grant  execute   on  function  public.f(uuid, uuid, timestamptz)  to  public;`),
    ).toEqual(["public"]);
  });

  it("the signature reformatted across lines", () => {
    expect(
      gm(`grant execute on function public.f(\n  uuid,\n  uuid,\n  timestamptz\n) to public;`),
    ).toEqual(["public"]);
  });

  it("two spaces after each comma", () => {
    expect(gm(`grant execute on function public.f(uuid,  uuid,  timestamptz) to public;`)).toEqual([
      "public",
    ]);
  });

  it("no space after the comma at all", () => {
    expect(gm(`grant execute on function public.f(uuid,uuid,timestamptz) to public;`)).toEqual([
      "public",
    ]);
  });

  it("a space before the opening paren", () => {
    expect(gm(`grant execute on function public.f (uuid, uuid, timestamptz) to public;`)).toEqual([
      "public",
    ]);
  });

  it("and the NEEDLE may be spelled differently too", () => {
    // The caller writes ARGS by hand in each migration test. If only the source
    // were normalised, a hand-written needle with odd spacing would silently
    // match nothing -- a green assertion over zero grants, which is the worst
    // outcome of the set.
    expect(gm(`grant execute on function public.f(uuid, uuid, timestamptz) to public;`)).toEqual([
      "public",
    ]);
    expect(
      grantedRoles(
        `grant execute on function public.f(uuid, uuid, timestamptz) to public;`,
        "f",
        "uuid,uuid,  timestamptz",
      ),
      "a differently-spelled needle must still find the grant",
    ).toEqual(["public"]);
  });

  it("STILL does not over-match across overloads once normalised", () => {
    // Normalising must not blur `f(uuid)` into `f(uuid, uuid)`. If it did, the
    // exact assertions would red for innocent reasons and the fix would be
    // loosened again.
    expect(grantedRoles(`grant execute on function public.f(uuid,uuid) to public;`, "f", "uuid")).toEqual(
      [],
    );
    expect(gm(`grant execute on function public.f(uuid, uuid) to public;`)).toEqual([]);
  });
});

describe("grantedRoles does not OVER-match, which would be its own failure mode", () => {
  // A matcher that reports grants belonging to a DIFFERENT function would make
  // every exact assertion red for innocent reasons, and the obvious response
  // would be to loosen it again.
  it("ignores a different function with a similar name", () => {
    expect(g(`grant execute on function public.f_extra(uuid) to public;`)).toEqual([]);
    expect(g(`grant execute on function public.fx(uuid) to public;`)).toEqual([]);
  });

  it("ignores a different OVERLOAD of the same name", () => {
    // 0222 and 0225 both sit beside overloads; binding to the exact argument
    // list is what makes the assertion about ONE signature.
    expect(g(`grant execute on function public.f(uuid, uuid) to public;`)).toEqual([]);
    expect(g(`grant execute on function public.f() to public;`)).toEqual([]);
  });

  it("ignores a REVOKE, which every one of these files has for public", () => {
    expect(g(`revoke execute on function public.f(uuid) from public;`)).toEqual([]);
  });

  it("ignores a grant on a TABLE of the same name", () => {
    expect(g(`grant select on table public.f to anon;`)).toEqual([]);
  });
});

describe("the caller must strip comments — the helper cannot", () => {
  it("counts a commented-out grant in RAW source, which is why callers pass stripped SQL", () => {
    // Recorded as a property, not a bug: these migrations carry long prose ABOUT
    // grants, and the assertions this helper replaced read raw `sql` and so
    // counted commented text. The two call sites now pass comment-stripped
    // source; this test exists so that contract is visible rather than implied.
    const raw = `-- grant execute on function public.f(uuid) to public;`;
    expect(g(raw)).toEqual(["public"]);
    const stripped = raw.replace(/--[^\n]*/g, " ");
    expect(g(stripped)).toEqual([]);
  });
});

describe("BLANKET_FUNCTION_GRANT catches what no per-signature check can see", () => {
  it("matches a schema-wide function grant", () => {
    expect(`grant execute on all functions in schema public to anon;`).toMatch(
      BLANKET_FUNCTION_GRANT,
    );
    expect(`GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticator;`).toMatch(
      BLANKET_FUNCTION_GRANT,
    );
  });

  it("is invisible to grantedRoles, which is the reason it is a separate guard", () => {
    // The function under test is granted without ever being named, so the
    // per-signature matcher correctly reports nothing -- and would leave the
    // exact-set assertion green.
    expect(g(`grant execute on all functions in schema public to anon;`)).toEqual([]);
  });

  it("does not match an ordinary per-function grant", () => {
    expect(`grant execute on function public.f(uuid) to service_role;`).not.toMatch(
      BLANKET_FUNCTION_GRANT,
    );
  });
});

describe("ON ROUTINE is the same privilege under a different legal spelling", () => {
  // PostgreSQL documents both `ON FUNCTION` and `ON ROUTINE`, and both grant
  // EXECUTE. A matcher that knows only FUNCTION leaves every exact-set
  // assertion green while the extra role can execute -- the hole this helper
  // exists to close, reached by a keyword instead of by whitespace. Third
  // distinct evasion of the same guard, so the spellings are now enumerated
  // rather than assumed.
  it("finds a stray grant written ON ROUTINE", () => {
    expect(grantedRoles(`grant execute on routine public.f(uuid) to public;`, "f", "uuid")).toEqual(
      ["public"],
    );
    expect(
      grantedRoles(`GRANT ALL ON ROUTINE public.f(uuid) TO authenticator;`, "f", "uuid"),
    ).toEqual(["authenticator"]);
  });

  it("finds a REVOKE written ON ROUTINE", () => {
    expect(revokedRoles(`revoke execute on routine public.f(uuid) from anon;`, "f", "uuid")).toEqual(
      ["anon"],
    );
  });

  it("treats ALL ROUTINES IN SCHEMA as a blanket grant", () => {
    expect(`grant execute on all routines in schema public to anon;`).toMatch(
      BLANKET_FUNCTION_GRANT,
    );
    expect(`GRANT ALL ON ALL ROUTINES IN SCHEMA public TO authenticator;`).toMatch(
      BLANKET_FUNCTION_GRANT,
    );
  });
});

describe("revokedRoles — the companion that was left raw", () => {
  const FOUR = `revoke execute on function public.f(uuid) from public;
revoke execute on function public.f(uuid) from anon;
revoke execute on function public.f(uuid) from authenticated;
revoke execute on function public.f(uuid) from service_role;`;

  it("reports all four roles, in the order REQUIRED_REVOKES states", () => {
    expect(revokedRoles(FOUR, "f", "uuid")).toEqual(REQUIRED_REVOKES);
  });

  it("DOES NOT count a commented-out revoke once comments are stripped", () => {
    // THE DEFECT THIS CLOSES. The old assertion was `toContain` over RAW source,
    // so the text inside a comment satisfied it -- the revoke appeared present
    // while anon and authenticated kept the EXECUTE that Supabase's
    // ALTER DEFAULT PRIVILEGES hands out at create time.
    const oneCommented = FOUR.replace(
      `revoke execute on function public.f(uuid) from anon;`,
      `-- revoke execute on function public.f(uuid) from anon;`,
    );
    expect(
      revokedRoles(oneCommented, "f", "uuid"),
      "a commented-out revoke must not count in RAW source either -- it does, " +
        "which is exactly why callers strip comments first",
    ).toEqual(REQUIRED_REVOKES);
    const stripped = oneCommented.replace(/--[^\n]*/g, " ");
    expect(
      revokedRoles(stripped, "f", "uuid"),
      "stripped, the missing revoke must be VISIBLE as missing",
    ).toEqual(["authenticated", "public", "service_role"]);
  });

  it("is spelling-independent, like the grant side", () => {
    expect(
      revokedRoles(`revoke  execute  on function public.f(\n  uuid\n)  from  anon;`, "f", "uuid"),
    ).toEqual(["anon"]);
  });

  it("does not confuse a GRANT for a REVOKE, or an overload for its sibling", () => {
    expect(revokedRoles(`grant execute on function public.f(uuid) to anon;`, "f", "uuid")).toEqual([]);
    expect(revokedRoles(`revoke execute on function public.f(uuid, uuid) from anon;`, "f", "uuid")).toEqual(
      [],
    );
  });
});
