import { INTAKE_STEPS, type Question } from "@/lib/intake/questions";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { PostcareSettingsForm } from "../studio/PostcareSettingsForm";
import { PolicySettingsForm } from "../studio/PolicySettingsForm";

// Intake & Postcare settings page. Two surfaces:
//
//   1. Read-only preview of the current health intake form (the same
//      INTAKE_STEPS the public wizard and the practitioner intake
//      review consume). No `<form>`, no server action, no DB read.
//      Inputs are disabled as a secondary defense; the primary
//      guarantee is the absence of mutation primitives.
//
//   2. Owner-only Postcare email content editor. Previously lived
//      under Settings → Studio; moved here so postcare content sits
//      next to the intake form (Chloe expected to find it near the
//      forms area, not under Studio). The form component itself is
//      reused unchanged; no data, schema, action, send, or template
//      behaviour was modified by this move.
//
// Conditional questions are shown in line with their step, annotated
// with a "Shown when ..." caption resolved from the parent question's
// label + the value-set the conditional fires on. This keeps the
// preview faithful to what a real intake feels like while making the
// branching legible at a glance.
//
// Render mode: dynamic (default). The route lives inside the
// authenticated (app)/settings layout, which loads the current
// practitioner via cookies on every request. The prior `force-static`
// directive was removed in PR #90 because it caused Next.js to
// pre-render the route at build time and bake a redirect to /login
// into the static output.
export const metadata = { title: "Forms & Policies" };

