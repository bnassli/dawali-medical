/**
 * Known external identifier "systems". iCare is the first external system
 * we integrate with; the column stays generic text so future systems don't
 * require a migration (ICARE_INTEGRATION.md).
 */
export const EXTERNAL_ID_SYSTEMS = {
  ICARE_FILE_NO: "ICARE_FILE_NO",
} as const;
