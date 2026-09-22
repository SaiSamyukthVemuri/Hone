import { describe, expect, it, vi, beforeEach } from "vitest";

// ONB-02 — canonical new-client booking readiness.
//
// BEHAVIOURAL. Every state below is produced by running the real compute over
// real-shaped evidence, never by asserting that a string appears in the source.
//
// The negative control for this file: delete the `services.ok` / `availability.ok`
// guards in computeNewClientReadiness (so an unavailable authority is treated as
// an empty list) and the UNKNOWN cases must go RED with status "not_ready".

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/booking/queries", () => ({
  getActiveServices: vi.fn(),
  getAvailabilityDefaults: vi.fn(),
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
    vi.mocked(queries.getAvailabilityDefaults).mockResolvedValue([OPEN_DAY] as never);
    vi.mocked(consent.getTreatmentConsentReadiness).mockResolvedValue({ ok: true, ready: true });

    const r = await getNewClientReadiness({ id: "st", ...STUDIO });
    expect(r.status).toBe("unknown");
    if (r.status !== "unknown") throw new Error("unreachable");
    expect(r.unavailable).toEqual(["services"]);
  });

  it("one failed authority does not take out the others", async () => {
    vi.mocked(queries.getActiveServices).mockResolvedValue([CONSULTATION] as never);
    vi.mocked(queries.getAvailabilityDefaults).mockRejectedValue(new Error("boom"));
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
    vi.mocked(queries.getAvailabilityDefaults).mockResolvedValue([OPEN_DAY] as never);
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

  it("the launch checklist asks the canonical predicate", async () => {
    const { readFileSync } = await import("node:fs");
    const code = strip(
      readFileSync("app/(app)/settings/launch/page.tsx", "utf8"),
    );
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
