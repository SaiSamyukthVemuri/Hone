import { createClient } from "@/lib/supabase/server";
import {
  staffWelcomeKey,
  staffWelcomeSteps,
  type StaffRole,
} from "@/lib/onboarding/staff-welcome";
import { StaffWelcomeDone } from "./staff-welcome-done";

type StaffWelcomeProps = {
  role: StaffRole;
  membershipId: string;
  booking?: boolean;
};

export function StaffWelcome(props: StaffWelcomeProps) {
  if (process.env.HONE_STAFF_ONBOARDING_ENABLED !== "true") return null;
  return <StaffWelcomeContent {...props} />;
}

async function StaffWelcomeContent({ role, membershipId, booking = false }: StaffWelcomeProps) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (
    !user ||
    user.user_metadata?.[staffWelcomeKey(role, membershipId)] === true
  )
    return null;
  return (
    <section
      aria-labelledby="staff-welcome"
      className="space-y-3 rounded-xl border border-line p-5 lg:col-span-2"
    >
      <h2 id="staff-welcome" className="text-lg font-semibold">
        {role === "receptionist"
          ? "Welcome to the front desk"
          : "Welcome to your practitioner workspace"}
      </h2>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {staffWelcomeSteps(role, booking).map((step) => (
          <li key={step.text}>
            {step.text}{" "}
            {step.href && (
              <a className="underline" href={step.href}>
                {step.link}
              </a>
            )}
          </li>
        ))}
      </ol>
      <StaffWelcomeDone role={role} membershipId={membershipId} />
    </section>
  );
}
