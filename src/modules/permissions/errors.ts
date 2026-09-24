export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN" as const;
  readonly permission: string;

  constructor(permission: string) {
    super(`Missing required permission: ${permission}`);
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}
