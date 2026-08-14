import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #156 (migration 0068). The new-session server action is the
// single writer of sessions.appointment_id. Pin the lineage and
// safety invariants as text so a refactor that drops the studio /
// client / UUID checks is caught before merge.

const ACTION_PATH = path.resolve(
  __dirname,
  "../../../../app/(app)/clients/[id]/sessions/new/actions.ts",
);
const SOURCE = readFileSync(ACTION_PATH, "utf8");

describe("startSessionAction lineage + safety contract for appointment_id", () => {
  it("reads appointment_id from formData", () => {
    expect(SOURCE).toMatch(
      /formData\.get\(\s*["']appointment_id["']\s*\)/,
    );
  });

  it("applies a UUID sanity check before the DB lookup", () => {
    // Stops obviously-bad input early without a roundtrip. RLS would
    // refuse the lookup anyway, but the static check stabilises the
    // error message.
    expect(SOURCE).toMatch(/UUID_RE/);
    expect(SOURCE).toMatch(/UUID_RE\.test\(/);
  });

  it("looks the appointment up via the authenticated RLS client (no admin client for the lineage check)", () => {
    // The PR #156 lineage check runs as the authenticated practitioner;
    // RLS already blocks foreign rows. The appointment SELECT must
    // therefore happen via the createClient from lib/supabase/server,
    // not the service-role admin client.
    //
    // PR #180 introduces a SEPARATE, cold-path RPC call to the
    // SECURITY DEFINER mark_appointment_complete from the auto-
    // complete helper at the bottom of the action. That helper does
    // require the admin client (the RPC expects the service-role
    // context). To preserve the original safety guarantee we now
    // pin: (1) the lineage SELECT still uses the RLS client (the
    // .from("appointments") call appears in the action body BEFORE
    // any admin import); (2) the only admin-client reference is
    // inside the maybeMarkAppointmentCompletedOnSessionStart helper
    // (audited separately in tests/app/sessions/start-session-auto-
    // complete.test.ts).
    expect(SOURCE).toMatch(/from\("appointments"\)/);
    // The admin import is dynamic + scoped to the auto-complete helper.
    const adminImportMatches =
      SOURCE.match(/import\("@\/lib\/supabase\/admin-server"\)/g) ?? [];
    expect(adminImportMatches.length).toBe(1);
    expect(SOURCE).toMatch(
      /maybeMarkAppointmentCompletedOnSessionStart[\s\S]{0,2000}await import\("@\/lib\/supabase\/admin-server"\)/,
    );
  });

  it("selects studio_id, client_id, practitioner_id (and PR #180 also status + ends_at) from the appointment row", () => {
    // PR #156 patch + PR #180. The select list must carry every
    // lineage column the action compares against the server-resolved
    // session context AND the status / ends_at fields the PR #180
    // auto-complete helper consults. Missing any column would
    // silently degrade a corresponding check to "always pass" or
    // disable auto-complete.
    expect(SOURCE).toMatch(
      /\.select\(\s*["']id, studio_id, client_id, practitioner_id, status, ends_at["']\s*\)/,
    );
  });

  it("validates studio_id lineage server-side", () => {
    // The studio is server-resolved via getCurrentPractitionerWithStudio.
    // The action MUST compare appt.studio_id to studio.id and reject
    // mismatches; trusting the form value would let a tampered POST
    // bind a session to another studio's appointment.
    expect(SOURCE).toMatch(/appt\.studio_id\s*!==\s*studio\.id/);
  });

  it("validates client_id lineage server-side", () => {
    // Same studio, different client is also a reject: a session is
    // per-client, and a cross-client link would corrupt two clients'
    // treatment timelines.
    expect(SOURCE).toMatch(/appt\.client_id\s*!==\s*clientId/);
  });

  it("validates practitioner_id lineage server-side (non-null case)", () => {
    // PR #156 patch. The appointment may have practitioner_id set to
    // null (legacy / pre-assignment), in which case the check passes
    // and the session links freely; the action records the current
    // practitioner via practitioner_id on the insert payload below
    // regardless. When the appointment IS assigned, a mismatch
    // against the server-resolved practitioner.id is a hard reject so
    // a tampered form value cannot bind a session to another
    // practitioner's appointment within the same studio + client.
    expect(SOURCE).toMatch(
      /if \(appt\.practitioner_id && appt\.practitioner_id !== practitioner\.id\)/,
    );
  });

  it("uses a stable practitioner-mismatch error message", () => {
    // The error message is part of the public contract for callers
    // that surface it (today: the practitioner sees it in the
    // browser). Pin the exact copy so a future refactor cannot drift
    // the wording silently.
    expect(SOURCE).toMatch(
      /"Appointment is assigned to a different practitioner\."/,
    );
  });

  it("never trusts a client-supplied studio_id / practitioner_id on insert", () => {
    // studio_id and practitioner_id on the insert payload must come
    // from the server-resolved practitioner+studio, never from the
    // form. The form only supplies client_id (the route param) and
    // modality (the button identity) and the optional appointment_id.
    //
    // L18 Phase 3 sent NEITHER value: 0167's start_session derived the studio
    // itself. 0181 REVERSED HALF of that, and the reversal is the fix for a
    // production P1, 0167 derived the studio with an unordered `limit 1` over
    // every active membership, so a practitioner active in two studios could
    // render the page against the SELECTED studio and have the command run
    // against the other one ("Client not found in this studio.", HTTP 500).
    //
    // So p_studio_id IS now sent. The invariant this case actually protects is
    // unchanged and is asserted directly instead of by absence: the value comes
    // from the SERVER-RESOLVED studio, and no studio ever comes from the form.
    // The practitioner is still never sent, the command derives it from the
    // named studio's own membership row.
    const params = SOURCE.slice(
      SOURCE.indexOf('rpc("start_session"'),
      SOURCE.indexOf("});", SOURCE.indexOf('rpc("start_session"')),
    );
    expect(params).toMatch(/p_client_id: clientId/);
    expect(params).toMatch(/p_modality: modality/);
    // Server-resolved, and ONLY server-resolved.
    expect(params).toMatch(/p_studio_id: studio\.id/);
    expect(params).not.toMatch(/p_studio_id:\s*(formData|sp|searchParams|params)\b/);
    expect(params).not.toMatch(/practitioner/i);
    // `studio` exists in scope only because the action resolved it server-side.
    expect(SOURCE).toMatch(
      /const\s*\{[^}]*studio[^}]*\}\s*=\s*await\s+getCurrentPractitionerWithStudio\(\)/,
    );
    // …and the form still supplies nothing tenant-scoped.
    expect(SOURCE).not.toMatch(/formData\.get\(\s*["'`][^"'`]*studio/i);

    // The 0167 signature is FROZEN (applied migrations are never edited); the
    // studio-aware signature is introduced by 0181.
    const M0167 = readFileSync(
      "supabase/migrations/0167_session_write_commands.sql",
      "utf8",
    );
    const seg = M0167.slice(M0167.indexOf("function public.start_session("));
    expect(seg.slice(0, seg.indexOf(")"))).not.toMatch(/p_studio_id|p_practitioner_id/);

    const M0181 = readFileSync(
      "supabase/migrations/0181_multi_studio_command_authority.sql",
      "utf8",
    );
    expect(M0181).toMatch(/p_studio_id\s+uuid/);
    expect(M0181).not.toMatch(/p_practitioner_id/);
  });

  it("writes appointment_id on insert when validated, null otherwise", () => {
    // The variable `appointmentId` starts null and only becomes set
    // after lineage validation. The insert assigns appointment_id
    // from that variable.
    expect(SOURCE).toMatch(/let appointmentId:\s*string\s*\|\s*null\s*=\s*null/);
    expect(SOURCE).toMatch(/appointment_id:\s*appointmentId/);
  });

  it("on coalesce reuse, promotes null -> validated id (never overwrites a non-null link)", () => {
    // The coalesce window reuses a recent session row. If that row's
    // appointment_id is already set, we leave it; if it is null and
    // the new flow has a validated id, we stamp it. The update is
    // additionally guarded by .is("appointment_id", null) so the
    // promotion is atomic with respect to a concurrent write.
    // L18 Phase 3: the promotion moved INSIDE start_session, where it is
    // genuinely atomic, the coalesce lookup is taken FOR UPDATE, so the old
    // read-then-write window (two clicks could both miss and duplicate the
    // session) is closed rather than merely guarded.
    const MIGRATION = readFileSync(
      "supabase/migrations/0167_session_write_commands.sql",
      "utf8",
    );
    const seg = MIGRATION.slice(
      MIGRATION.indexOf("function public.start_session("),
    );
    const body = seg.slice(0, seg.indexOf("$$;"));
    expect(body).toMatch(/for update/);
    expect(body).toMatch(/if p_appointment_id is not null and v_existing_appt is null then/);
    expect(body).toMatch(/and s\.appointment_id is null/);
  });

  it("a non-fatal link-update failure does not break session creation", () => {
    // The session row itself is the canonical clinical artefact; the
    // FK pointer is a memory hint. A failure to stamp the pointer is
    // logged but never re-thrown to the practitioner.
    // The separate, fail-soft link update no longer exists: the promotion is
    // part of the same transaction as the reuse, so there is no partial state
    // to log around. A command failure is surfaced through the shared mapper
    // rather than swallowed.
    expect(SOURCE).not.toMatch(/session_appointment_link_update_failed/);
    expect(SOURCE).toMatch(/mapSessionCommandError\(startErr\)/);
  });
});

// ---------------------------------------------------------------------------
// New session page forwards ?appointment_id into the form, with a
// matching UUID guard so a malformed search-param falls through to the
// client-scoped (null) path without breaking the page render.
// ---------------------------------------------------------------------------

const PAGE_PATH = path.resolve(
  __dirname,
  "../../../../app/(app)/clients/[id]/sessions/new/page.tsx",
);
const PAGE_SOURCE = readFileSync(PAGE_PATH, "utf8");

describe("new-session page carries appointment_id from search params", () => {
  it("accepts an optional appointment_id search parameter", () => {
    expect(PAGE_SOURCE).toMatch(/appointment_id\?:\s*string/);
  });

  it("guards the search-param value with a UUID match", () => {
    expect(PAGE_SOURCE).toMatch(/UUID_RE/);
    expect(PAGE_SOURCE).toMatch(/UUID_RE\.test\(/);
  });

  it("renders a hidden appointment_id input on the modality forms", () => {
    expect(PAGE_SOURCE).toMatch(
      /<input[^>]*type="hidden"[^>]*name="appointment_id"[^>]*\/>/,
    );
  });

  it("does not render the hidden input when no appointment id is present", () => {
    // Conditional render: {appointmentId && <input ... />}
    expect(PAGE_SOURCE).toMatch(/\{appointmentId && \(/);
  });
});

// ---------------------------------------------------------------------------
// Two upstream surfaces forward ?appointment_id. Pin them so a future
// refactor does not silently drop the carrier and leave the FK stuck
// at null for new appointment-context flows.
// ---------------------------------------------------------------------------

describe("write-forward surfaces include ?appointment_id in the chart-session link", () => {
  it("client appointment timeline component passes appointment_id on the Chart session link", () => {
    // PR #157 moved the per-row Chart session link out of
    // app/(app)/clients/[id]/page.tsx into the new
    // <ClientAppointmentTimeline> server component. The original
    // assertion (which looked for `${client.id}` + `${appt.id}` on
    // the page) is replaced with the equivalent assertion on the
    // component file, where `${clientId}` is the prop name and
    // `${row.id}` is the appointment row's id.
    const text = readFileSync(
      path.resolve(
        __dirname,
        "../../../../components/client-appointment-timeline.tsx",
      ),
      "utf8",
    );
    expect(text).toMatch(
      /\/clients\/\$\{clientId\}\/sessions\/new\?appointment_id=\$\{encodeURIComponent\(row\.id\)\}/,
    );
  });

  it("appointment detail Chart session card links to /sessions/new with appointment_id", () => {
    const text = readFileSync(
      path.resolve(__dirname, "../../../../app/(app)/calendar/[id]/page.tsx"),
      "utf8",
    );
    expect(text).toMatch(
      /\/clients\/\$\{clientId\}\/sessions\/new\?appointment_id=\$\{[^}]*appointmentId[^}]*\}/,
    );
  });
});
