// THE ENERGY LEVEL AN ENTRY STORES. The entry column is an INTEGER (0166), while the block column is numeric. A Galvanic block may carry a fractional
// EL (2.5); with the redesign on Galvanic now keeps its EL, so forwarding that fraction to the entry's integer parameter failed an unrelated edit.
// The block keeps the exact value (nothing is lost); the entry takes it only when it is whole, and otherwise stays null, which is what it was
// before Galvanic kept an EL.
export function entryEnergyLevel(input: { mode: string | null; energyLevel: number | null; keepGalvanicEnergy?: boolean }): number | null {
  if (input.mode !== "galv") return input.energyLevel;
  if (!input.keepGalvanicEnergy) return null;
  return input.energyLevel !== null && Number.isInteger(input.energyLevel) ? input.energyLevel : null;
}
