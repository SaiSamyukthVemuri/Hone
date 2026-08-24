import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  practitionerIntakeReviewHref,
  resolveTodayIntakeAction,
  selectCurrentIntakeByClient,
  type TodayIntakeRow,
} from "@/lib/dashboard/today-intake";

// "Review intake" from Today. Chloe's working screen must open the client's
// intake directly instead of routing her through
// Today -> client profile -> Health & Forms -> intake.
//
// The pure rules are tested directly; the dashboard/appointment wiring, the
// no-N+1 read shape and the narrow projection are source-pinned below.

const PAGE = readFileSync(
  join(process.cwd(), "app/(app)/dashboard/page.tsx"),
  "utf8",
);
const APPOINTMENT = readFileSync(
  join(process.cwd(), "app/(app)/calendar/[id]/page.tsx"),
  "utf8",
);
const HELPER = readFileSync(
  join(process.cwd(), "lib/dashboard/today-intake.ts"),
  "utf8",
);
const INTAKE_QUERIES = readFileSync(
  join(process.cwd(), "lib/intake/queries.ts"),
  "utf8",
);

// Comment lines legitimately NAME the things the code must not do (e.g. "no
// `responses`"), so read-width and wording assertions run over executable
// lines only.
function executableOnly(source: string): string {
  return (
    source
      // JSX comment BLOCKS first. A line filter cannot see them: only the
      // opening line begins with `{/*`, and every line after it begins with
      // ordinary prose, so the body of a `{/* … */}` comment reached the
      // assertions below as if it were code. That made this guard trip on a
      // dashboard comment that merely used the word "acknowledgement" while
      // explaining a navigation. Prose must not be able to trip a source
      // assertion any more than it may satisfy one.
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n")
  );
}

// A whole top-level function body, including nested blocks. A naive
// /function X\([\s\S]*?\n\}/ truncates at the first column-0 `}`, which for a
// destructured-props component is the `}: {` of its own type annotation.
function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const after = source.slice(start);
  // Ends at the next top-level `function ` / section divider, or EOF.
  const end = after.search(/\n(?:\/\/ -{10,}|(?:export )?(?:async )?function )/);
  return end === -1 ? after : after.slice(0, end);
}

// ---------------------------------------------------------------------------
// 1-4. The state matrix. The CTA must be truthful.
// ---------------------------------------------------------------------------
describe("resolveTodayIntakeAction — state matrix", () => {
  it("submitted intake: Review intake, to the practitioner review route", () => {
    expect(
      resolveTodayIntakeAction({ status: "submitted", clientId: "c1" }),
    ).toEqual({ label: "Review intake", href: "/clients/c1/intake" });
  });

  it("reviewed intake: Review intake, to the SAME route", () => {
    expect(
      resolveTodayIntakeAction({ status: "reviewed", clientId: "c1" }),
    ).toEqual({ label: "Review intake", href: "/clients/c1/intake" });
    // Submitted and reviewed differ only in the pill; the destination is one
    // canonical surface, never two.
    expect(
      resolveTodayIntakeAction({ status: "reviewed", clientId: "c1" })?.href,
    ).toBe(
      resolveTodayIntakeAction({ status: "submitted", clientId: "c1" })?.href,
    );
  });

  it("in_progress intake: NOT labelled Review intake — no action at all", () => {
    // The client has not finished it. Offering "Review intake" would promise a
    // completed record that does not exist.
    expect(
      resolveTodayIntakeAction({ status: "in_progress", clientId: "c1" }),
    ).toBeNull();
  });

  it("no intake on file: no review action is fabricated", () => {
    expect(resolveTodayIntakeAction({ status: null, clientId: "c1" })).toBeNull();
  });

  it("only submitted/reviewed ever produce an action", () => {
    const producing = (["in_progress", "submitted", "reviewed", null] as const)
      .filter((s) => resolveTodayIntakeAction({ status: s, clientId: "c1" }))
      .map((s) => s);
    expect(producing).toEqual(["submitted", "reviewed"]);
  });
});

