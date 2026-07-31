import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Browser E2E must synchronize on DURABLE state, never on transient copy.
//
// THE INCIDENT THIS PREVENTS. SessionPaymentPrepareCard renders a brief
// "Session payment prepared." banner gated on `prepareJustSucceeded &&
// !activeAttempt`: it lives only between the action resolving and
// router.refresh() landing the persisted row, and disappears the moment that
// row arrives. Two payment specs waited on it. They passed by timing luck for
// months; when page timing changed they failed consistently — while the payment
// was perfectly prepared (one `ready` attempt, correct amount, NULL note, the
// Run charge button on screen). The test was asking to observe a FRAME, not a
// STATE.
//
// The banner stays in the product — it is good immediate feedback. What is
// banned is depending on its render window as a test's completion oracle.

const ROOT = path.resolve(__dirname, "../..");
const E2E_DIRS = ["e2e", "e2e-payment", "e2e-mobile", "e2e-google"];

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  for (const e of entries) {
    const full = path.join(abs, e);
    if (statSync(full).isDirectory()) out = out.concat(walk(path.join(dir, e)));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("payment E2E synchronizes on durable state, not transient copy", () => {
  const files = E2E_DIRS.flatMap(walk);

  it("finds the e2e sources (guards against a silently empty scan)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no browser test waits on the transient 'Session payment prepared' banner", () => {
    // Strip comments: the helper and this suite DOCUMENT the banned string,
    // and prose explaining the ban must not read as a violation of it. What is
    // banned is passing it to a locator.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const offenders = files.filter((f) =>
      /(getByText|locator|hasText|toHaveText|textContent)[\s\S]{0,80}session payment prepared/i.test(
        stripComments(readFileSync(f, "utf8")),
      ),
    );
    expect(
      offenders.map((f) => path.relative(ROOT, f)),
      "wait on the durable ready panel (expectPreparedDurable) instead",
    ).toEqual([]);
  });

  it("the shared helper exposes a durable prepared-state oracle", () => {
    const helper = readFileSync(
      path.join(ROOT, "e2e-payment/helpers/checkout-flow.ts"),
      "utf8",
    );
    expect(helper).toMatch(/export async function expectPreparedDurable/);
    // Durable evidence: persisted panel copy + the Run charge action + the form
    // having been replaced.
    expect(helper).toMatch(/Prepared \.\* not yet charged/i);
    expect(helper).toMatch(/\^run charge\$/i);
    // ...and proof the persisted row replaced the form.
    const fn = helper.slice(
      helper.indexOf("export async function expectPreparedDurable"),
      helper.indexOf("export function sessionPaymentRegion"),
    );
    expect(fn).toMatch(/prepare session payment/i);
    expect(fn).toMatch(/toHaveCount\(0\)/);
  });

  it("the session-detail oracle is scoped to the existing accessible region", () => {
    const helper = readFileSync(
      path.join(ROOT, "e2e-payment/helpers/checkout-flow.ts"),
      "utf8",
    );
    expect(helper).toMatch(/getByRole\("region", \{ name: "Session payment" \}\)/);
    // That label is a real, pre-existing product attribute — not one added for
    // the test.
    const card = readFileSync(
      path.join(ROOT, "components/session-payment-prepare-card.tsx"),
      "utf8",
    );
    expect(card).toMatch(/aria-label="Session payment"/);
  });

  it("the product keeps the transient banner — only the test dependency is banned", () => {
    const card = readFileSync(
      path.join(ROOT, "components/session-payment-prepare-card.tsx"),
      "utf8",
    );
    expect(card).toMatch(/Session payment prepared\./);
    expect(card).toMatch(/prepareJustSucceeded && !activeAttempt/);
  });
});
