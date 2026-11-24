import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// Custom client groups were removed. An old link or bookmark lands on the standard directory.
//
// Identity is resolved FIRST, like every authenticated page (no sign-in, no active membership, or an unchosen studio
// among several each get their own redirect before anything else happens). Only then does the old route forward. It
// reads nothing else, so it answers the same for every role, and the page it forwards to enforces its own access.
export default async function RemovedClientGroupsPage(): Promise<never> {
  await requirePractitionerWithStudio();
  redirect("/clients");
}
