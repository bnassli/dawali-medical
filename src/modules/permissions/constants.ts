/**
 * RBAC permission and role codes for Sprint 1.
 *
 * These are system access-control identifiers (not clinical dropdown
 * options — CLAUDE.md rule #10 is about clinical field option lists, e.g.
 * future "reason for visit" choices, which must stay data-driven). Roles
 * and permissions are structural to the authorization system itself and are
 * still seeded into the database as rows (roles/permissions/role_permissions
 * tables) rather than checked against string literals scattered in code.
 */
export const PERMISSIONS = {
  PATIENT_READ: "patient.read",
  PATIENT_CREATE: "patient.create",
  PATIENT_UPDATE: "patient.update",
  VISIT_READ: "visit.read",
  VISIT_CREATE: "visit.create",
  USER_READ: "user.read",
  USER_MANAGE: "user.manage",
  AUDIT_READ: "audit.read",
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSION_CODES: PermissionCode[] = Object.values(
  PERMISSIONS,
) as PermissionCode[];

export const PERMISSION_DESCRIPTIONS: Record<PermissionCode, string> = {
  [PERMISSIONS.PATIENT_READ]: "View patient demographics and search",
  [PERMISSIONS.PATIENT_CREATE]: "Create new patients",
  [PERMISSIONS.PATIENT_UPDATE]: "Update patient demographics",
  [PERMISSIONS.VISIT_READ]: "View visits",
  [PERMISSIONS.VISIT_CREATE]: "Create new visits",
  [PERMISSIONS.USER_READ]: "View user accounts",
  [PERMISSIONS.USER_MANAGE]: "Create/update user accounts and roles",
  [PERMISSIONS.AUDIT_READ]: "View audit log history",
};

export const ROLES = {
  ADMIN: "ADMIN",
  DOCTOR: "DOCTOR",
  NURSE_ASSISTANT: "NURSE_ASSISTANT",
  RECEPTION: "RECEPTION",
  INVENTORY: "INVENTORY",
} as const;

export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_NAMES: Record<RoleCode, string> = {
  [ROLES.ADMIN]: "Administrator",
  [ROLES.DOCTOR]: "Doctor",
  [ROLES.NURSE_ASSISTANT]: "Nurse / Assistant",
  [ROLES.RECEPTION]: "Reception",
  [ROLES.INVENTORY]: "Inventory",
};

export const ROLE_PERMISSIONS: Record<RoleCode, PermissionCode[]> = {
  [ROLES.ADMIN]: ALL_PERMISSION_CODES,
  [ROLES.DOCTOR]: [
    PERMISSIONS.PATIENT_READ,
    PERMISSIONS.PATIENT_CREATE,
    PERMISSIONS.PATIENT_UPDATE,
    PERMISSIONS.VISIT_READ,
    PERMISSIONS.VISIT_CREATE,
  ],
  [ROLES.NURSE_ASSISTANT]: [
    PERMISSIONS.PATIENT_READ,
    PERMISSIONS.VISIT_READ,
    PERMISSIONS.VISIT_CREATE,
  ],
  [ROLES.RECEPTION]: [
    PERMISSIONS.PATIENT_READ,
    PERMISSIONS.PATIENT_CREATE,
    PERMISSIONS.PATIENT_UPDATE,
    PERMISSIONS.VISIT_READ,
    PERMISSIONS.VISIT_CREATE,
  ],
  [ROLES.INVENTORY]: [],
};
