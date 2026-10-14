import { createAdminClient } from "@/lib/supabase/admin-server";
import { resolveDemoInventory, senderControlsGate, type SenderRecovery } from "@/lib/sms/sender-controls";
import { SmsSenderControls } from "./SmsSenderControls";

// SMS-SENDER-CONTROL-01 (#824): the owner's sender controls, FAKE PROVIDER
// ONLY. A server component of its own so the integrations PAGE keeps its
// read-only boundary (tests/source-guards/sms-status-readonly-boundary.test.ts:
// the page reads sender state through the request-scoped session client and
// never constructs a service-role client).
//
// The one service-role use here is a READ, inside the gate: which demo number
// pair to advertise, the studio's first candidate that no other studio records
// (resolveDemoInventory, 0226 studio_sms_resource_recorded; Codex P2
// 4274756044). The gate is re-checked here so this component can never run
// outside the fake mode, whatever renders it.
export async function SmsSenderControlsSection({
  studioId,
  recovery,
}: {
  studioId: string;
  recovery: SenderRecovery;
}) {
  if (!senderControlsGate().open) return null;
  const inventory = await resolveDemoInventory(createAdminClient(), studioId);
  return <SmsSenderControls inventory={inventory} recovery={recovery} />;
}
