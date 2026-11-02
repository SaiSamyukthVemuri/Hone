import type { AttentionClient } from "./needs-attention-model";

/** A card carrying a reaction/watch (treatment-memory) item. Pure; shared by the model's ordering and the panel. */
export function cardHasReaction(card: Pick<AttentionClient, "items">): boolean {
  return card.items.some((i) => i.kind === "treatment_memory");
}
