import { adminQuery } from "./harness";

// 0382 closes receptionist_client_directory and receptionist_client_contacts_v2 to every role (they return full phone and email and have
// no caller in the app). Their BODIES are still reviewed code (0380's name rule), so the tests that prove the bodies reopen the privilege
// for the duration of ONE test file and close it again in afterAll. The DB lane runs files one after another (fileParallelism: false), and
// tests/db/receptionist-older-commands-closed.db.test.ts asserts the closed state, so a file that forgot to close would fail there.
// On a chain WITHOUT 0382 both calls are harmless (they only restate the 0380 grant).
const FNS = [
  "public.receptionist_client_directory(uuid, text, text[], text, integer, integer)",
  "public.receptionist_client_contacts_v2(uuid, text, integer)",
];

export async function reopenOlderContactCommands(): Promise<void> {
  for (const f of FNS) await adminQuery(`grant execute on function ${f} to authenticated`);
}

export async function closeOlderContactCommands(): Promise<void> {
  for (const f of FNS) await adminQuery(`revoke all on function ${f} from public, anon, authenticated, service_role`);
}
