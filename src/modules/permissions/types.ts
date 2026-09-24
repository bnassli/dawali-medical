import type { PermissionCode } from "./constants";

/**
 * The explicit actor context that every module service function takes,
 * rather than pulling the current user from ambient/global state. This
 * keeps services independently testable (SPRINT_1 spec requirement).
 */
export interface ActorContext {
  userId: string;
  displayName: string;
  permissions: ReadonlySet<PermissionCode>;
  ip?: string | null;
  userAgent?: string | null;
}
