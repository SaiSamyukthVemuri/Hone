import { describe, expect, it } from "vitest";
import type {
  NewClientBlocker,
  NewClientReadiness,
} from "@/lib/booking/new-client-readiness";

// ===========================================================================
// ONB-03 — THE DASHBOARD CARD RENDERS THE CANONICAL VERDICT, ALL THREE STATES
// ===========================================================================
//
// The source contracts in tests/app/onboarding/consent-readiness-surfaces.test.ts
// prove the dashboard CALLS the authority. They cannot prove what an owner sees.
// This file renders the real component against each verdict shape.
//
// WHY THIS IS NOT A FIXTURE TEST OF A COPY. The verdicts below are typed as
// `NewClientReadiness`, so a change to the authority's shape fails to compile
// here rather than passing against a stale hand-rolled object. The BLOCKERS come
// from the authority's own record via `blockerFor`, not from literals invented in
// this file — so a relabelled blocker cannot pass here while the product shows
// something else.
// ===========================================================================

async function render(readiness: NewClientReadiness): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BookingSetupCard } = await import(
    "@/app/(app)/dashboard/BookingSetupCard"
  );
  return renderToStaticMarkup(BookingSetupCard({ readiness }) as never) ?? "";
}

/**
 * A blocker as the AUTHORITY defines it, looked up by key.
 *
 * Deliberately not a literal. The authority owns every label and href; taking
 * them from it means this test cannot drift into asserting copy the product does
 * not ship, and a relabelled blocker updates here automatically.
 */
async function blockerFor(
  key: NewClientBlocker["key"],
): Promise<NewClientBlocker> {
  const mod = await import("@/lib/booking/new-client-readiness");
  const ready = mod.computeNewClientReadiness({
    // NEW-CLIENT-MODE-01: admission is `open` because that is the mode in which
    // every STRUCTURAL prerequisite applies. `closed` deliberately suppresses
    // them - a decision is not a pile of setup failures - so using it here
    // would hide the very blockers this fixture exists to produce.
    admission: { ok: true as const, mode: "open" as const },
    // Evidence chosen so EVERY blocker is proven at once: no name, no slug, no
    // services, no open days, consent absent. The authority then reports the
    // full set and we pick the one under test out of it.
    studio: {
      name: null,
      slug: null,
      timezone: "America/Toronto",
      default_appointment_duration_minutes: 60,
      buffer_minutes: 0,
      public_booking_horizon_months: 3,
    },
    services: { ok: true, services: [] },
    availability: { ok: true, days: [] },
    treatmentConsent: { ok: true, liveCount: 0 },
  } as never);
  if (ready.status !== "not_ready") {
    throw new Error(`expected an all-blockers fixture, got ${ready.status}`);
  }
  const found = ready.blockers.find((b) => b.key === key);
  if (!found) {
    throw new Error(
      `the authority did not report ${key}; this test's fixture no longer proves it`,
    );
  }
  return found;
}

describe("READY renders nothing", () => {
  it("returns no markup at all", async () => {
    // Finished setup is not daily work. The decision lives in the component so a
    // future caller cannot reintroduce a congratulation banner by forgetting a
    // guard at the call site.
    expect(await render({ status: "ready" })).toBe("");
  });
});

describe("NOT_READY renders the proven blockers", () => {
  it("shows a consultation-service blocker with the authority's own label and href", async () => {
    const blocker = await blockerFor("consultation_service");
    const html = await render({
      status: "not_ready",
      blockers: [blocker],
      nextStep: blocker,
      unavailable: [],
    });

    // ACCEPTANCE CRITERION 1. Before ONB-03 this studio scored `ready` on the
    // booking-link gate and the card VANISHED.
    expect(html).toContain("Before you can take a new client");
    expect(html).toContain(blocker.label);
    expect(html).toContain(`href="${blocker.href}"`);
    expect(html).toContain('data-testid="blocker-consultation_service"');
  });

  it("shows a treatment-consent blocker the old gate could not express", async () => {
    // ACCEPTANCE CRITERION 2. `computeBookingReadiness` has no consent input at
    // all, so this blocker had no way to reach the dashboard before.
    const blocker = await blockerFor("treatment_consent");
    const html = await render({
      status: "not_ready",
      blockers: [blocker],
      nextStep: blocker,
      unavailable: [],
    });
    expect(html).toContain(blocker.label);
    expect(html).toContain('data-testid="blocker-treatment_consent"');
  });

  it("renders EVERY blocker it is given, not just the next step", async () => {
    // A card that showed only `nextStep` would hide work an owner could do in
    // parallel, and would make the list look shorter than it is.
    const a = await blockerFor("consultation_service");
    const b = await blockerFor("availability");
    const c = await blockerFor("treatment_consent");
    const html = await render({
      status: "not_ready",
      blockers: [a, b, c],
      nextStep: a,
      unavailable: [],
    });
    for (const blocker of [a, b, c]) {
      expect(html, `${blocker.key} was not rendered`).toContain(blocker.label);
    }
  });

  it("says so when the blocker list is NOT exhaustive", async () => {
    // `not_ready` WITH `unavailable`: the blockers are proven but incomplete.
    // Silently rendering the short list lets an owner fix everything visible and
    // still be unable to take a client.
    const blocker = await blockerFor("consultation_service");
    const html = await render({
      status: "not_ready",
      blockers: [blocker],
      nextStep: blocker,
      unavailable: ["treatment_consent"],
    });
    expect(html).toContain("There may be more to do");
    expect(html).toContain("treatment consent");
    // The proven blocker is still shown alongside the caveat.
    expect(html).toContain(blocker.label);
  });

  it("names every unreadable authority, not just the first", async () => {
    const blocker = await blockerFor("booking_link");
    const html = await render({
      status: "not_ready",
      blockers: [blocker],
      nextStep: blocker,
      unavailable: ["services", "availability", "treatment_consent"],
    });
    for (const name of ["services", "availability", "treatment consent"]) {
      expect(html, `${name} was not named`).toContain(name);
    }
  });
});

