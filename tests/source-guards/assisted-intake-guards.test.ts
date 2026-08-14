import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { INTAKE_STEPS } from "@/lib/intake/questions";
import { PRACTITIONER_ASSISTED_ENTRY } from "@/lib/intake/entry-provenance";

// Source guards for practitioner-assisted intake.
//
// These complement, never replace, the behavioural proofs in
// tests/app/clients/assisted-intake-entry.test.ts. Each one exists because the
// property it pins is invisible to a behavioural test: an author reaching for
// the service role, a carve-out being added to the public sanitizer, or the
// questionnaire being re-transcribed into a second form.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
// Strip // line comments and {/* jsx */} blocks so a negative grep targets
// real code, not prose that legitimately names a forbidden symbol.
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const PRACTITIONER_ACTIONS = "app/(app)/clients/[id]/intake/actions.ts";
const PUBLIC_ACTIONS = "app/intake/[token]/actions.ts";
const SHARED_SANITIZER = "lib/intake/responses.ts";
const PROVENANCE = "lib/intake/entry-provenance.ts";
const EDITOR = "app/(app)/clients/[id]/intake/assist/AssistedIntakeEditor.tsx";
const ASSIST_PAGE = "app/(app)/clients/[id]/intake/assist/page.tsx";
const REVIEW = "app/(app)/clients/[id]/intake/page.tsx";

const KEY = PRACTITIONER_ASSISTED_ENTRY.id;

// Slice one exported function body out of a module: from its declaration to
// the next top-level `export ` or the end of file.
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

// ---------------------------------------------------------------------------
describe("the client cannot author practitioner provenance", () => {
  it("the shared sanitizer never mentions the provenance key", () => {
    // The whole client-forgery argument rests on this key being invisible to
    // every sanitizer. If it ever gains a carve-out, the way the electrolysis
    // acknowledgement claim legitimately has one, whoever holds the intake
    // token could author, replace or erase practitioner attribution.
    expect(codeOnly(read(SHARED_SANITIZER))).not.toContain(KEY);
    expect(codeOnly(read(SHARED_SANITIZER))).not.toMatch(
      /PRACTITIONER_ASSISTED_ENTRY/,
    );
  });

  it("the PUBLIC token actions never mention the provenance key", () => {
    const code = codeOnly(read(PUBLIC_ACTIONS));
    expect(code).not.toContain(KEY);
    expect(code).not.toMatch(/PRACTITIONER_ASSISTED_ENTRY|entry-provenance/);
  });

  it("the public wizard never mentions the provenance key", () => {
    const code = codeOnly(read("app/intake/[token]/IntakeWizard.tsx"));
    expect(code).not.toContain(KEY);
    expect(code).not.toMatch(/PRACTITIONER_ASSISTED_ENTRY|entry-provenance/);
  });

  it("the public sanitizer admits exactly ONE non-question carve-out", () => {
    const body = read(PUBLIC_ACTIONS).slice(
      read(PUBLIC_ACTIONS).indexOf("function sanitizeResponses"),
    );
    const head = body.slice(0, body.indexOf("\nexport "));
    // Back down to ONE. The retired #518 acknowledgement carve-out is GONE,
    // not merely unused: leaving a browser-authorable path to a reserved key
    // that no server gate validates any more would be an orphaned forgery
    // channel. A SECOND `out[...] =` is a new carve-out and must be reviewed
    // against the forgery argument above before this count moves again.
    const assignments = head.match(/out\[[^\]]+\]\s*=/g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toContain("INTAKE_CONSENT_RESPONSES.id");
    // And the retired key is admitted by nothing at all.
    expect(head).not.toContain("ELECTROLYSIS_ACKNOWLEDGEMENT");
  });
});

