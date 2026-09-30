import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The resolver module imports the server Supabase client at module scope; this
// test exercises only its PURE surface function, so the client is stubbed out.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { publicNewClientSurface, publicBookFormSurface, resolveAdmission } =
  await import("@/lib/booking/new-client-admission");
const { NEW_CLIENT_WAITLIST_SLUGS_ENV } = await import(
  "@/lib/booking/new-client-waitlist"
);

// NEW-CLIENT-MODE-01 P2: admission outranks structural readiness.
//
// THE DEFECT THIS PINS. `app/book/[slug]/page.tsx` gated the whole booking
// region on `bookable` (an active service AND an open availability day). A
// studio that was CLOSED — or whose mode could not be read — AND structurally
// unready therefore rendered the generic "still being set up" copy, and its
// real admission state disappeared. Two intentional, truthful states were
// indistinguishable from an unfinished setup.
//
// THE CROSS-PRODUCT IS THE TEST. One happy path cannot see an ordering bug:
// the defect only appears in the cells where the two axes disagree, and those
// are exactly the cells a single-path test omits.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("the 4x2 cross-product of admission mode and structural readiness", () => {
  const CASES = [
    // mode,       bookable, surface,            why
    ["open", true, "booking_form", "the ordinary path"],
    ["open", false, "setup_notice", "readiness decides OPEN, and only OPEN"],
    ["waitlist", true, "waitlist_journey", "the waitlist is the surface"],
    ["waitlist", false, "waitlist_journey", "a waitlist exists FOR a studio with no slots"],
    ["closed", true, "closed_notice", "an intentional state"],
    ["closed", false, "closed_notice", "still true when the calendar is unset"],
    ["unknown", true, "unknown_notice", "a real state, not an absence"],
    ["unknown", false, "unknown_notice", "never collapses into a setup notice"],
  ] as const;

  for (const [mode, structurallyBookable, expected, why] of CASES) {
    it(`${mode} x ${structurallyBookable ? "bookable" : "structurally-unbookable"} -> ${expected} (${why})`, () => {
      expect(publicNewClientSurface({ mode, structurallyBookable })).toBe(expected);
    });
  }

  it("covers every cell: 4 modes x 2 readiness values, none omitted", () => {
    // Anti-vacuity. A table that silently lost a row would still pass every
    // assertion above, and the omitted row is exactly where the bug lived.
    const seen = new Set(CASES.map(([m, b]) => `${m}:${b}`));
    for (const m of ["open", "waitlist", "closed", "unknown"]) {
      for (const b of [true, false]) {
        expect(seen.has(`${m}:${b}`), `missing cell ${m} x ${b}`).toBe(true);
      }
    }
    expect(CASES).toHaveLength(8);
  });
});

describe("the two states the P2 was about never reach the generic copy", () => {
  it("CLOSED never yields setup_notice, at either readiness value", () => {
    for (const structurallyBookable of [true, false]) {
      expect(
        publicNewClientSurface({ mode: "closed", structurallyBookable }),
      ).not.toBe("setup_notice");
    }
  });

  it("UNKNOWN never yields setup_notice, at either readiness value", () => {
    for (const structurallyBookable of [true, false]) {
      expect(
        publicNewClientSurface({ mode: "unknown", structurallyBookable }),
      ).not.toBe("setup_notice");
    }
  });

  it("CLOSED and UNKNOWN stay DISTINCT from each other", () => {
    // Collapsing both into one "unavailable" surface would fix the fall-through
    // and lose the difference between "not taking new clients" and "we cannot
    // tell" — which are different answers to a visitor deciding what to do next.
    expect(publicNewClientSurface({ mode: "closed", structurallyBookable: false })).not.toBe(
      publicNewClientSurface({ mode: "unknown", structurallyBookable: false }),
    );
  });

  it("setup_notice remains REACHABLE, so the repair did not delete the state", () => {
    expect(
      publicNewClientSurface({ mode: "open", structurallyBookable: false }),
    ).toBe("setup_notice");
  });
});

describe("WAITLIST when ordinary booking readiness is false", () => {
  it("is NOT hidden — the established behaviour, stated explicitly", () => {
    // The intended rule, recorded here because it is a product decision and not
    // an inference: a studio running a waitlist is frequently one with no
    // bookable calendar, so gating the waitlist on bookability would hide it in
    // precisely the situation it exists for.
    expect(
      publicNewClientSurface({ mode: "waitlist", structurallyBookable: false }),
    ).toBe("waitlist_journey");
  });

  it("is the SAME surface whether or not the studio is bookable", () => {
    expect(publicNewClientSurface({ mode: "waitlist", structurallyBookable: true })).toBe(
      publicNewClientSurface({ mode: "waitlist", structurallyBookable: false }),
    );
  });
});

