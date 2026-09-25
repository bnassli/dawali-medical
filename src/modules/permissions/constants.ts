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
  PATIENT_SET_ACTIVE: "patient.set_active",
  PATIENT_OPTION_ADD: "patient_option.add",
  PATIENT_OPTION_MANAGE: "patient_option.manage",
  VISIT_READ: "visit.read",
  VISIT_CREATE: "visit.create",
  USER_READ: "user.read",
  USER_MANAGE: "user.manage",
  AUDIT_READ: "audit.read",
  CLINICAL_READ: "clinical.read",
  CLINICAL_WRITE: "clinical.write",
  CLINICAL_OPTION_ADD: "clinical_option.add",
  CLINICAL_OPTION_MANAGE: "clinical_option.manage",
  REPORT_FINALIZE: "report.finalize",
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSION_CODES: PermissionCode[] = Object.values(
  PERMISSIONS,
) as PermissionCode[];

export const PERMISSION_DESCRIPTIONS: Record<PermissionCode, string> = {
  [PERMISSIONS.PATIENT_READ]: "View patient demographics and search",
  [PERMISSIONS.PATIENT_CREATE]: "Create new patients",
  [PERMISSIONS.PATIENT_UPDATE]: "Update patient demographics",
  [PERMISSIONS.PATIENT_SET_ACTIVE]:
    "Mark a patient inactive or reactivate them (inactive patients get no new visits)",
  [PERMISSIONS.PATIENT_OPTION_ADD]:
    "Add new Nationality / Preferred Language options (+ Add New)",
  [PERMISSIONS.PATIENT_OPTION_MANAGE]:
    "Retire/reactivate Nationality / Preferred Language options",
  [PERMISSIONS.VISIT_READ]: "View visits",
  [PERMISSIONS.VISIT_CREATE]: "Create new visits",
  [PERMISSIONS.USER_READ]: "View user accounts",
  [PERMISSIONS.USER_MANAGE]: "Create/update user accounts and roles",
  [PERMISSIONS.AUDIT_READ]: "View audit log history",
  [PERMISSIONS.CLINICAL_READ]: "View clinical entries for a visit",
  [PERMISSIONS.CLINICAL_WRITE]:
    "Create/update clinical entries, including visit-only free text",
  [PERMISSIONS.CLINICAL_OPTION_ADD]:
    "Add new permanent options to clinical option lists (+ Add New)",
  [PERMISSIONS.CLINICAL_OPTION_MANAGE]:
    "Retire/reactivate clinical option list options",
  [PERMISSIONS.REPORT_FINALIZE]:
    "Finalize or amend a report (the .docx is signed with this user's name)",
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
  // Admin is the only role with patient.set_active and patient_option.manage
  // (ADR-028). Admin deliberately lacks clinical.write: an admin who also needs to edit
  // clinical entries must additionally be assigned the DOCTOR role.
  [ROLES.ADMIN]: ALL_PERMISSION_CODES.filter(
    (code) => code !== PERMISSIONS.CLINICAL_WRITE && code !== PERMISSIONS.REPORT_FINALIZE,
  ),
  [ROLES.DOCTOR]: [
    PERMISSIONS.PATIENT_READ,
    PERMISSIONS.PATIENT_CREATE,
    PERMISSIONS.PATIENT_UPDATE,
    PERMISSIONS.PATIENT_OPTION_ADD,
    PERMISSIONS.VISIT_READ,
    PERMISSIONS.VISIT_CREATE,
    PERMISSIONS.CLINICAL_READ,
    PERMISSIONS.CLINICAL_WRITE,
    PERMISSIONS.CLINICAL_OPTION_ADD,
    // Only a doctor signs a report (R5, ADR-034).
    PERMISSIONS.REPORT_FINALIZE,
  ],
  [ROLES.NURSE_ASSISTANT]: [
    PERMISSIONS.PATIENT_READ,
    PERMISSIONS.VISIT_READ,
    PERMISSIONS.VISIT_CREATE,
    PERMISSIONS.CLINICAL_READ,
    PERMISSIONS.CLINICAL_WRITE,
  ],
  [ROLES.RECEPTION]: [
    PERMISSIONS.PATIENT_READ,
    PERMISSIONS.PATIENT_CREATE,
    PERMISSIONS.PATIENT_UPDATE,
    PERMISSIONS.PATIENT_OPTION_ADD,
    PERMISSIONS.VISIT_READ,
    PERMISSIONS.VISIT_CREATE,
  ],
  [ROLES.INVENTORY]: [],
};