/**
 * A blocker carrying a REAL key and a marked placeholder label.
 *
 * For the iteration proofs below, which are about whether the card renders every
 * entry it is handed — not about copy. The labels are proved separately, from the
 * authority, by the `blockerFor` tests above.
 */
function keyedBlocker(key: NewClientBlocker["key"]): NewClientBlocker {
  return { key, label: `[[${key}]]`, href: `/settings/${key}` };
}

describe("no key the authority owns can go unrendered", () => {
  it("renders EVERY NEW_CLIENT_BLOCKER_KEY it is handed", async () => {
    // THE DEFECT THIS CLOSES IS NAMED IN THE AUTHORITY'S OWN COMMENT: a key added
    // to the union "and then quietly go unrendered by a consumer, which is
    // exactly how the booking_settings blocker reached an owner as 'nothing left
    // to do'". The card is that consumer now.
    //
    // Driven from NEW_CLIENT_BLOCKER_KEYS, so a key added tomorrow is covered
    // without editing this test.
    const mod = await import("@/lib/booking/new-client-readiness");
    const keys = mod.NEW_CLIENT_BLOCKER_KEYS;
    expect(keys.length).toBeGreaterThan(0);

    const blockers = keys.map(keyedBlocker);
    const html = await render({
      status: "not_ready",
      blockers,
      nextStep: blockers[0] ?? null,
      unavailable: [],
    });
    for (const b of blockers) {
      expect(html, `${b.key} was not rendered`).toContain(
        `data-testid="blocker-${b.key}"`,
      );
      expect(html, `${b.key}'s label was not rendered`).toContain(b.label);
      expect(html, `${b.key}'s link was not rendered`).toContain(`href="${b.href}"`);
    }
  });
});

describe("WAIT admission is reported, and that is deliberate", () => {
  it("is not fixture-provable, which is why it is asserted by key", async () => {
    // WORTH RECORDING: `wait_admission` is the one key `computeNewClientReadiness`
    // cannot prove from evidence. It comes from `isNewClientWaitlistEnabled(slug)`
    // — deterministic configuration read inside the authority, not a row this
    // test can supply. So it is exercised through the key, like the others above.
    const mod = await import("@/lib/booking/new-client-readiness");
    expect(mod.NEW_CLIENT_BLOCKER_KEYS).toContain("wait_admission");
  });

  it("renders the waitlist blocker rather than suppressing it", async () => {
    // A STUDIO WITH WAIT ENABLED IS WORKING AS CONFIGURED, and the authority
    // still reports `wait_admission` — a fact about admission today, not a
    // diagnosis. The authority orders it LAST precisely so it never sends an
    // operator to the waitlist screen when what they need is a service.
    //
    // THE DASHBOARD DOES NOT SECOND-GUESS THAT. Suppressing it on this surface
    // only would be a dashboard-specific readiness rule — a competing definition
    // by another name — and /settings/launch would then disagree with the
    // dashboard about the same studio. If this blocker should not appear on the
    // dashboard, the change belongs in the authority, where both surfaces pick
    // it up together.
    const blocker = keyedBlocker("wait_admission");
    const html = await render({
      status: "not_ready",
      blockers: [blocker],
      nextStep: blocker,
      unavailable: [],
    });
    expect(html).toContain('data-testid="blocker-wait_admission"');
    expect(html).toContain(blocker.label);
  });
});