describe("the page actually uses this function, and readiness no longer gates the region", () => {
  const PAGE = read("app/book/[slug]/page.tsx");

  it("derives its surface from the shared function rather than an inline condition", () => {
    expect(PAGE).toContain("publicNewClientSurface");
    expect(PAGE).toMatch(/const showAdmissionAwareForm = surface !== "setup_notice"/);
  });

  it("no longer gates the region on `bookable` alone", () => {
    // The exact shape of the defect: `{bookable ? (<PublicBookForm` .
    expect(PAGE).not.toMatch(/\{bookable \? \(\s*<PublicBookForm/);
  });

  it("passes readiness DOWN so the existing-client branch keeps its answer", () => {
    expect(PAGE).toMatch(/structurallyBookable=\{bookable\}/);
  });
});

describe("existing-client authority is unchanged by this repair", () => {
  const FORM = read("app/book/[slug]/PublicBookForm.tsx");

  it("the prop defaults TRUE, so every pre-existing call site renders as before", () => {
    expect(FORM).toMatch(/structurallyBookable = true/);
  });

  it("an existing client at an unready studio still gets the readiness copy", () => {
    // P2-A moved this decision out of an inline condition and into
    // `publicBookFormSurface`, so the property is now asserted on BEHAVIOUR
    // rather than on the literal text of a branch — which is strictly stronger
    // than the source grep this assertion used to be. The branch must still
    // exist to render it, and the copy must still be imported.
    expect(
      publicBookFormSurface({
        clientType: "existing",
        newClientAdmission: "open",
        servicesCount: 3,
        structurallyBookable: false,
      }),
    ).toBe("existing_unavailable");
    expect(FORM).toContain('surface === "existing_unavailable"');
    expect(FORM).toContain("UNAVAILABLE_PUBLIC_BOOKING_MESSAGE");
  });

  it("the admission branches stay NEW-CLIENT only", () => {
    // If any of the three lost its isNewClient conjunct it would start showing
    // to existing clients, which is exactly the expansion this repair must not
    // make.
    for (const flag of [
      "waitlistNewClient",
      "closedToNewClient",
      "unknownForNewClient",
    ]) {
      expect(FORM).toMatch(new RegExp(`const ${flag} =\\s*isNewClient &&`));
    }
  });
});

// ===========================================================================
// INTEGRATION GUARD — only reachable once BOTH repairs are on one head.
//
// The P1 repair gave `NewClientAdmission` a `source` (`persisted` vs
// `legacy_bridge`) so the migration could be proved. The P2 repair decides what
// the public page shows. Provenance is a COMMIT-PATH concern and must never
// become a presentation one: a visitor looking at a waitlisted studio must not
// be able to tell whether its mode was persisted by its owner or inherited from
// a env list that is about to be deleted. Neither lane could assert this
// alone - one introduced the field, the other the surface.
// ===========================================================================
describe("presentation never reveals migration state", () => {
  const SLUG = "a-studio";
  const ORIGINAL = process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];

  it("a bridged and a cut-over WAITLIST render the SAME surface", () => {
    process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = SLUG;
    try {
      const bridged = resolveAdmission({
        storedMode: null,
        readFailed: false,
        studioSlug: SLUG,
      });
      const cutOver = resolveAdmission({
        storedMode: "waitlist",
        readFailed: false,
        studioSlug: SLUG,
      });

      // Same mode, DIFFERENT provenance - the pair the P1 matrix relies on.
      expect(bridged.ok && bridged.source).toBe("legacy_bridge");
      expect(cutOver.ok && cutOver.source).toBe("persisted");

      for (const structurallyBookable of [true, false]) {
        const a = publicNewClientSurface({
          mode: bridged.ok ? bridged.mode : "unknown",
          structurallyBookable,
        });
        const b = publicNewClientSurface({
          mode: cutOver.ok ? cutOver.mode : "unknown",
          structurallyBookable,
        });
        expect(a).toBe("waitlist_journey");
        expect(
          b,
          "provenance must not change what a visitor is shown",
        ).toBe(a);
      }
    } finally {
      if (ORIGINAL === undefined) delete process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV];
      else process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV] = ORIGINAL;
    }
  });

  it("the FORM surface function cannot read provenance either", () => {
    // P2-A added a second presentation function for the component's own
    // ordering. The same rule binds it: a visitor must not be able to tell a
    // bridged waitlist from a persisted one, and the zero-service repair gave
    // that function a new reason to be consulted.
    const source = read("lib/booking/new-client-admission.ts");
    const fn = source.slice(source.indexOf("export function publicBookFormSurface"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toContain("source");
    expect(body).not.toContain("IsCutOver");
    expect(body).not.toContain("legacy_bridge");
    expect(body).not.toContain("persisted");
  });

  it("the surface function cannot read provenance at all", () => {
    // Structural, so it holds for every future mode too: the function takes the
    // flattened mode and readiness, and the page passes nothing else.
    const source = read("lib/booking/new-client-admission.ts");
    const fn = source.slice(
      source.indexOf("export function publicNewClientSurface"),
    );
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toContain("source");
    expect(body).not.toContain("IsCutOver");

    const page = read("app/book/[slug]/page.tsx");
    const call = page.slice(
      page.indexOf("publicNewClientSurface({"),
      page.indexOf("});", page.indexOf("publicNewClientSurface({")),
    );
    expect(call).toContain("mode:");
    expect(call).toContain("structurallyBookable:");
    expect(call).not.toContain("source");
  });
});
