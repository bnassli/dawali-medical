/** I5 (ADR-043): where written-off stock goes, and why. Shared by the schema, the service and the screens. */
export const WRITE_OFF_KINDS = ["supplier_return", "disposal"] as const;
export type WriteOffKind = (typeof WRITE_OFF_KINDS)[number];
/** Why stock leaves without being used on a patient (the movement type says where it goes). */
export const WRITE_OFF_REASONS = ["expired", "damaged", "recalled", "other"] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];
