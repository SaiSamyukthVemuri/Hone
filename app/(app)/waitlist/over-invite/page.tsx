import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import SettingsRoute from "@/app/(app)/settings/waitlist/over-invite/page";

export const dynamic = "force-dynamic";

// The route resolves identity ITSELF with the redirecting guard: a shell layout's guard does not run on a soft
// navigation (SENTRY-IDENTITY-01), and a page that re-exports another route's component would resolve nothing here.
export default async function Route(props: Parameters<typeof SettingsRoute>[0]) {
  await requirePractitionerWithStudio();
  return <SettingsRoute {...props} />;
}