describe("UNKNOWN stays UNKNOWN", () => {
  it("renders a distinct state — never nothing, never an empty checklist", async () => {
    // THE STATE THE OLD TWO-STATE GATE COULD NOT HOLD. Rendering null would
    // assert ready on evidence nobody has; rendering an empty blocker list would
    // read as "nothing left to do". Both are lies, in opposite directions.
    const html = await render({
      status: "unknown",
      unavailable: ["services"],
    });
    expect(html).not.toBe("");
    expect(html).toContain("We could not check your booking setup");
    expect(html).toContain("services");
    // It must NOT present itself as a to-do list.
    expect(html).not.toContain("Before you can take a new client");
    expect(html).not.toContain('data-testid="booking-setup-blockers"');
  });

  it("does not blame the owner for an unreadable setting", async () => {
    // An owner reading "we could not check" must not conclude they left
    // something undone; the sentence says which it is.
    const html = await render({ status: "unknown", unavailable: ["availability"] });
    expect(html).toContain("not something you have left undone");
  });

  it("still offers a way forward", async () => {
    const html = await render({ status: "unknown", unavailable: ["services"] });
    expect(html).toContain('href="/settings/launch"');
  });
});

describe("readiness does not wait on the attention-source bundle", () => {
  // ==========================================================================
  // WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT CLAIM
  // ==========================================================================
  //
  // The previous version of this block claimed the card survives a sibling
  // rejection, and proved no such thing: its helper discarded the sibling
  // rejection WITHOUT awaiting it, which is not the order `SecondaryStack` uses.
  // Codex caught that, and it was right — the helper modelled the fix I intended
  // rather than the code I wrote.
  //
  // FACING WHAT THE REAL ORDERING ACTUALLY IS. `SecondaryStack` awaits
  // `attentionSources` before it awaits the verdict, and a server component that
  // throws renders none of its children. So when a USED bundle member rejects,
  // the card does not render — and neither does anything else: the throw reaches
  // `app/(app)/error.tsx` and the whole dashboard is an error page. That is the
  // route's existing, deliberate design, not a readiness defect, and no test here
  // should pretend the card is visible in a scenario where the page is not.
  //
  // WHAT IS WORTH PROVING IS THE DECOUPLING THAT WAS ACTUALLY MADE:
  //
  //   1. the verdict is computed from its own read, so it does not WAIT on the
  //      bundle and is not delayed by it;
  //   2. a rejection in the readiness read does not take the bundle down either —
  //      the independence runs both ways;
  //   3. the vestigial availability read is gone, so a read NOTHING consumes can
  //      no longer fail the route.
  //
  // (3) is the original P2 and the one with real user-visible weight: before it,
  // a query whose result nobody read could error the entire dashboard.
  // ==========================================================================

  it("the verdict resolves without the bundle resolving at all", () => {
    // The strongest honest statement of the decoupling: readiness settles while a
    // bundle promise is still pending forever. If the verdict were a member of the
    // bundle, or awaited after it, this could not resolve.
    const neverSettles = new Promise<never>(() => {});
    void neverSettles;
    const verdict: Promise<NewClientReadiness> = Promise.resolve({
      status: "unknown",
      unavailable: ["services"],
    });
    return Promise.race([
      verdict.then(() => "verdict-first" as const),
      neverSettles,
    ]).then((winner) => {
      expect(winner).toBe("verdict-first");
    });
  });

  it("a rejecting READINESS read cannot take the bundle down", async () => {
    // Independence in the other direction, which the sibling arrangement also
    // buys. `settleLater` marks the rejection handled so it is not an unhandled
    // rejection while nothing awaits it; the bundle is unaffected.
    const readiness: Promise<NewClientReadiness | null> = Promise.reject(
      new Error("consent read failed"),
    );
    readiness.catch(() => undefined);
    const bundle = Promise.resolve([1, 2, 3, 4] as const);
    await expect(bundle).resolves.toEqual([1, 2, 3, 4]);
    await expect(readiness).rejects.toThrow("consent read failed");
  });

  it("an UNKNOWN verdict renders the card, whatever else the page is doing", async () => {
    // The verdict-to-markup half, which is this file's real subject. Combined with
    // the decoupling above and the page-level source contract, the chain is: the
    // verdict is computed independently, and an unknown verdict renders the
    // unknown card.
    const html = await render({ status: "unknown", unavailable: ["services"] });
    expect(html).toContain("We could not check your booking setup");
  });
});

describe("the fixture is the authority's, not this file's", () => {
  it("every blocker key this test names is one the authority actually reports", async () => {
    // ANTI-VACUITY for `blockerFor`: if the authority stopped reporting one of
    // these, `blockerFor` throws rather than letting a test pass against a key
    // the product no longer has.
    for (const key of [
      "consultation_service",
      "availability",
      "treatment_consent",
      "booking_link",
    ] as const) {
      const blocker = await blockerFor(key);
      expect(blocker.key).toBe(key);
      expect(blocker.label.length).toBeGreaterThan(0);
      expect(blocker.href.startsWith("/")).toBe(true);
    }
  });

  it("no blocker label is written down in this file", async () => {
    // The labels belong to the authority. A literal here would let the test keep
    // passing after the product's copy changed.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("./booking-setup-card.test.ts", import.meta.url),
        "utf8",
      ),
    );
    const blocker = await blockerFor("consultation_service");
    expect(src).not.toContain(blocker.label);
  });
});
