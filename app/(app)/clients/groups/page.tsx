import { redirect } from "next/navigation";

// Client groups were removed. An old link or bookmark lands on the standard directory. Nothing is read, so this answers
// the same for every role and signed-in state (the app shell's own sign-in redirect still applies first).
export default function RemovedClientGroupsPage(): never {
  redirect("/clients");
}
