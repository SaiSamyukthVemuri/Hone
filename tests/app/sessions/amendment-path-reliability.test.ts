import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// Amendment-path reliability (amend/correct server actions + UI).
//
// Context: the Phase-2 amend UI could fail with NO server-side trace, so the
// exact failure boundary (PostgREST call, action guard, payload shape, or UI
// handling) was unknowable. This suite exercises the REAL action path — the
// same `supabase.rpc(fn, {named args})` invocation the browser triggers — with
// the DB + queries + revalidate + ops-alert mocked, and pins the diagnostics,
// the discriminated result contract, PHI-safety, and the prominent error /
// explicit success UI. It is the unit/behavioral half; tests/db/
// clinical-amend-named-args.db.test.ts proves the named-arg payload resolves
// through PostgREST's named-call notation, and e2e/clinical-amendment.spec.ts
// drives the browser.
// ===========================================================================

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { revalidatePath } from "next/cache";
import { recordOpsAlert } from "@/lib/ops/alerts";
import {
  amendSessionAction,
  correctSessionAction,
} from "@/app/(app)/clients/[id]/sessions/[sessionId]/correction-actions";

const STUDIO = "11111111-1111-1111-1111-111111111111";
const SESSION = "44444444-4444-4444-4444-444444444444";
const CLIENT = "55555555-5555-5555-5555-555555555555";
const SNAPSHOT = "66666666-6666-6666-6666-666666666666";
const AMEND_ID = "77777777-7777-7777-7777-777777777777";
const NEW_SNAP = "88888888-8888-8888-8888-888888888888";
const HASH = "a".repeat(64);
// Recognisable clinical strings — these must NEVER appear in a log or alert.
const REASON = "Forgot to record the post-care advice given at checkout";
const BODY = "Advised client to avoid sun exposure and apply aloe for 48 hours";
const PAYLOAD_VALUE = "corrected free-text clinical note value";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A chainable Supabase client mock: `.rpc(name, args)` records the call and
// resolves a caller-supplied result; `.from(...).select(...).eq(...)` resolves
// the persistence-verify count.
function makeClient(opts: {
  rpc?: { data: unknown; error: unknown } | (() => never);
  verify?: { count: number | null; error: unknown };
}) {
  const rpc = vi.fn(async (..._a: unknown[]) => {
    if (typeof opts.rpc === "function") return opts.rpc();
    return opts.rpc ?? { data: null, error: null };
  });
  const eq = vi.fn(async () => opts.verify ?? { count: 1, error: null });
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { rpc, eq, select, from, client: { rpc, from } };
}

function setPractitioner(over: { active?: boolean; flag?: boolean } = {}) {
  vi.mocked(getCurrentPractitionerWithStudio).mockResolvedValue({
    practitioner: { active: over.active ?? true },
    studio: { id: STUDIO, clinical_corrections_enabled: over.flag ?? true },
  } as never);
}

function amendForm(over: Record<string, string | null> = {}) {
  const fd = new FormData();
  fd.set("session_id", SESSION);
  fd.set("client_id", CLIENT);
  fd.set("applies_to_snapshot_id", SNAPSHOT);
  fd.set("amendment_type", "late_note");
  fd.set("reason", REASON);
  fd.set("body", BODY);
  for (const [k, v] of Object.entries(over)) {
    if (v === null) fd.delete(k);
    else fd.set(k, v);
  }
  return fd;
}

function correctForm(over: Record<string, string | null> = {}) {
  const fd = new FormData();
  fd.set("session_id", SESSION);
  fd.set("client_id", CLIENT);
  fd.set("expected_record_version", "3");
  fd.set("reason", REASON);
  fd.set("payload", JSON.stringify({ session: { session_notes: PAYLOAD_VALUE } }));
  for (const [k, v] of Object.entries(over)) {
    if (v === null) fd.delete(k);
    else fd.set(k, v);
  }
  return fd;
}