export default async function IntakeAndPostcarePage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const isOwner = practitioner.role === "owner";

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-medium">Intake form preview</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          This is the current health intake form. Inspect each step end
          to end without creating a test client.
        </p>
      </div>

      {/* Standing banner. Makes it unambiguous that this page is read
          only: tapping any input does nothing, the form has no submit
          action, no client record is created, and no real intake row
          is written. The banner also tells the practitioner what they
          would do to actually send an intake (open a client and use
          "Request intake update" there), so the absence of a primary
          action does not feel broken. */}
      <div
        role="status"
        className="flex flex-col gap-1 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-700/50 dark:bg-blue-950/30 dark:text-blue-100"
      >
        <p className="font-medium">
          Preview mode. No client record will be created.
        </p>
        <p className="text-xs">
          This view shows exactly what a client sees when they open a
          booking confirmation or an intake update link. To actually
          send an intake to a client, open that client and use
          &ldquo;Request intake update&rdquo; on their profile.
        </p>
      </div>
      {/* Collapsible by intake step via native <details>/<summary>.
          Step 1 (Personal information) is open by default because it
          carries the fields a practitioner spot-checks most often
          (DOB, contact, address). Steps 2-5 collapse so the page
          stays short on mobile; the practitioner clicks a header to
          inspect a clinical / skin / Fitzpatrick section.
          Native <details> is keyboard-accessible (Space/Enter) and
          announced as a disclosure region by screen readers without
          any client-side JS. We deliberately do NOT wire expand-all
          / collapse-all controls in v1: those would require a small
          client component holding refs to every <details> element,
          and one native disclosure click per step is the same cost
          as one button + state update.
          Submit / form action / DB write / token generation surfaces
          remain absent from this page (same guarantees as before). */}
      <ol className="flex flex-col gap-4">
        {INTAKE_STEPS.map((step, idx) => {
          const requiredCount = step.questions.filter(
            (q) => q.required === true,
          ).length;
          return (
            <li key={step.id}>
              <details
                open={idx === 0}
                className="group rounded-lg border border-neutral-200 dark:border-neutral-800"
              >
                <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                      Step {step.id} of {INTAKE_STEPS.length} &middot;{" "}
                      {step.shortLabel}
                    </span>
                    <h3 className="text-base font-medium tracking-tight">
                      {step.title}
                    </h3>
                    <span className="text-xs text-neutral-500">
                      {step.questions.length}{" "}
                      {step.questions.length === 1 ? "question" : "questions"}
                      {requiredCount > 0 && (
                        <>
                          {" "}
                          &middot; {requiredCount} required
                        </>
                      )}
                    </span>
                  </div>
                  <span
                    aria-hidden
                    className="mt-1 select-none text-neutral-500 transition-transform group-open:rotate-180"
                  >
                    ▾
                  </span>
                </summary>
                <div className="border-t border-neutral-200 px-5 pb-5 pt-4 dark:border-neutral-800">
                  {step.description && (
                    <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
                      {step.description}
                    </p>
                  )}
                  <ul className="flex flex-col gap-5">
                    {step.questions.map((q) => (
                      <li key={q.key}>
                        <QuestionPreview
                          q={q}
                          stepQuestions={step.questions}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      {isOwner && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="border-t border-neutral-200 dark:border-neutral-800" />
          <div className="flex flex-col gap-2">
            <h2 id="postcare" className="scroll-mt-24 text-xl font-medium">
              Postcare email content
            </h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Used by the manual <em>Send postcare</em> button on an
              appointment. You write the clinical content; Hone never
              invents medical advice. Send is always manual; no
              auto-send. Postcare data lives on the studio record and
              is unchanged by moving this editor here.
            </p>
          </div>
          <PostcareSettingsForm
            initial={{
              postcare_aftercare_text: studio.postcare_aftercare_text ?? "",
              postcare_warning_signs_text:
                studio.postcare_warning_signs_text ?? "",
              postcare_product_recommendations_text:
                studio.postcare_product_recommendations_text ?? "",
              postcare_review_url: studio.postcare_review_url ?? "",
              postcare_review_prompt_text:
                studio.postcare_review_prompt_text ?? "",
              postcare_contact_email: studio.postcare_contact_email ?? "",
            }}
            studioOwnerEmail={studio.owner_email}
          />

          <div className="border-t border-neutral-200 dark:border-neutral-800" />

          <PolicySettingsForm
            initial={{
              cancellation_policy_text: studio.cancellation_policy_text ?? "",
              no_show_policy_text: studio.no_show_policy_text ?? "",
              policy_version: studio.policy_version,
              policy_updated_at: studio.policy_updated_at,
            }}
          />
        </div>
      )}
    </section>
  );
}

function QuestionPreview({
  q,
  stepQuestions,
}: {
  q: Question;
  stepQuestions: ReadonlyArray<Question>;
}) {
  const conditional = q.conditional
    ? formatConditional(q.conditional, stepQuestions)
    : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <label className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {q.label}
          {q.required && <span className="ml-1 text-red-600">*</span>}
        </label>
        {q.helpText && (
          <span className="text-xs text-neutral-500">{q.helpText}</span>
        )}
        {conditional && (
          <span className="text-xs italic text-neutral-500">{conditional}</span>
        )}
      </div>
      <Control q={q} />
      {q.followUpNotesPrompt && (
        <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-900">
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            {q.followUpNotesPrompt}
          </span>
          <textarea
            aria-label={q.followUpNotesPrompt}
            disabled
            rows={2}
            placeholder="Client follow-up notes"
            className="min-h-[44px] w-full cursor-not-allowed rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950"
          />
        </div>
      )}
    </div>
  );
}

// Renders a static, non-interactive version of each question type.
// No <form>, no onChange handlers, all native inputs disabled. The
// component is a Server Component; no React state is created.
function Control({ q }: { q: Question }) {
  const baseDisabled =
    "cursor-not-allowed rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900";

  if (q.type === "short_text") {
    return (
      <input
        type="text"
        disabled
        placeholder="Client answer"
        aria-label={q.label}
        className={`min-h-[44px] w-full ${baseDisabled}`}
      />
    );
  }
  if (q.type === "long_text") {
    return (
      <textarea
        disabled
        rows={3}
        placeholder="Client answer"
        aria-label={q.label}
        className={`min-h-[44px] w-full ${baseDisabled}`}
      />
    );
  }
  if (q.type === "date") {
    return (
      <input
        type="date"
        disabled
        aria-label={q.label}
        className={`min-h-[44px] w-full ${baseDisabled}`}
      />
    );
  }
  if (q.type === "yes_no") {
    return (
      <div className="flex gap-2">
        {[
          { v: "yes", label: "Yes" },
          { v: "no", label: "No" },
        ].map((opt) => (
          <span
            key={opt.v}
            className="min-h-[44px] flex-1 cursor-not-allowed rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2 text-center text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900"
          >
            {opt.label}
          </span>
        ))}
      </div>
    );
  }
  if (q.type === "single_select") {
    return (
      <div className="flex flex-col gap-2">
        {(q.options ?? []).map((opt) => (
          <span
            key={opt.value}
            className="min-h-[44px] cursor-not-allowed rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900"
          >
            {opt.label}
          </span>
        ))}
      </div>
    );
  }
  if (q.type === "multi_select") {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(q.options ?? []).map((opt) => (
          <span
            key={opt.value}
            className="min-h-[44px] cursor-not-allowed rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900"
          >
            {opt.label}
          </span>
        ))}
      </div>
    );
  }
  if (q.type === "checkbox") {
    return (
      <span className="flex items-start gap-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900">
        <input
          type="checkbox"
          disabled
          aria-label={q.label}
          className="mt-0.5 h-5 w-5 cursor-not-allowed rounded border-neutral-300"
        />
        <span>{q.label}</span>
      </span>
    );
  }
  return null;
}

// Build a human-readable "Shown when ..." caption from a conditional
// rule by looking up the parent question's label and translating each
// allowed value to its option label (or "Yes"/"No" for yes_no). Pure
// function over the step's question list; no I/O.
function formatConditional(
  rule: { whenKey: string; whenEquals: ReadonlyArray<string> },
  stepQuestions: ReadonlyArray<Question>,
): string {
  const parent = stepQuestions.find((qq) => qq.key === rule.whenKey);
  const parentLabel = parent ? parent.label : rule.whenKey;
  const valueLabels = rule.whenEquals.map((v) => {
    if (parent?.type === "yes_no") {
      return v === "yes" ? "Yes" : v === "no" ? "No" : v;
    }
    const opt = parent?.options?.find((o) => o.value === v);
    return opt?.label ?? v;
  });
  const joined =
    valueLabels.length <= 1
      ? valueLabels.join("")
      : valueLabels.length === 2
        ? valueLabels.join(" or ")
        : `${valueLabels.slice(0, -1).join(", ")}, or ${valueLabels[valueLabels.length - 1]}`;
  return `Shown when "${parentLabel}" is ${joined}.`;
}
