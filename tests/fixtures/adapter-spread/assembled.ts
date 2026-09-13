import { partsA } from "./parts-a";
import { partsB } from "./parts-b";

// Declares no named property of its own, yet structurally satisfies the
// contract. This is the shape the guard must catch.
export const assembled = { ...partsA, ...partsB };
