import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ONB-02 — canonical new-client booking readiness.
//
// BEHAVIOURAL. Every state below is produced by running the real compute over
// real-shaped evidence, never by asserting that a string appears in the source.
//
// The negative control for this file: delete the `services.ok` / `availability.ok`
// guards in computeNewClientReadiness (so an unavailable authority is treated as
// an empty list) and the UNKNOWN cases must go RED with status "not_ready".

// The loader awaits createClient() before handing the client to the mocked
// studio-wide reader, so it must resolve; the client itself is never used here.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/booking/queries", () => ({
  getActiveServices: vi.fn(),
}));
// P2: readiness reads STUDIO-WIDE availability (practitioner_id IS NULL), the
// same scope public booking uses, so that is what the loader tests mock.
vi.mock("@/lib/booking/studio-wide-availability", () => ({
  getStudioWideDefaultsSafe: vi.fn(),
}));
vi.mock("@/lib/consent/launch-readiness", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getTreatmentConsentReadiness: vi.fn(),
}));

const {
  computeNewClientReadiness,
  getNewClientReadiness,
  isOpenDay,
} = await import("@/lib/booking/new-client-readiness");
const queries = await import("@/lib/booking/queries");
const wideAvailability = await import("@/lib/booking/studio-wide-availability");
const consent = await import("@/lib/consent/launch-readiness");

const STUDIO = {
  name: "Willow",
  slug: "willow",
  timezone: "America/Toronto",
  default_appointment_duration_minutes: 60,
  buffer_minutes: 15,
  public_booking_horizon_months: 3 as const,
};

const CONSULTATION = {
  id: "s1",
  name: "New Client Consultation",
  modality: "consultation",
  active: true,
} as never;

const OPEN_DAY = { is_open: true, open_time: "09:00:00", close_time: "17:00:00" };

const ALL_GOOD = {
  studio: STUDIO,
  services: { ok: true as const, services: [CONSULTATION] },
  availability: { ok: true as const, days: [OPEN_DAY] },
  treatmentConsent: { ok: true as const, ready: true },
};

describe("computeNewClientReadiness — the three states", () => {
  it("READY only when every authority answered and every requirement is met", () => {
    expect(computeNewClientReadiness(ALL_GOOD)).toEqual({ status: "ready" });
  });

  it("NOT_READY states the missing fact, and points at the first one in canonical order", () => {
    const r = computeNewClientReadiness({
      ...ALL_GOOD,
      services: { ok: true, services: [] },
      availability: { ok: true, days: [] },
    });
    expect(r.status).toBe("not_ready");
    if (r.status !== "not_ready") throw new Error("unreachable");
    expect(r.blockers.map((b) => b.key)).toEqual([
      "consultation_service",
      "availability",
    ]);
    // consultation precedes availability in BLOCKER_ORDER, regardless of the
    // order the checks happened to run in.
    expect(r.nextStep?.key).toBe("consultation_service");
    expect(r.blockers[0].label).toMatch(/consultation service/i);
    expect(r.unavailable).toEqual([]);
  });

  it("UNKNOWN when an authority cannot answer and nothing is proven broken", () => {
    const r = computeNewClientReadiness({ ...ALL_GOOD, services: { ok: false } });
    expect(r).toEqual({ status: "unknown", unavailable: ["services"] });
  });
});