// ---------------------------------------------------------------------------
describe("the assisted write uses the authenticated client, never the service role", () => {
  const src = read(PRACTITIONER_ACTIONS);
  const saveBody = functionBody(src, "saveAssistedIntakeStepAction");
  const handoffBody = functionBody(src, "handOffAssistedIntakeAction");

  it("the save action never touches createAdminClient", () => {
    // Load-bearing: migration 0162 exempts the service role from its entire
    // end-user block, including "Only the client can submit their own
    // intake". Using the admin client here would hand this action the ability
    // to submit on the client's behalf.
    expect(codeOnly(saveBody)).not.toContain("createAdminClient");
  });

  it("the save action resolves the caller through the session", () => {
    expect(saveBody).toContain("loadAssistedIntake");
    expect(codeOnly(saveBody)).toContain("await createClient()");
  });

  it("the shared loader authorises before reading the intake", () => {
    const loader = src.slice(
      src.indexOf("async function loadAssistedIntake"),
      src.indexOf("export async function saveAssistedIntakeStepAction"),
    );
    const auth = loader.indexOf("loadAuthorisedClient");
    const query = loader.indexOf('.from("client_intake_forms")');
    expect(auth).toBeGreaterThan(-1);
    expect(query).toBeGreaterThan(auth);
    expect(codeOnly(loader)).not.toContain("createAdminClient");
  });

  it("the handoff uses the service role ONLY to stamp link metadata", () => {
    const code = codeOnly(handoffBody);
    const adminUses = code.match(/createAdminClient\(\)/g) ?? [];
    expect(adminUses).toHaveLength(1);
    expect(code).toMatch(/stampIntakeLinkIssued\(createAdminClient\(\)/);
    // ...and only after the guarded UPDATE has already succeeded.
    expect(code.indexOf("createAdminClient()")).toBeGreaterThan(
      code.indexOf('.select("id, client_id")'),
    );
  });

  it("both assisted writes carry the full predicate set", () => {
    for (const [name, body] of [
      ["save", saveBody],
      ["handoff", handoffBody],
    ] as const) {
      expect(body, `${name}: studio predicate`).toMatch(/\.eq\("studio_id"/);
      expect(body, `${name}: client predicate`).toMatch(/\.eq\("client_id"/);
      expect(body, `${name}: soft-delete predicate`).toMatch(
        /\.is\("deleted_at", null\)/,
      );
      expect(body, `${name}: in_progress predicate`).toMatch(
        /\.eq\("status", "in_progress"\)/,
      );
      expect(body, `${name}: returns affected rows`).toMatch(/\.select\(/);
    }
  });

  it("the save action carries the optimistic-concurrency predicate", () => {
    expect(saveBody).toMatch(/\.eq\("updated_at", expectedUpdatedAt\)/);
  });

  it("neither assisted write can set status or submitted_at", () => {
    for (const body of [saveBody, handoffBody]) {
      const code = codeOnly(body);
      expect(code).not.toMatch(/status:\s*["']submitted["']/);
      expect(code).not.toMatch(/submitted_at:/);
      expect(code).not.toMatch(/reviewed_by:/);
      expect(code).not.toMatch(/reviewed_at:/);
    }
  });

  it("the actor is never read from the request payload", () => {
    for (const body of [saveBody, handoffBody]) {
      const code = codeOnly(body);
      expect(code).not.toMatch(/payload\.(practitioner|studio|actor)/i);
      expect(code).not.toMatch(/formData\.get\("(practitioner|studio|actor)/i);
    }
  });

  it("no assisted path returns raw provider text", () => {
    const code = codeOnly(read(PRACTITIONER_ACTIONS));
    // Every `error:` returned to the browser must be a curated constant.
    expect(code).not.toMatch(/error:\s*[a-zA-Z]*[eE]rr(or)?\.message/);
  });
});

// ---------------------------------------------------------------------------
describe("the questionnaire is not re-implemented", () => {
  it("the assisted editor renders through the shared authority", () => {
    const code = read(EDITOR);
    expect(code).toMatch(/visibleQuestionsForStep/);
    expect(code).toMatch(/validateVisibleAnswers/);
    expect(code).toMatch(/IntakeQuestionField/);
  });

  it("the assisted editor hard-codes no question key, label or option", () => {
    const code = codeOnly(read(EDITOR));
    for (const step of INTAKE_STEPS) {
      for (const q of step.questions) {
        expect(code, `editor names question key ${q.key}`).not.toContain(
          `"${q.key}"`,
        );
        // A distinctive slice of each label; a full-label match would be
        // fooled by short labels appearing incidentally.
        const fragment = q.label.slice(0, 40);
        if (fragment.length >= 20) {
          expect(code, `editor inlines label for ${q.key}`).not.toContain(
            fragment,
          );
        }
      }
    }
  });

  it("the assisted editor never calls the public token actions", () => {
    const code = read(EDITOR);
    expect(code).not.toMatch(/saveIntakeStepAction|submitIntakeAction/);
    expect(code).not.toMatch(/app\/intake\/\[token\]/);
  });

  // FAIL-CLOSED CONSUMER GUARD.
  //
  // Moving the control renderer into a shared component created a surface the
  // existing acknowledgement guards cannot see: they enumerate hard-coded file
  // paths, so a NEW consumer of the renderer is invisible to them. A new
  // consumer is exactly the dangerous case, the renderer emits a real
  // <input type="checkbox">, and the step-5 acknowledgements are client-owned
  // first-person attestations that a practitioner must never be able to tick.
  //
  // So this enumerates the consumers that exist today and fails when a new one
  // appears. That is deliberate: adding a surface that renders intake controls
  // should require a human to confirm it cannot reach a client-owned question.
  it("only known surfaces may render intake controls", () => {
    const roots = ["app", "components", "lib"];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name) && read(rel).includes("intake-question-field")) {
          hits.push(rel);
        }
      }
    };
    for (const r of roots) walk(r);

    // Importers only: the renderer does not reference its own path.
    expect(hits.sort()).toEqual(
      [
        // The client's own tokenized wizard, renders every step, including
        // the client's acknowledgements. That is correct: they are the client.
        "app/intake/[token]/IntakeWizard.tsx",
        // The practitioner-assisted editor: renders PRACTITIONER_ENTERABLE_STEPS
        // only, so it can never draw a client-owned control.
        EDITOR,
      ].sort(),
    );
  });

  // The direct-importer walk above is defeated by INDIRECTION: file A imports
  // the renderer and re-exports it, file B imports from A. B renders intake
  // controls while naming neither the renderer module nor appearing in the
  // importer set, so the guard above stays green.
  //
  // This repo has been bitten by exactly this shape twice in the appointment
  // DML census guard work, alias evasion (a factory classified by callee name
  // defeated by `createClient as createAdminClient`) and the detached chain
  // (`const q = admin.from(...)` invisible to a call-site walker). Both were
  // real, and both were found by review rather than by the guard's author.
  //
  // Closing the re-export path is cheap, so it is closed rather than argued
  // about: no file outside the renderer module may re-export its symbol.
  it("no file re-exports the control renderer, so the importer walk cannot be bypassed", () => {
    const RENDERER = "components/intake/intake-question-field.tsx";
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.tsx?$/.test(e.name) || rel === RENDERER) continue;
        const code = codeOnly(read(rel));
        // `export { IntakeQuestionField ... }` / `export { X as IntakeQuestionField }`
        const reExportsSymbol =
          /export\s*\{[^}]*\bIntakeQuestionField\b[^}]*\}/.test(code);
        // `export * from ".../intake-question-field"`
        const reExportsStar =
          /export\s+\*\s+from\s+["'][^"']*intake-question-field["']/.test(code);
        if (reExportsSymbol || reExportsStar) offenders.push(rel);
      }
    };
    for (const r of ["app", "components", "lib"]) walk(r);
    expect(offenders).toEqual([]);
  });

  it("the assisted editor's step set structurally excludes the client's step", () => {
    // Not a copy of the step list: the editor derives it, and this asserts the
    // derivation is what it uses. If someone swaps STEP_IDS for INTAKE_STEPS,
    // the acknowledgements step becomes reachable and this goes red.
    const code = codeOnly(read(EDITOR));
    expect(code).toMatch(/PRACTITIONER_ENTERABLE_STEPS\.map\(\(s\) => s\.id\)/);
    expect(code).not.toMatch(/INTAKE_STEPS/);
    expect(code).not.toMatch(/ACKNOWLEDGEMENTS_STEP_ID/);
  });

  it("the practitioner REVIEW page renders no intake form control", () => {
    // The acknowledgement review card is server-rendered prose with no
    // control, which is what makes it un-tickable by a practitioner
    // (e2e/intake-electrolysis-acknowledgement.spec.ts D6 asserts count 0 in
    // the browser). This is the unit-level tripwire for the same contract, so
    // routing that page through the shared renderer fails here first.
    const src = read(REVIEW);
    expect(src).not.toContain("intake-question-field");
    for (const name of ["IntakeEntrySummary", "ElectrolysisAcknowledgementSummary"]) {
      const start = src.indexOf(`function ${name}`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const after = src.indexOf("\nfunction ", start + 1);
      const body = codeOnly(src.slice(start, after === -1 ? undefined : after));
      expect(body, `${name} must emit no form control`).not.toMatch(
        /<input|<textarea|<select|<button/,
      );
    }
  });

  it("exactly one component renders intake controls", () => {
    // The wizard and the assisted editor must both go through the shared
    // field component; a third `renderControl` would be a new fork.
    const wizard = read("app/intake/[token]/IntakeWizard.tsx");
    expect(wizard).toContain("IntakeQuestionField");
    expect(codeOnly(wizard)).not.toContain("function renderControl");
    expect(codeOnly(read(EDITOR))).not.toContain("function renderControl");
  });
});

