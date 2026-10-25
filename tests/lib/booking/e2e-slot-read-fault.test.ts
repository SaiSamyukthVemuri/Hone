import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSlotReadFaultNotRequestedInDeployment,
  E2E_SLOT_FAULT_SLUG_PREFIX,
  shouldFailSlotReadForSlug,
  throwIfSlotReadFaulted,
} from "@/lib/booking/e2e-slot-read-fault";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const ON = { HONE_E2E_SLOT_READ_FAULT: "1" };
const MARKED = `${E2E_SLOT_FAULT_SLUG_PREFIX}ab12cd34`;
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("slot read fault is OFF unless explicitly requested", () => {
  it("is off with an empty environment, even for a marked slug", () => {
    expect(shouldFailSlotReadForSlug(MARKED, env({}))).toBe(false);
  });

  it("is off for every near-miss marker value", () => {
    for (const value of ["", "0", "true", "yes", "on", "1 ", " 1", "TRUE"]) {
      expect(
        shouldFailSlotReadForSlug(
          MARKED,
          env({ HONE_E2E_SLOT_READ_FAULT: value }),
        ),
        `value ${JSON.stringify(value)}`,
      ).toBe(false);
    }
  });

  it("fires only for the marked slug prefix", () => {
    expect(shouldFailSlotReadForSlug(MARKED, env(ON))).toBe(true);
    expect(shouldFailSlotReadForSlug("e2e-studio-ab12cd34", env(ON))).toBe(
      false,
    );
    expect(shouldFailSlotReadForSlug(`x-${MARKED}`, env(ON))).toBe(false);
  });

  it("never fires in a deployed runtime, and throws if requested there", () => {
    const signals: Record<string, string>[] = [
      { VERCEL: "1" },
      { VERCEL_ENV: "production" },
      { AWS_REGION: "us-east-1" },
      { KUBERNETES_SERVICE_HOST: "10.0.0.1" },
    ];
    for (const signal of signals) {
      expect(shouldFailSlotReadForSlug(MARKED, env({ ...ON, ...signal }))).toBe(
        false,
      );
      expect(() =>
        assertSlotReadFaultNotRequestedInDeployment(env({ ...ON, ...signal })),
      ).toThrow(/must never be set in a deployed environment/);
      expect(() =>
        throwIfSlotReadFaulted(MARKED, env({ ...ON, ...signal })),
      ).toThrow(/must never be set/);
    }
    expect(() =>
      assertSlotReadFaultNotRequestedInDeployment(env({ VERCEL: "1" })),
    ).not.toThrow();
  });

  it("throws the availability_read_failed shape the action's catch path handles", () => {
    expect(() => throwIfSlotReadFaulted(MARKED, env(ON))).toThrow(
      /^availability_read_failed:/,
    );
    expect(() => throwIfSlotReadFaulted("e2e-studio-x", env(ON))).not.toThrow();
  });
});

describe("wiring", () => {
  it("the public action calls the seam inside the try that maps the failure to a generic refusal", () => {
    const src = read("app/book/[slug]/actions.ts");
    const fetchSrc = src.slice(
      src.indexOf("export async function fetchPublicSlotsAction"),
    );
    const seam = fetchSrc.indexOf("throwIfSlotReadFaulted(params.slug)");
    expect(seam).toBeGreaterThan(fetchSrc.indexOf("try {"));
    expect(seam).toBeLessThan(fetchSrc.indexOf("getAvailableSlots("));
    expect(fetchSrc).toContain("PUBLIC_BOOKING_GENERIC_ERROR");
  });

  it("the production env gate fails a build that carries the marker", () => {
    const src = read("scripts/check-production-env-gates.mjs");
    expect(src).toMatch(/HONE_E2E_SLOT_READ_FAULT !== undefined/);
    expect(
      src.slice(src.indexOf("HONE_E2E_SLOT_READ_FAULT !== undefined")),
    ).toMatch(/failed = true/);
  });

  it("the production gate script exits non-zero with the marker and does not name it when absent", () => {
    const run = (extra: Record<string, string>) =>
      spawnSync(process.execPath, ["scripts/check-production-env-gates.mjs"], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "/tmp",
          VERCEL_ENV: "production",
          ...extra,
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
    const withMarker = run({ HONE_E2E_SLOT_READ_FAULT: "1" });
    expect(withMarker.status).toBe(1);
    expect(withMarker.stdout).toContain("FAIL e2e-slot-read-fault");
    expect(run({}).stdout).not.toContain("e2e-slot-read-fault");
  });

  it("the form renders the failure state before the empty-day state and never offers Next available on it", () => {
    const src = read("app/book/[slug]/PublicBookForm.tsx");
    const failed = src.indexOf(") : slotsFailed ? (");
    const empty = src.indexOf(") : slots.length === 0 ? (");
    expect(failed).toBeGreaterThan(0);
    expect(failed).toBeLessThan(empty);
    const failedBranch = src.slice(failed, empty);
    expect(failedBranch).toContain("could not be loaded");
    expect(failedBranch).not.toContain("No availability");
    expect(failedBranch).not.toContain("onFindNext");
    expect(src).toMatch(/setSlotsFailed\(true\)/);
  });
});
