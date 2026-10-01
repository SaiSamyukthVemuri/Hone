import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { publicBookFormSurface } = await import("@/lib/booking/new-client-admission");

// NEW-CLIENT-MODE-01 P2-A: zero active services must not erase admission state.
//
// THE REGRESSION. `PublicBookForm` asked `services.length === 0` at the very
// top — ahead of the new/existing chooser and ahead of every admission branch —
// and returned the generic "isn't accepting bookings yet" copy. So page.tsx
// correctly resolved WAITLIST / CLOSED / UNKNOWN, correctly chose the
// admission-aware component, and the component discarded it. No single
// condition was wrong; the ORDER was, which is why a per-branch test could not
// see it and the cross-product can.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const MODES = ["open", "waitlist", "closed", "unknown"] as const;
const COUNTS = [0, 3] as const;
const TYPES = ["new", "existing", null] as const;

describe("THE REGRESSION: zero services never hides a new client's admission state", () => {
  for (const mode of ["waitlist", "closed", "unknown"] as const) {
    it(`${mode} + zero services + NEW does NOT fall through to the setup copy`, () => {
      const surface = publicBookFormSurface({
        clientType: "new",
        newClientAdmission: mode,
        servicesCount: 0,
        structurallyBookable: false,
      });
      expect(surface).not.toBe("no_services_notice");
      expect(surface).toBe(
        mode === "waitlist"
          ? "waitlist_journey"
          : mode === "closed"
            ? "closed_notice"
            : "unknown_notice",
      );
    });

    it(`${mode} + zero services + NEW is the SAME surface as with services`, () => {
      // Service count is a fact about booking. For these three it must not
      // change the answer at all.
      expect(
        publicBookFormSurface({ clientType: "new", newClientAdmission: mode, servicesCount: 0, structurallyBookable: false }),
      ).toBe(
        publicBookFormSurface({ clientType: "new", newClientAdmission: mode, servicesCount: 3, structurallyBookable: true }),
      );
    });
  }

  it("OPEN + zero services + NEW still gets the generic setup copy", () => {
    expect(
      publicBookFormSurface({ clientType: "new", newClientAdmission: "open", servicesCount: 0, structurallyBookable: false }),
    ).toBe("no_services_notice");
  });

  it("the setup copy stays REACHABLE, so the repair deleted no state", () => {
    const reachable = MODES.flatMap((mode) =>
      COUNTS.map((servicesCount) =>
        publicBookFormSurface({ clientType: "new", newClientAdmission: mode, servicesCount, structurallyBookable: servicesCount > 0 }),
      ),
    );
    expect(reachable).toContain("no_services_notice");
  });
});

describe("the full cross-product: 4 modes x {0,3} services x {new, existing, unchosen}", () => {
  const seen = new Set<string>();

  for (const clientType of TYPES) {
    for (const mode of MODES) {
      for (const servicesCount of COUNTS) {
        for (const structurallyBookable of [true, false]) {
          it(`${clientType ?? "unchosen"} / ${mode} / ${servicesCount} services / ${structurallyBookable ? "ready" : "unready"}`, () => {
            const surface = publicBookFormSurface({ clientType, newClientAdmission: mode, servicesCount, structurallyBookable });
            seen.add(`${clientType}:${mode}:${servicesCount}:${structurallyBookable}`);

            if (clientType == null) {
              // THE CHOOSER SURVIVES EVERY COMBINATION. This is the constraint
              // that forbids "just show the admission surface first": doing so
              // would strand an existing client with no way to say so.
              expect(surface).toBe("chooser");
              return;
            }

            if (clientType === "existing") {
              // ADMISSION NEVER GOVERNS AN EXISTING CLIENT.
              expect(surface).toBe(
                servicesCount === 0
                  ? "existing_no_services"
                  : structurallyBookable
                    ? "existing_portal"
                    : "existing_unavailable",
              );
              return;
            }

            expect(surface).toBe(
              mode === "closed"
                ? "closed_notice"
                : mode === "unknown"
                  ? "unknown_notice"
                  : mode === "waitlist"
                    ? "waitlist_journey"
                    : servicesCount === 0
                      ? "no_services_notice"
                      : "booking_form",
            );
          });
        }
      }
    }
  }

  it("covers every cell — 3 x 4 x 2 x 2 = 48, none omitted", () => {
    expect(seen.size, "a cell was dropped, and the dropped cell is where bugs live").toBe(48);
  });
});

describe("an existing client's authority is untouched by admission", () => {
  it("every admission mode yields the SAME existing-client surface", () => {
    for (const servicesCount of COUNTS) {
      for (const structurallyBookable of [true, false]) {
        const surfaces = MODES.map((mode) =>
          publicBookFormSurface({ clientType: "existing", newClientAdmission: mode, servicesCount, structurallyBookable }),
        );
        expect(new Set(surfaces).size, `admission leaked into the existing path at ${servicesCount}/${structurallyBookable}`).toBe(1);
      }
    }
  });

  it("zero services keeps the SAME notice it had before the reorder", () => {
    expect(
      publicBookFormSurface({ clientType: "existing", newClientAdmission: "open", servicesCount: 0, structurallyBookable: false }),
    ).toBe("existing_no_services");
  });

  it("an existing client can still reach their portal route where valid", () => {
    expect(
      publicBookFormSurface({ clientType: "existing", newClientAdmission: "closed", servicesCount: 3, structurallyBookable: true }),
    ).toBe("existing_portal");
  });
});

describe("the component takes this decision rather than re-deriving it", () => {
  const FORM = read("app/book/[slug]/PublicBookForm.tsx");

  it("derives one surface and branches on it", () => {
    expect(FORM).toContain("publicBookFormSurface({");
    for (const s of [
      "chooser",
      "existing_no_services",
      "existing_unavailable",
      "existing_portal",
      "closed_notice",
      "unknown_notice",
      "waitlist_journey",
      "no_services_notice",
    ]) {
      expect(FORM, `no branch for ${s}`).toContain(`surface === "${s}"`);
    }
  });

  it("no longer returns on services.length BEFORE a client type exists", () => {
    // The exact shape of the regression: a top-level zero-services return
    // sitting above the chooser.
    const chooserAt = FORM.indexOf('surface === "chooser"');
    const head = FORM.slice(0, chooserAt);
    expect(chooserAt).toBeGreaterThan(-1);
    expect(head).not.toMatch(/\n  if \(services\.length === 0\) \{/);
  });

  it("the shared notice is used by BOTH surviving zero-services paths", () => {
    expect(FORM).toContain("const noServicesNotice = (");
    expect(FORM.match(/return noServicesNotice;/g) ?? []).toHaveLength(2);
  });
});