let logSpy: ReturnType<typeof vi.spyOn>;
function loggedText(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  setPractitioner();
  const happy = makeClient({
    rpc: { data: [{ amendment_id: AMEND_ID, content_hash: HASH }], error: null },
  });
  vi.mocked(createClient).mockResolvedValue(happy.client as never);
  vi.mocked(recordOpsAlert).mockResolvedValue(undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
describe("amendSessionAction — PostgREST invocation shape", () => {
  it("calls amend_finalized_session with the EXACT named-arg payload incl p_structured_addition:null", async () => {
    const c = makeClient({
      rpc: { data: [{ amendment_id: AMEND_ID, content_hash: HASH }], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await amendSessionAction(amendForm());

    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith("amend_finalized_session", {
      p_session_id: SESSION,
      p_applies_to_snapshot_id: SNAPSHOT,
      p_amendment_type: "late_note",
      p_reason: REASON,
      p_body: BODY,
      p_structured_addition: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.amendmentId).toBe(AMEND_ID);
      expect(r.requestId).toMatch(UUID_RE);
    }
  });

  it("verifies the row persisted, then revalidates — success is not claimed on RPC-resolve alone", async () => {
    const c = makeClient({
      rpc: { data: [{ amendment_id: AMEND_ID, content_hash: HASH }], error: null },
      verify: { count: 1, error: null },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await amendSessionAction(amendForm());

    expect(c.from).toHaveBeenCalledWith("clinical_record_amendments");
    expect(c.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(c.eq).toHaveBeenCalledWith("id", AMEND_ID);
    expect(revalidatePath).toHaveBeenCalledWith(
      `/clients/${CLIENT}/sessions/${SESSION}`,
    );
    expect(r.ok).toBe(true);
  });
});

describe("amendSessionAction — failure contract (always {ok:false, errorType, requestId})", () => {
  it("RPC ok but row NOT found after insert → inconsistent, no revalidate, ops-alert raised", async () => {
    const c = makeClient({
      rpc: { data: [{ amendment_id: AMEND_ID, content_hash: HASH }], error: null },
      verify: { count: 0, error: null },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await amendSessionAction(amendForm());

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorType).toBe("inconsistent");
      expect(r.requestId).toMatch(UUID_RE);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("a business raise (23514) is shown verbatim to the practitioner, WITHOUT an ops-alert", async () => {
    const c = makeClient({
      rpc: { data: null, error: { code: "23514", message: "Session is not finalized." } },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await amendSessionAction(amendForm());

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("Session is not finalized.");
      expect(r.errorType).toBe("rpc_error");
    }
    expect(recordOpsAlert).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a non-business RPC error → generic message + ops-alert, never leaks the driver text", async () => {
    const c = makeClient({
      rpc: {
        data: null,
        error: { code: "42883", message: "function amend_finalized_session(...) does not exist SECRET" },
      },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await amendSessionAction(amendForm());

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/couldn't be saved/i);
      expect(r.error).not.toMatch(/SECRET/);
      expect(r.errorType).toBe("rpc_error");
      expect(r.requestId).toMatch(UUID_RE);
    }
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("an unexpected throw returns a failure (never throws) + ops-alert, no raw error leaked", async () => {
    const c = makeClient({
      rpc: () => {
        throw new Error("boom BExplode internals");
      },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await amendSessionAction(amendForm());

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorType).toBe("unexpected");
      expect(r.error).toBe("Something went wrong. Nothing was saved.");
      expect(r.error).not.toMatch(/BExplode/);
    }
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("authorization-lookup failure → auth failure + ops-alert, RPC never attempted", async () => {
    vi.mocked(getCurrentPractitionerWithStudio).mockRejectedValue(
      new Error("membership lookup down"),
    );
    const c = makeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await amendSessionAction(amendForm());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorType).toBe("auth");
    expect(c.rpc).not.toHaveBeenCalled();
    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("flag OFF → flag_off, no RPC, no ops-alert (ordinary gate, not an incident)", async () => {
    setPractitioner({ flag: false });
    const c = makeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await amendSessionAction(amendForm());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorType).toBe("flag_off");
    expect(c.rpc).not.toHaveBeenCalled();
    expect(recordOpsAlert).not.toHaveBeenCalled();
  });

  it("inactive practitioner → auth, no RPC", async () => {
    setPractitioner({ active: false });
    const c = makeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await amendSessionAction(amendForm());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorType).toBe("auth");
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("validation failures short-circuit before any RPC and never alert", async () => {
    const c = makeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    for (const over of [
      { reason: "   " },
      { body: "   " },
      { session_id: null },
      { amendment_type: null },
      { applies_to_snapshot_id: null },
    ] as Record<string, string | null>[]) {
      const r = await amendSessionAction(amendForm(over));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errorType).toBe("validation");
        expect(r.requestId).toMatch(UUID_RE);
      }
    }
    expect(c.rpc).not.toHaveBeenCalled();
    expect(recordOpsAlert).not.toHaveBeenCalled();
  });
});

describe("amendSessionAction — PHI safety", () => {
  it("never writes the reason, body, raw session id, or raw amendment id to the log", async () => {
    const c = makeClient({
      rpc: { data: [{ amendment_id: AMEND_ID, content_hash: HASH }], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    await amendSessionAction(amendForm());
    const logs = loggedText();

    expect(logs).not.toContain(REASON);
    expect(logs).not.toContain(BODY);
    expect(logs).not.toContain(SESSION);
    expect(logs).not.toContain(AMEND_ID);
    // But it MUST be observable: a correlation id + staged progress is logged.
    expect(logs).toMatch(/"event":"clinical_action"/);
    expect(logs).toMatch(/"stage":"rpc_requested"/);
    expect(logs).toMatch(/"stage":"persistence_verified"/);
  });

  it("never passes clinical text to an ops-alert on a non-business RPC failure", async () => {
    const c = makeClient({
      rpc: { data: null, error: { code: "40001", message: "serialization failure" } },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    await amendSessionAction(amendForm());

    expect(recordOpsAlert).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(recordOpsAlert).mock.calls[0][0];
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain(REASON);
    expect(serialized).not.toContain(BODY);
    expect(serialized).not.toContain(SESSION);
  });
});

// ---------------------------------------------------------------------------
describe("correctSessionAction — PostgREST invocation shape + contract", () => {
  it("calls correct_finalized_session with a numeric version + parsed payload object", async () => {
    const c = makeClient({
      rpc: {
        data: [{ snapshot_id: NEW_SNAP, new_version: 4, content_hash: HASH }],
        error: null,
      },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await correctSessionAction(correctForm());

    expect(c.rpc).toHaveBeenCalledWith("correct_finalized_session", {
      p_session_id: SESSION,
      p_expected_record_version: 3,
      p_reason: REASON,
      p_payload: { session: { session_notes: PAYLOAD_VALUE } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshotId).toBe(NEW_SNAP);
      expect(r.newVersion).toBe(4);
      expect(r.requestId).toMatch(UUID_RE);
    }
    // Both the session detail AND the client page are revalidated.
    expect(revalidatePath).toHaveBeenCalledWith(
      `/clients/${CLIENT}/sessions/${SESSION}`,
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/clients/${CLIENT}`);
  });

  it("invalid payload JSON → validation error, no RPC, no alert", async () => {
    const c = makeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await correctSessionAction(correctForm({ payload: "{not json" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorType).toBe("validation");
    expect(c.rpc).not.toHaveBeenCalled();
    expect(recordOpsAlert).not.toHaveBeenCalled();
  });

  it("missing concurrency token → validation error", async () => {
    const c = makeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(c.client as never);
    const r = await correctSessionAction(correctForm({ expected_record_version: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorType).toBe("validation");
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("a business raise (23514) is shown verbatim without an ops-alert", async () => {
    const c = makeClient({
      rpc: {
        data: null,
        error: { code: "23514", message: "Record was modified by someone else. Reload and retry." },
      },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    const r = await correctSessionAction(correctForm());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("Record was modified by someone else. Reload and retry.");
      expect(r.errorType).toBe("rpc_error");
    }
    expect(recordOpsAlert).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never writes the correction payload value to the log", async () => {
    const c = makeClient({
      rpc: {
        data: [{ snapshot_id: NEW_SNAP, new_version: 4, content_hash: HASH }],
        error: null,
      },
    });
    vi.mocked(createClient).mockResolvedValue(c.client as never);

    await correctSessionAction(correctForm());
    const logs = loggedText();
    expect(logs).not.toContain(PAYLOAD_VALUE);
    expect(logs).not.toContain(REASON);
    expect(logs).not.toContain(SESSION);
  });
});

// ===========================================================================
// Source pins — the action file's PHI-safety + contract anchors, and the UI's
// prominent error / explicit success behavior. The Vitest env is "node" (no
// jsdom / RTL), so component behavior is pinned as source invariants; the live
// interaction is covered by e2e/clinical-amendment.spec.ts.
// ===========================================================================
const ROOT = process.cwd();
const ACTION = readFileSync(
  join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/correction-actions.ts"),
  "utf8",
);
const PANEL = readFileSync(
  join(ROOT, "app/(app)/clients/[id]/sessions/[sessionId]/RecordVersionsPanel.tsx"),
  "utf8",
);

describe("correction-actions.ts — diagnostics + PHI-safe contract (source)", () => {
  it("declares the discriminated result unions carrying requestId + errorType", () => {
    expect(ACTION).toMatch(/export type AmendResult/);
    expect(ACTION).toMatch(/export type CorrectResult/);
    expect(ACTION).toMatch(/requestId: string/);
    expect(ACTION).toMatch(/errorType: ClinicalActionErrorType/);
  });

  it("sends p_structured_addition: null on the amend RPC", () => {
    expect(ACTION).toMatch(/p_structured_addition:\s*null/);
  });

  it("logs the raw id only via a one-way hash suffix (never the raw id)", () => {
    expect(ACTION).toMatch(/idSuffix\(/);
    expect(ACTION).toMatch(/createHash\("sha256"\)/);
  });

  it("ops-alert safeDetails never carry the reason, body, or payload", () => {
    const alertBlocks = ACTION.match(/recordOpsAlert\(\{[\s\S]*?\}\)/g) ?? [];
    expect(alertBlocks.length).toBeGreaterThan(0);
    for (const block of alertBlocks) {
      expect(block).not.toMatch(/\breason\b\s*:/);
      expect(block).not.toMatch(/\bbody\b\s*:/);
      expect(block).not.toMatch(/\bpayload\b\s*:/);
    }
  });

  it("only alerts on infrastructure errors, not on business raises (23514)", () => {
    expect(ACTION).toMatch(/isBusinessRaise\(/);
    expect(ACTION).toMatch(/if \(!business\)/);
  });
});

describe("RecordVersionsPanel.tsx — prominent error + explicit success (source)", () => {
  it("has a high-contrast, accessible error panel that says nothing was saved + a reference id", () => {
    expect(PANEL).toMatch(/function FormErrorPanel/);
    expect(PANEL).toMatch(/role="alert"/);
    expect(PANEL).toMatch(/tabIndex=\{-1\}/);
    expect(PANEL).toMatch(/Nothing was saved\./);
    expect(PANEL).toMatch(/Reference:\s*\{failure\.requestId\}/);
  });

  it("moves focus to the error panel on failure (impossible to miss)", () => {
    expect(PANEL).toMatch(/requestAnimationFrame\(\(\)\s*=>\s*errorRef\.current\?\.focus\(\)\)/);
  });

  it("AmendForm reports success only after the server action confirms it", () => {
    // The success flag + panel exist and the panel invocation refreshes history.
    expect(PANEL).toMatch(/setSuccess\(true\)/);
    expect(PANEL).toMatch(/role="status"/);
    expect(PANEL).toMatch(/Later information added\./);
    expect(PANEL).toMatch(/onSaved=\{\(\)\s*=>\s*router\.refresh\(\)\}/);
  });

  it("on failure it keeps the fields and clears them ONLY on success", () => {
    // In AmendForm.submit, the !r.ok branch calls fail(...) and returns BEFORE
    // any setReason("")/setBody(""); the clears live in the success branch.
    const amend = PANEL.slice(
      PANEL.indexOf("const r = await amendSessionAction(fd)"),
    );
    const failIdx = amend.indexOf("fail({ message: r.error");
    const clearIdx = amend.indexOf('setReason("")');
    expect(failIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(failIdx); // clears happen after the fail-return
  });

  it("prevents duplicate submits (button disabled while the transition is pending)", () => {
    const disables = PANEL.match(/disabled=\{pending \|\|/g) ?? [];
    expect(disables.length).toBeGreaterThanOrEqual(2); // amend + correct
    expect(PANEL).toMatch(/pending \? "Adding…" : "Add amendment"/);
  });

  it("CorrectForm uses the same prominent, correlatable error panel", () => {
    // Two FormErrorPanel usages (amend + correct), both fed a Failure carrying
    // the requestId; no legacy inline single-line red error remains.
    const panels = PANEL.match(/<FormErrorPanel /g) ?? [];
    expect(panels.length).toBe(2);
    expect(PANEL).toMatch(/fail\(\{ message: r\.error, requestId: r\.requestId \}\)/);
    expect(PANEL).not.toMatch(/text-xs text-red-700/);
  });
});
