import { MarketingHeader } from "@/app/_components/MarketingHeader";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { verifyIntakeToken } from "@/lib/intake/tokens";
import { IntakeWizard } from "./IntakeWizard";

type LoadResult =
  | {
      ok: true;
      token: string;
      studioName: string;
      initialStep: number;
      initialResponses: Record<string, unknown>;
      alreadySubmitted: boolean;
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
  const { data, error } = await admin
    .from("client_intake_forms")
    .select("id, status, current_step, responses, studio:studios(name)")
    .eq("id", v.intake_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Intake not found." };

  type Joined = {
    id: string;
    status: string;
    current_step: number;
    responses: Record<string, unknown> | null;
    studio: { name: string } | { name: string }[] | null;
  };
  const row = data as unknown as Joined;
  const studio = Array.isArray(row.studio) ? row.studio[0] : row.studio;

  return {
    ok: true,
    token,
    studioName: studio?.name ?? "your studio",
    initialStep: row.current_step,
    initialResponses: row.responses ?? {},
    alreadySubmitted: row.status === "submitted" || row.status === "reviewed",
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
      <MarketingHeader />
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
                  This takes about 5 minutes. Your electrologist will review it
                  before your session. Your answers are kept confidential.
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