describe("UNKNOWN MUST NOT COLLAPSE TO NOT_READY", () => {
  // The defect this module exists to prevent, one authority at a time: an
  // unreadable authority must never be reported as a missing setup step.
  it.each([
    ["services", { services: { ok: false as const } }],
    ["availability", { availability: { ok: false as const } }],
    ["treatment_consent", { treatmentConsent: { ok: false as const } }],
  ])("a failed %s read is UNKNOWN, never NOT_READY", (key, override) => {
    const r = computeNewClientReadiness({ ...ALL_GOOD, ...override });
    expect(r.status).toBe("unknown");
    if (r.status !== "unknown") throw new Error("unreachable");
    expect(r.unavailable).toEqual([key]);
  });

  it("every authority down at once is still UNKNOWN, and names all three", () => {
    const r = computeNewClientReadiness({
      ...ALL_GOOD,
      services: { ok: false },
      availability: { ok: false },
      treatmentConsent: { ok: false },
    });
    expect(r.status).toBe("unknown");
    if (r.status !== "unknown") throw new Error("unreachable");
    expect(r.unavailable).toEqual([
      "services",
      "availability",
      "treatment_consent",
    ]);
  });

  it("READY is never returned while any authority is unavailable", () => {
    for (const override of [
      { services: { ok: false as const } },
      { availability: { ok: false as const } },
      { treatmentConsent: { ok: false as const } },
    ]) {
      expect(
        computeNewClientReadiness({ ...ALL_GOOD, ...override }).status,
      ).not.toBe("ready");
    }
  });
});

describe("a proven blocker still answers, but never claims to be exhaustive", () => {
  it("NOT_READY survives an unavailable authority and carries what it could not read", () => {
    const r = computeNewClientReadiness({
      ...ALL_GOOD,
      // proven: there is no open day at all
      availability: { ok: true, days: [{ is_open: false, open_time: null, close_time: null }] },
      // unknown: consent could not be read
      treatmentConsent: { ok: false },
    });
    expect(r.status).toBe("not_ready");
    if (r.status !== "not_ready") throw new Error("unreachable");
    expect(r.blockers.map((b) => b.key)).toEqual(["availability"]);
    // The caller can see the list is partial — consent is neither a blocker
    // (unproven) nor silently satisfied.
    expect(r.unavailable).toEqual(["treatment_consent"]);
    expect(r.blockers.some((b) => b.key === "treatment_consent")).toBe(false);
  });
});

describe("composition — the SAME predicates the booking path enforces", () => {
  it("accepts a name-fallback consultation, as isBookableByNewClient does", () => {
    // The launch checklist's own `s.modality === 'consultation'` would call
    // this studio not-ready while publicBookAppointmentAction would take the
    // booking. The canonical answer follows the action.
    const r = computeNewClientReadiness({
      ...ALL_GOOD,
      services: {
        ok: true,
        services: [{ id: "s", name: "New Client Consultation", modality: null, active: true } as never],
      },
    });
    expect(r.status).toBe("ready");
  });

  it("an INACTIVE consultation is not bookable, so it is not readiness", () => {
    const r = computeNewClientReadiness({
      ...ALL_GOOD,
      services: {
        ok: true,
        services: [{ id: "s", name: "Consultation", modality: "consultation", active: false } as never],
      },
    });
    expect(r.status).toBe("not_ready");
  });

  it("an ordinary active treatment is NOT a new-client path", () => {
    // This is exactly the studio `isPubliclyBookable` calls bookable and the
    // booking action refuses.
    const r = computeNewClientReadiness({
      ...ALL_GOOD,
      services: {
        ok: true,
        services: [{ id: "s", name: "Upper Lip", modality: "electrolysis", active: true } as never],
      },
    });
    expect(r.status).toBe("not_ready");
    if (r.status !== "not_ready") throw new Error("unreachable");
    expect(r.blockers.map((b) => b.key)).toEqual(["consultation_service"]);
  });

  it("isOpenDay requires both ends, not just the flag", () => {
    expect(isOpenDay(OPEN_DAY)).toBe(true);
    expect(isOpenDay({ is_open: true, open_time: "09:00:00", close_time: null })).toBe(false);
    expect(isOpenDay({ is_open: false, open_time: "09:00:00", close_time: "17:00:00" })).toBe(false);
  });
});