// ---------------------------------------------------------------------------
describe("the assisted UI never claims to be the client", () => {
  const surfaces = [EDITOR, ASSIST_PAGE];

  for (const rel of surfaces) {
    it(`${rel} uses no impersonation language`, () => {
      // Scoped to code, not prose: the concern is copy that SHIPS to a
      // practitioner. Comments in these files legitimately name the forbidden
      // phrases in order to explain why they are forbidden.
      const code = codeOnly(read(rel));
      expect(code).not.toMatch(/on behalf of/i);
      expect(code).not.toMatch(/acting as (the )?client/i);
      expect(code).not.toMatch(/sign(ing)? for (the )?client/i);
      expect(code).not.toMatch(/submit(ting)? for (the )?client/i);
      expect(code).not.toMatch(/as the client\b/i);
    });

    it(`${rel} collects no signature and touches no consent record`, () => {
      const code = codeOnly(read(rel));
      expect(code).not.toMatch(/signature_name|signatureName|typedName/);
      expect(code).not.toMatch(/client_consent_signatures/);
    });
  }

  it("the editor states who completes the acknowledgements", () => {
    const code = read(EDITOR);
    expect(code).toMatch(/Completing with client/);
    expect(code).toMatch(/Client confirmation required/);
    expect(code).toMatch(/Hand to client/);
  });

  it("the review surface renders the STORED snapshot, not a current lookup", () => {
    // getPractitionersForStudio filters `.eq("active", true)`, so resolving
    // the name at read time makes attribution vanish the moment a
    // practitioner is deactivated, exactly what already happens to
    // reviewed_by on this page. A historical fact must not depend on a
    // current lookup.
    const src = read(REVIEW);
    const start = src.indexOf("function IntakeEntrySummary");
    expect(start).toBeGreaterThan(-1);
    const after = src.indexOf("\nfunction ", start + 1);
    const body = src.slice(start, after === -1 ? undefined : after);
    expect(body).toMatch(/view\.startedBy\.display_name/);
    expect(codeOnly(body)).not.toMatch(/practitionerName\(/);
    expect(codeOnly(body)).not.toMatch(/getPractitionersForStudio/);
    expect(codeOnly(body)).not.toMatch(/practitioners\.find/);
  });

  it("the review surface keeps entry provenance separate from the acknowledgement", () => {
    const code = read(REVIEW);
    const entry = code.indexOf("IntakeEntrySummary");
    const ack = code.indexOf("ElectrolysisAcknowledgementSummary");
    expect(entry).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(-1);
    // Two distinct components, not one merged card.
    expect(code).toMatch(/function IntakeEntrySummary/);
    expect(code).toMatch(/function ElectrolysisAcknowledgementSummary/);
  });
});

// ---------------------------------------------------------------------------
describe("no schema change", () => {
  it("no migration mentions the provenance key", () => {
    const dir = "supabase/migrations";
    const offenders = readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => read(`${dir}/${f}`).includes(KEY));
    expect(offenders).toEqual([]);
  });

  it("this feature did not author migration 0172", () => {
    // 0172 was RESERVED for Appointment DML B3, and B3 has now claimed it
    // (0172_revoke_authenticated_appointment_dml.sql). The guard's subject was
    // never "0172 must not exist", it is "this feature did not author it".
    // Asserting absence would now fail for the very reason the reservation
    // existed, so the check is re-pointed at authorship: whatever occupies
    // 0172, it must be B3's privilege migration and must contain nothing of
    // this feature. This feature stores its provenance inside the responses
    // jsonb that migration 0015 already provides.
    const files = readdirSync(path.join(ROOT, "supabase/migrations")).filter(
      (f) => f.endsWith(".sql"),
    );
    const claimed = files.filter((f) => f.startsWith("0172"));
    expect(claimed).toHaveLength(1);

    const sql = read(`supabase/migrations/${claimed[0]}`);
    expect(sql).not.toContain(KEY);
    expect(sql).not.toMatch(/intake/i);
    // And it is a privilege migration, not a schema change smuggled in here.
    expect(sql).not.toMatch(/create table|alter table|add column/i);
  });

  it("the provenance lives in the existing responses jsonb", () => {
    const save = functionBody(read(PRACTITIONER_ACTIONS), "saveAssistedIntakeStepAction");
    expect(save).toMatch(/merged\[PRACTITIONER_ASSISTED_ENTRY\.id\]/);
    expect(save).toMatch(/\.update\(\{ responses: merged/);
  });

  it("the provenance module declares no column or table", () => {
    const code = read(PROVENANCE);
    expect(code).not.toMatch(/alter table|create table|add column/i);
  });
});
