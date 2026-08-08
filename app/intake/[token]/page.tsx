import type { Metadata } from "next";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyIntakeToken } from "@/lib/intake/tokens";
import { getIntakeConsentFormsForRender } from "@/lib/intake/consent-gate";
import { IntakeWizard } from "./IntakeWizard";
import type { RenderedConsentForm } from "./IntakeConsentForms";

// PR #142. Token-bearing route. See
// app/portal/verify/[token]/page.tsx for the full rationale.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

type LoadResult =
  | {
      ok: true;
      token: string;
      studioName: string;
      initialStep: number;
      initialResponses: Record<string, unknown>;
      alreadySubmitted: boolean;
      consentForms: RenderedConsentForm[];
    }
  | { ok: false; error: string };

async function loadIntake(token: string): Promise<LoadResult> {
  const v = verifyIntakeToken(token);
  if (!v.ok) {
    return {
      ok: false,
      error:
        v.error === "expired"
          ? "This intake link has expired. Contact the studio for a new one."
          : "This intake link is no longer valid.",
    };
  }
  const admin = createAdminClient();

  // P0-4: deliberately do NOT include `responses` in the initial
  // SELECT. We do a two-step fetch: first determine the intake
  // status, then only load responses when status is 'in_progress'.
  // A submitted/reviewed intake's saved answers must never leave the
  // server to the client, regardless of whether the same token is
  // still cryptographically valid.
  const { data: header, error: headerErr } = await admin
    .from("client_intake_forms")
    .select("id, status, current_step, studio_id, client_id, studio:studios(name)")
    .eq("id", v.intake_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (headerErr) {
    console.error(
      JSON.stringify({
        event: "intake_load_header_error",
        code: headerErr.code,
        message: headerErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "This intake link is no longer valid." };
  }
  if (!header) return { ok: false, error: "This intake link is no longer valid." };

  type JoinedHeader = {
    id: string;
    status: string;
    current_step: number;
    studio_id: string;
    client_id: string;
    studio: { name: string } | { name: string }[] | null;
  };
  const headerRow = header as unknown as JoinedHeader;
  const studio = Array.isArray(headerRow.studio) ? headerRow.studio[0] : headerRow.studio;

  const alreadySubmitted =
    headerRow.status === "submitted" || headerRow.status === "reviewed";

  // ONLY load saved responses for in_progress intake. For submitted /
  // reviewed forms we serve the completion acknowledgement and pass an
  // empty initialResponses payload; the client component branches on
  // alreadySubmitted=true and does not render the questionnaire.
  let initialResponses: Record<string, unknown> = {};
  if (!alreadySubmitted) {
    const { data: row, error: respErr } = await admin
      .from("client_intake_forms")
      .select("responses")
      .eq("id", v.intake_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (respErr) {
      console.error(
        JSON.stringify({
          event: "intake_load_responses_error",
          code: respErr.code,
          message: respErr.message,
          timestamp: new Date().toISOString(),
        }),
      );
      return { ok: false, error: "This intake link is no longer valid." };
    }
    initialResponses = (row?.responses as Record<string, unknown> | null) ?? {};
  }

  // The studio's live treatment/photo consent forms, resolved server-side
  // from the intake's OWN studio_id. The browser never names a studio, so a
  // token can only ever surface its own studio's forms. Not loaded for a
  // submitted/reviewed intake: that surface renders no wizard at all.
  const consentForms: RenderedConsentForm[] = alreadySubmitted
    ? []
    : await getIntakeConsentFormsForRender(
        headerRow.studio_id,
        // client_id comes from the intake row the verified token addresses,
        // never from the request, so an existing portal completion can only
        // ever be credited to the client this intake actually belongs to.
        headerRow.client_id,
      );

  return {
    ok: true,
    token,
    studioName: studio?.name ?? "your studio",
    initialStep: headerRow.current_step,
    initialResponses,
    alreadySubmitted,
    consentForms,
  };
}

export default async function IntakePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await loadIntake(token);

  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <section className="px-6 py-12 md:px-12 md:py-20 lg:px-16">
        <div className="mx-auto flex max-w-[640px] flex-col gap-10">
          <div>
            <EyebrowCaption>Health intake</EyebrowCaption>
            {result.ok ? (
              <>
                <h1
                  className="font-[var(--font-fraunces)] mt-6 text-[32px] font-bold leading-tight md:text-[44px]"
                  style={{ letterSpacing: "-0.025em" }}
                >
                  Before your appointment at {result.studioName}
                </h1>
                <p className="mt-4 text-[15px] leading-relaxed text-[#6B6B6B]">
                  This takes about 7 to 10 minutes. Your electrologist will
                  review it before your session. Your answers are kept
                  confidential.
                </p>
              </>
            ) : (
              <h1
                className="font-[var(--font-fraunces)] mt-6 text-[32px] font-bold leading-tight md:text-[40px]"
                style={{ letterSpacing: "-0.025em" }}
              >
                Intake link unavailable.
              </h1>
            )}
          </div>
          {result.ok ? (
            <IntakeWizard
              token={result.token}
              studioName={result.studioName}
              initialStep={result.initialStep}
              initialResponses={result.initialResponses}
              alreadySubmitted={result.alreadySubmitted}
              consentForms={result.consentForms}
            />
          ) : (
            <p className="text-[16px] text-[#0A0A0A]">{result.error}</p>
          )}
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