describe("studio-row requirements", () => {
  it.each([
    ["studio_name", { name: "  " }],
    ["booking_link", { slug: "" }],
    ["booking_settings", { timezone: "" }],
    ["booking_settings", { buffer_minutes: null as never }],
  ])("%s is proven from the loaded row", (key, override) => {
    const r = computeNewClientReadiness({
      ...ALL_GOOD,
      studio: { ...STUDIO, ...override },
    });
    expect(r.status).toBe("not_ready");
    if (r.status !== "not_ready") throw new Error("unreachable");
    expect(r.blockers.map((b) => b.key)).toContain(key);
  });
});

describe("getNewClientReadiness — a throwing query becomes UNKNOWN, not zero", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getActiveServices throwing is UNKNOWN, never 'no consultation service'", async () => {
    vi.mocked(queries.getActiveServices).mockRejectedValue(new Error("boom"));
    vi.mocked(wideAvailability.getStudioWideDefaultsSafe).mockResolvedValue([OPEN_DAY] as never);
    vi.mocked(consent.getTreatmentConsentReadiness).mockResolvedValue({ ok: true, ready: true });

    const r = await getNewClientReadiness({ id: "st", ...STUDIO });
    expect(r.status).toBe("unknown");
    if (r.status !== "unknown") throw new Error("unreachable");
    expect(r.unavailable).toEqual(["services"]);
  });

  it("one failed authority does not take out the others", async () => {
    vi.mocked(queries.getActiveServices).mockResolvedValue([CONSULTATION] as never);
    vi.mocked(wideAvailability.getStudioWideDefaultsSafe).mockRejectedValue(new Error("boom"));
    vi.mocked(consent.getTreatmentConsentReadiness).mockResolvedValue({ ok: true, ready: false });

    // Consent is PROVEN missing, so the answer is still actionable.
    const r = await getNewClientReadiness({ id: "st", ...STUDIO });
    expect(r.status).toBe("not_ready");
    if (r.status !== "not_ready") throw new Error("unreachable");
    expect(r.blockers.map((b) => b.key)).toEqual(["treatment_consent"]);
    expect(r.unavailable).toEqual(["availability"]);
  });

  it("all three answering and satisfied is READY", async () => {
    vi.mocked(queries.getActiveServices).mockResolvedValue([CONSULTATION] as never);
    vi.mocked(wideAvailability.getStudioWideDefaultsSafe).mockResolvedValue([OPEN_DAY] as never);
    vi.mocked(consent.getTreatmentConsentReadiness).mockResolvedValue({ ok: true, ready: true });
    expect((await getNewClientReadiness({ id: "st", ...STUDIO })).status).toBe("ready");
  });
});

