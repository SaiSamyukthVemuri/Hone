import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ISSUED_QUESTIONNAIRE } from "@/lib/intake/questionnaire";

// #1035 Codex P2 4354364701. A non-NULL snapshot the page cannot verify
// (questionnaireForRow -> kind "invalid", empty steps) already withholds the
// labelled answers and the Fitzpatrick summary behind the "could not be
// verified" disclosure. The derived review-flag card still applied the current
// hard-coded clinical rules to the stored response keys, so the page showed
// authorization / precaution guidance for answers whose meaning it had just
// said it could not verify.
//
// Behavioural: the real page renders against stubbed data sources. Client
// components are stubbed out; they are not under test here.

const h = vi.hoisted(() => ({
  intake: null as Record<string, unknown> | null,
}));

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("notFound"); },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ studio: { id: "studio-1" } }),
  getPractitionersForStudio: async () => [],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: { id: "client-1", name: "Synthetic Client", email: null }, error: null });
    return { from: () => q };
  },
}));
vi.mock("@/lib/intake/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intake/queries")>()),
  getIntakeHistoryForClient: async () => (h.intake ? [h.intake] : []),
  getIntakeById: async () => null,
}));
vi.mock("@/lib/consent/queries", () => ({
  getPortalPhotoConsentsForPractitionerView: async () => [],
}));
const Stub = () => null;
vi.mock("@/components/pending-link", () => ({ PendingLink: Stub }));
vi.mock("@/components/signed-consent-viewer", () => ({ SignedConsentViewer: Stub }));
vi.mock("@/components/intake-consent-record-viewer", () => ({ IntakeConsentRecordViewer: Stub }));
vi.mock("@/app/(app)/clients/[id]/intake/IntakeReviewForm", () => ({ IntakeReviewForm: Stub }));
vi.mock("@/app/(app)/clients/[id]/intake/IntakeReissueCard", () => ({ IntakeReissueCard: Stub }));
vi.mock("@/app/(app)/clients/[id]/intake/IntakeResendCard", () => ({ IntakeResendCard: Stub }));
vi.mock("@/app/(app)/clients/[id]/intake/IntakeHistoryList", () => ({ IntakeHistoryList: Stub }));

const { default: ClientIntakePage } = await import("@/app/(app)/clients/[id]/intake/page");

// Answers that raise an authorization-level flag under the current rules.
const FLAGGING_RESPONSES = { medical_conditions: ["pacemaker"] };
const FLAG_CARD = "Intake review needed";
const UNVERIFIED = "The original questionnaire could not be verified.";

function intakeRow(questionnaire_snapshot: unknown) {
  return {
    id: "intake-1",
    client_id: "client-1",
    status: "submitted",
    started_at: "2026-10-01T10:00:00Z",
    submitted_at: "2026-10-01T10:30:00Z",
    reviewed_at: null,
    reviewed_by: null,
    practitioner_notes: null,
    requested_at: null,
    requested_by: null,
    responses: FLAGGING_RESPONSES,
    questionnaire_snapshot,
  };
}

async function render(snapshot: unknown): Promise<string> {
  h.intake = intakeRow(snapshot);
  const element = await ClientIntakePage({
    params: Promise.resolve({ id: "client-1" }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  h.intake = null;
});

describe("P2 4354364701: an unverifiable questionnaire derives no review flags", () => {
  it.each([
    ["a forged object", { forged: true }],
    ["an unsupported version", { ...structuredClone(ISSUED_QUESTIONNAIRE), version: "999" }],
    ["a string", "not-a-snapshot"],
    ["an empty object", {}],
  ])("%s: no flag card, and the disclosure stays", async (_label, snapshot) => {
    const html = await render(snapshot);
    expect(html).toContain(UNVERIFIED);
    expect(html).not.toContain(FLAG_CARD);
  });
});

describe("CONTROLS: verifiable rows keep their flags", () => {
  it("a known (issued) snapshot shows the flag card", async () => {
    const html = await render(structuredClone(ISSUED_QUESTIONNAIRE));
    expect(html).toContain(FLAG_CARD);
    expect(html).not.toContain(UNVERIFIED);
  });

  it("a legacy (NULL) snapshot shows the flag card", async () => {
    const html = await render(null);
    expect(html).toContain(FLAG_CARD);
    expect(html).not.toContain(UNVERIFIED);
  });
});