// ---------------------------------------------------------------------------
// 5-6. Navigation contract: the canonical authenticated route, never the
// client's bearer-token page.
// ---------------------------------------------------------------------------
describe("navigation contract", () => {
  it("the href is the canonical practitioner review route", () => {
    expect(practitionerIntakeReviewHref("abc")).toBe("/clients/abc/intake");
  });

  it("no state can produce the public /intake/<token> route", () => {
    for (const status of ["in_progress", "submitted", "reviewed", null] as const) {
      const href =
        resolveTodayIntakeAction({ status, clientId: "c1" })?.href ?? "";
      expect(href.startsWith("/intake/")).toBe(false);
      expect(href).not.toMatch(/token/i);
    }
  });

  it("every produced href is an app-internal /clients/<id>/intake path", () => {
    for (const status of ["submitted", "reviewed"] as const) {
      const href = resolveTodayIntakeAction({ status, clientId: "c-1" })!.href;
      expect(href).toMatch(/^\/clients\/[^/]+\/intake$/);
    }
  });

  it("the helper never mints, reads or names a token/bearer/portal path", () => {
    const executable = HELPER.split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(executable).not.toMatch(/token|bearer|magic|portal|\/intake\//i);
    // Pure: no I/O, no clock, no Supabase client.
    expect(executable).not.toMatch(/supabase|createClient|fetch\(|Date\.now/);
  });

  it("the Today CTA renders the resolved action only — never a literal token route", () => {
    expect(PAGE).toMatch(/href=\{intakeAction\.href\}/);
    expect(PAGE).toMatch(/\{intakeAction\.label\}/);
    expect(PAGE).not.toMatch(/href=\{`\/intake\//);
  });
});

// ---------------------------------------------------------------------------
// 7. Current-intake selection. The case that matters: an older reviewed intake
// plus a newer in-progress reissue.
// ---------------------------------------------------------------------------
describe("selectCurrentIntakeByClient", () => {
  const OLD_REVIEWED: TodayIntakeRow = {
    client_id: "c1",
    status: "reviewed",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const NEW_IN_PROGRESS: TodayIntakeRow = {
    client_id: "c1",
    status: "in_progress",
    created_at: "2026-08-01T00:00:00.000Z",
  };

  it("older reviewed + newer in_progress: the NEWER row is current", () => {
    // Query order (created_at desc).
    expect(
      selectCurrentIntakeByClient([NEW_IN_PROGRESS, OLD_REVIEWED]).get("c1"),
    ).toBe("in_progress");
    // ...and the same answer if the rows arrive in any other order, so the
    // rule is the helper's, not the query's.
    expect(
      selectCurrentIntakeByClient([OLD_REVIEWED, NEW_IN_PROGRESS]).get("c1"),
    ).toBe("in_progress");
  });

  it("...and therefore Today offers NO review action for that client", () => {
    const status =
      selectCurrentIntakeByClient([NEW_IN_PROGRESS, OLD_REVIEWED]).get("c1") ??
      null;
    expect(resolveTodayIntakeAction({ status, clientId: "c1" })).toBeNull();
  });

  it("older in_progress + newer submitted: the newer row is current", () => {
    const rows: TodayIntakeRow[] = [
      { client_id: "c1", status: "submitted", created_at: "2026-08-01T00:00:00.000Z" },
      { client_id: "c1", status: "in_progress", created_at: "2026-01-01T00:00:00.000Z" },
    ];
    expect(selectCurrentIntakeByClient(rows).get("c1")).toBe("submitted");
    expect(
      resolveTodayIntakeAction({ status: "submitted", clientId: "c1" }),
    ).not.toBeNull();
  });

  it("keeps clients independent and never invents one", () => {
    const map = selectCurrentIntakeByClient([
      NEW_IN_PROGRESS,
      OLD_REVIEWED,
      { client_id: "c2", status: "reviewed", created_at: "2026-02-02T00:00:00.000Z" },
    ]);
    expect(map.get("c1")).toBe("in_progress");
    expect(map.get("c2")).toBe("reviewed");
    expect(map.get("c3")).toBeUndefined();
    expect(map.size).toBe(2);
  });

  it("no rows: an empty map, so every client resolves to no action", () => {
    expect(selectCurrentIntakeByClient([]).size).toBe(0);
  });

  it("does not mutate its input", () => {
    const rows: TodayIntakeRow[] = [NEW_IN_PROGRESS, OLD_REVIEWED];
    const before = JSON.stringify(rows);
    selectCurrentIntakeByClient(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("matches the canonical single-client rule in lib/intake/queries.ts", () => {
    // If the canonical selection ever stops being "newest non-deleted row by
    // created_at", this pin fails and the Today projection must follow it
    // rather than silently disagreeing with the page its link opens.
    expect(INTAKE_QUERIES).toMatch(
      /getLatestIntakeForClient[\s\S]{0,700}?\.is\("deleted_at", null\)[\s\S]{0,200}?\.order\("created_at", \{ ascending: false \}\)[\s\S]{0,120}?\.limit\(1\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 8-10. Tenant scoping, privacy/read width, and no N+1 — pinned at the source,
// because they are properties of the dashboard's single query.
// ---------------------------------------------------------------------------
describe("Today intake projection (source pins)", () => {
  const LOADER = functionSource(PAGE, "loadIntakeStatusByClient");
  const LOADER_CODE = executableOnly(LOADER);

  it("the loader exists and is the only intake read on the Today path", () => {
    expect(LOADER.length).toBeGreaterThan(0);
    // Exactly two `client_intake_forms` reads on the dashboard: the per-client
    // status projection and the studio-wide awaiting-review COUNT. Neither is
    // per-appointment.
    const reads = PAGE.match(/\.from\("client_intake_forms"\)/g) ?? [];
    expect(reads).toHaveLength(2);
  });

  it("8. the read is studio-scoped and restricted to today's clients", () => {
    expect(LOADER).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(LOADER).toMatch(/\.in\("client_id", clientIds as string\[\]\)/);
    expect(LOADER).toMatch(/\.is\("deleted_at", null\)/);
    // The authenticated (RLS-scoped) server client, never the admin client.
    expect(PAGE).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(PAGE).not.toMatch(/createAdminClient/);
  });

  it("9. the projection is narrow — no responses / medical answers", () => {
    expect(LOADER_CODE).toMatch(/\.select\("client_id, status, created_at"\)/);
    expect(LOADER_CODE).not.toMatch(/responses/);
    expect(LOADER_CODE).not.toMatch(/\.select\("\*"\)/);
    // Nothing on the dashboard pulls the intake answers, acknowledgement or
    // consent text just to render a link.
    expect(executableOnly(PAGE)).not.toMatch(
      /responses|practitioner_notes|acknowledg|consent/i,
    );
  });

  it("10. no N+1: one batched query, resolved in memory, not per appointment", () => {
    expect(LOADER).toMatch(/selectCurrentIntakeByClient/);
    // The loader is awaited ONCE, in the page's batched Promise.all — never
    // inside the appointment map.
    expect(PAGE.match(/loadIntakeStatusByClient\(/g) ?? []).toHaveLength(2); // decl + 1 call
    expect(PAGE).toMatch(
      /Promise\.all\(\[[\s\S]{0,400}?loadIntakeStatusByClient\(supabase, studio\.id, selectedDayClientIds\)/,
    );
    // The row renderer reads the prepared map; it never queries.
    expect(PAGE).toMatch(/intakeStatus=\{intakeByClient\.get\(appt\.client_id\) \?\? null\}/);
  });

  it("the CTA is a SIBLING of the row-body link, not nested inside it", () => {
    // Nested anchors are invalid and break the row. The row body link closes
    // before the action column opens.
    expect(PAGE).not.toMatch(
      /<Link[^>]*calendar\/\$\{appt\.id\}[\s\S]{0,4000}?data-testid="today-review-intake"/,
    );
    expect(PAGE).toMatch(
      /\{intakeAction && \([\s\S]{0,400}?data-testid="today-review-intake"/,
    );
  });

  it("the row resolves the action from already-loaded status", () => {
    expect(PAGE).toMatch(
      /resolveTodayIntakeAction\(\{\s*status: intakeStatus,\s*clientId: appt\.client_id,\s*\}\)/,
    );
  });

  it("Today creates no intake and sends no email", () => {
    expect(PAGE).not.toMatch(/startAssistedIntakeAction|createIntakeRequestForClient|ensureIntakeForClient/);
    expect(PAGE).not.toMatch(/generateIntakeLinkUrl|generateIntakeToken|mintIntake/);
  });
});

// ---------------------------------------------------------------------------
// The appointment prep surface says the same words and uses the same helper.
// ---------------------------------------------------------------------------
describe("appointment prep surface", () => {
  it("uses the shared canonical href helper, not a hand-written path", () => {
    expect(APPOINTMENT).toMatch(/practitionerIntakeReviewHref\(clientId\)/);
    expect(APPOINTMENT).not.toMatch(/href=\{`\/clients\/\$\{clientId\}\/intake`\}/);
  });

  it("names the practitioner task instead of vague View/Review copy", () => {
    const line = functionSource(APPOINTMENT, "IntakeStatusLine");
    expect(line).toMatch(/IntakeStatusLine/);
    // Exactly the two linked states — submitted and reviewed.
    expect(line.match(/>\s*Review intake\s*</g) ?? []).toHaveLength(2);
    expect(line).not.toMatch(/>\s*View\s*</);
    expect(line).not.toMatch(/>\s*Review\s*</);
  });

  it("still offers no review link for in-progress or absent intake", () => {
    const line = functionSource(APPOINTMENT, "IntakeStatusLine");
    const inProgress =
      /if \(intake\.status === "in_progress"\)[\s\S]*?\n  \}/.exec(line)?.[0] ?? "";
    expect(inProgress).toMatch(/started, not yet submitted/);
    expect(inProgress).not.toMatch(/<Link/);
    const none = /if \(!intake\)[\s\S]*?\n  \}/.exec(line)?.[0] ?? "";
    expect(none).toMatch(/no form on file/);
    expect(none).not.toMatch(/<Link/);
  });

  it("PR #517 appointment-preparation memory is untouched by this change", () => {
    // The intake affordance is a separate line in the client briefing; it must
    // not have absorbed or reshaped the previous-treatment memory.
    expect(APPOINTMENT).toMatch(/<IntakeStatusLine intake=\{intake\} clientId=\{client\.id\} \/>/);
    expect(APPOINTMENT).toMatch(/getLatestIntakeForClient\(studio\.id, clientId\)/);
  });
});