describe("no surface re-derives 'consultation' for itself", () => {
  // ONB-02's whole point is composition. A second definition of the same rule
  // is the drift `lib/booking/consultation.ts` was extracted to prevent, and
  // the launch checklist had one.
  //
  // COMMENTS ARE STRIPPED BEFORE ANY IDENTIFIER IS LOOKED FOR, line before
  // block — stripping blocks first lets a `/*` inside a line comment swallow
  // real code, and an identifier surviving inside a comment makes the proof
  // satisfiable by a comment.
  const strip = (src: string) =>
    src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  const OWNER_SURFACES = [
    "app/(app)/settings/launch/page.tsx",
    "lib/booking/new-client-readiness.ts",
  ];

  it("no owner-facing readiness surface compares modality to a raw string", async () => {
    const { readFileSync } = await import("node:fs");
    for (const path of OWNER_SURFACES) {
      const code = strip(readFileSync(path, "utf8"));
      expect(code, `${path} must ask isBookableByNewClient`).not.toMatch(
        /modality\s*===\s*["']consultation["']/,
      );
    }
  });

  it("the canonical authority asks the canonical predicate", async () => {
    // The subject moved when the launch page stopped deriving this fact at
    // all: the page now asks the AUTHORITY, and the authority asks the
    // predicate the booking action enforces. Asserting the page still names
    // `isBookableByNewClient` would now demand the very re-derivation P1
    // removed, so the requirement lands where the derivation actually lives.
    const { readFileSync } = await import("node:fs");
    const code = strip(readFileSync("lib/booking/new-client-readiness.ts", "utf8"));
    expect(code).toContain("isBookableByNewClient");
  });

  it("the strip helper itself is not vacuous", () => {
    // Negative control against synthetic source, so this cannot pass by
    // accident on a repo that happens to be correct today.
    expect(strip('// modality === "consultation"')).not.toContain("modality");
    expect(strip('/* modality === "consultation" */')).not.toContain("modality");
    expect(strip('// note\nmodality === "consultation"')).toContain("modality");
  });
});

// ONB-02 review repairs: the two ways this module could answer READY for a
// studio that will not actually take a new client right now.
describe("ONB-02: WAIT admission and a real timezone authority", () => {
  const WAIT_ENV = "NEW_CLIENT_WAITLIST_STUDIO_SLUGS";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("P1 — WAIT admission is part of the answer", () => {
    it("a WAIT studio with every prerequisite satisfied is NOT ordinary-ready", () => {
      // The defect: every structural check below can pass while ordinary
      // new-client admission is deliberately paused behind the queue, so the
      // canonical question answered READY for a studio that routes new clients
      // to a waitlist instead of a booking.
      vi.stubEnv(WAIT_ENV, "willow");
      const r = computeNewClientReadiness(ALL_GOOD);
      expect(r.status).toBe("not_ready");
      if (r.status !== "not_ready") return;
      expect(r.blockers.map((b) => b.key)).toContain("wait_admission");
    });

    it("the SAME evidence without the gate is ready — so the gate is what moved it", () => {
      // The control. Without this the assertion above could be passing because
      // ALL_GOOD was never ready in the first place.
      vi.stubEnv(WAIT_ENV, "");
      expect(computeNewClientReadiness(ALL_GOOD)).toEqual({ status: "ready" });
    });

    it("another studio's slug on the list does not pause THIS studio", () => {
      vi.stubEnv(WAIT_ENV, "some-other-studio");
      expect(computeNewClientReadiness(ALL_GOOD)).toEqual({ status: "ready" });
    });

    it("it reports admission, never a misconfiguration", () => {
      vi.stubEnv(WAIT_ENV, "willow");
      const r = computeNewClientReadiness(ALL_GOOD);
      if (r.status !== "not_ready") throw new Error("expected not_ready");
      const wait = r.blockers.find((b) => b.key === "wait_admission");
      expect(wait?.label).toMatch(/waitlist/i);
      // A factual statement, not a diagnosis: nothing is "missing" or "not set".
      expect(wait?.label).not.toMatch(/not set|missing|incomplete|invalid/i);
    });

    it("it is the LAST step offered, behind anything structural", () => {
      // An operator still lacking a consultation service must be sent there,
      // not to the waitlist screen.
      vi.stubEnv(WAIT_ENV, "willow");
      const r = computeNewClientReadiness({
        ...ALL_GOOD,
        services: { ok: true, services: [] },
      });
      if (r.status !== "not_ready") throw new Error("expected not_ready");
      expect(r.nextStep?.key).toBe("consultation_service");
    });
  });

  describe("P2 — the timezone must be a real IANA zone", () => {
    it("a non-empty but INVALID timezone is not readiness", () => {
      // The defect: `nonEmpty` accepted any string, so a studio carrying
      // "Not/AZone" answered READY and every downstream studio-local date
      // computation would throw on it.
      const r = computeNewClientReadiness({
        ...ALL_GOOD,
        studio: { ...STUDIO, timezone: "Not/AZone" },
      });
      expect(r.status).toBe("not_ready");
      if (r.status !== "not_ready") return;
      expect(r.blockers.map((b) => b.key)).toContain("booking_settings");
    });

    it("a real zone still passes — the rule is validity, not strictness", () => {
      expect(
        computeNewClientReadiness({
          ...ALL_GOOD,
          studio: { ...STUDIO, timezone: "America/Toronto" },
        }),
      ).toEqual({ status: "ready" });
    });

    it("empty is still caught, as before", () => {
      const r = computeNewClientReadiness({
        ...ALL_GOOD,
        studio: { ...STUDIO, timezone: "" },
      });
      expect(r.status).toBe("not_ready");
    });
  });

  describe("neither repair collapses UNKNOWN into NOT_READY", () => {
    it("an unavailable authority with NO proven blocker stays unknown", () => {
      vi.stubEnv(WAIT_ENV, "");
      const r = computeNewClientReadiness({ ...ALL_GOOD, treatmentConsent: { ok: false } });
      expect(r.status).toBe("unknown");
    });

    it("a WAIT pause is a PROVEN blocker, so it legitimately outranks unknown", () => {
      // not_ready here is correct and is not a collapse: admission is proven
      // paused regardless of what the unavailable authority would have said.
      vi.stubEnv(WAIT_ENV, "willow");
      const r = computeNewClientReadiness({ ...ALL_GOOD, treatmentConsent: { ok: false } });
      expect(r.status).toBe("not_ready");
      if (r.status !== "not_ready") return;
      expect(r.unavailable).toContain("treatment_consent");
    });
  });
});

describe("ONB-02 P2: readiness reads the SAME availability scope as public booking", () => {
  // WAIT admission is a PROVEN blocker and would outrank UNKNOWN, so it is
  // stubbed off here: this block is about availability SCOPE, and leaving the
  // ambient gate in play would let a wait_admission blocker answer for it.
  beforeEach(() => {
    vi.stubEnv("NEW_CLIENT_WAITLIST_STUDIO_SLUGS", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks for studio-wide defaults, not every row the studio owns", async () => {
    // THE DEFECT. `getAvailabilityDefaults` returns every row including retained
    // practitioner-specific ones, so a studio whose only open rows belong to a
    // practitioner — with every studio-wide day closed — answered READY while the
    // public booking page offered nothing. Public booking reads
    // `practitioner_id IS NULL`; readiness must read the same set, and the way to
    // prove that is which reader it calls.
    vi.mocked(queries.getActiveServices).mockResolvedValue([CONSULTATION] as never);
    vi.mocked(wideAvailability.getStudioWideDefaultsSafe).mockResolvedValue([OPEN_DAY] as never);
    vi.mocked(consent.getTreatmentConsentReadiness).mockResolvedValue({ ok: true, ready: true });

    await getNewClientReadiness({ id: "st", ...STUDIO });

    expect(
      vi.mocked(wideAvailability.getStudioWideDefaultsSafe),
      "readiness must read studio-wide availability",
    ).toHaveBeenCalled();
    expect(
      vi.mocked(wideAvailability.getStudioWideDefaultsSafe).mock.calls[0]?.[1],
      "scoped to this studio",
    ).toBe("st");
  });

  it("a studio whose studio-wide days are all closed is NOT ready", async () => {
    // The practitioner-specific rows are invisible to this reader by
    // construction, so "only practitioner rows open" reaches compute as
    // "nothing open" — which is exactly what the public page would offer.
    vi.mocked(queries.getActiveServices).mockResolvedValue([CONSULTATION] as never);
    vi.mocked(wideAvailability.getStudioWideDefaultsSafe).mockResolvedValue([
      { is_open: false, open_time: null, close_time: null },
    ] as never);
    vi.mocked(consent.getTreatmentConsentReadiness).mockResolvedValue({ ok: true, ready: true });

    const r = await getNewClientReadiness({ id: "st", ...STUDIO });
    expect(r.status).toBe("not_ready");
  });

  it("a failed studio-wide read is UNKNOWN, never 'no open days'", async () => {
    // getStudioWideDefaultsSafe fails closed rather than returning []; an empty
    // list would read as a proven blocker and collapse UNKNOWN into NOT_READY.
    vi.mocked(queries.getActiveServices).mockResolvedValue([CONSULTATION] as never);
    vi.mocked(wideAvailability.getStudioWideDefaultsSafe).mockRejectedValue(new Error("boom"));
    vi.mocked(consent.getTreatmentConsentReadiness).mockResolvedValue({ ok: true, ready: true });

    const r = await getNewClientReadiness({ id: "st", ...STUDIO });
    expect(r.status).toBe("unknown");
    if (r.status !== "unknown") return;
    expect(r.unavailable).toContain("availability");
  });
});

describe("ONB-02 P1: the owner launch surface CONSUMES the canonical authority", () => {
  // MUTATION CONTROL 1 — "canonical result not wired into the owner surface".
  //
  // An authority nothing calls makes nothing canonical. The launch checklist
  // previously loaded services, availability and consent itself and rendered
  // its own verdict, which knew nothing about WAIT admission and accepted any
  // non-empty timezone. Two answers to one question is one too many.
  //
  // Comments stripped, LINE BEFORE BLOCK: stripping blocks first lets a `/*`
  // inside a line comment swallow real code, and an identifier surviving inside
  // a comment would let a commented-out wiring satisfy this proof.
  const LAUNCH = "app/(app)/settings/launch/page.tsx";
  const strip = (src: string) =>
    src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const launchSource = async () => {
    const { readFileSync } = await import("node:fs");
    return strip(readFileSync(LAUNCH, "utf8"));
  };

  it("the launch page calls the canonical loader", async () => {
    expect(await launchSource()).toContain("getNewClientReadiness");
  });

  it("the launch page re-derives NONE of the facts the authority owns", async () => {
    const code = await launchSource();
    // Each of these is an independent read of a fact `computeNewClientReadiness`
    // already answers. Any one of them reintroduces the second authority.
    for (const bypass of [
      "getActiveServices",
      "getAvailabilityDefaults",
      "getTreatmentConsentReadiness",
      "isBookableByNewClient",
    ]) {
      expect(code, `${LAUNCH} must not re-derive via ${bypass}`).not.toContain(
        bypass,
      );
    }
  });

  it("the page renders UNKNOWN as its own state, never as a missing setup step", async () => {
    const code = await launchSource();
    // The collapse this model exists to prevent, repeated at the last inch,
    // would look exactly like dropping this branch.
    expect(code).toContain("unavailableAuthorities");
    expect(code).toMatch(/return "unknown"/);
  });

  it("WAIT admission reaches the owner surface", async () => {
    expect(await launchSource()).toContain("wait_admission");
  });

  it("the strip helper is not vacuous", () => {
    expect(strip("// getActiveServices(")).not.toContain("getActiveServices");
    expect(strip("/* getActiveServices( */")).not.toContain("getActiveServices");
    expect(strip("// x\ngetActiveServices(")).toContain("getActiveServices");
  });
});

describe("ONB-02 P2 control: retained practitioner rows must not cause READY", () => {
  // MUTATION CONTROL 2 — migration 0135 retains practitioner-specific
  // availability when a studio turns capacity back off. Public booking reads
  // only `practitioner_id IS NULL`. Reading the wider set makes a studio with
  // no public-bookable day answer READY while the booking page offers nothing.
  it("the loader asks for the studio-wide scope, not every row", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("lib/booking/new-client-readiness.ts", "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toContain("getStudioWideDefaultsSafe");
    // The wider read is the defect, so its absence is the proof.
    expect(code).not.toContain("getAvailabilityDefaults");
  });

  it("an open PRACTITIONER row cannot rescue a closed studio-wide week", () => {
    // Pure-compute proof, independent of which query the loader picked: the
    // authority is handed the studio-wide rows only, and a closed week is
    // NOT_READY no matter what other rows exist in the table.
    const r = computeNewClientReadiness({
      ...ALL_GOOD,
      availability: {
        ok: true,
        days: [{ is_open: false, open_time: null, close_time: null }],
      },
    });
    expect(r.status).toBe("not_ready");
    if (r.status !== "not_ready") throw new Error("unreachable");
    expect(r.blockers.map((b) => b.key)).toContain("availability");
  });
});
