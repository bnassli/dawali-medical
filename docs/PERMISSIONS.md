# Roles and Permissions
Initial roles: Admin, Doctor, Nurse/Assistant, Reception, future Inventory.

Principles: least privilege, audited admin actions, restricted report finalization, highly restricted clinical-history deletion.

Admin: users, roles, option lists, templates, config, permissions.
Doctor: permitted patient/visit clinical work, diagrams, reports, procedures.
Nurse/Assistant: configurable limited clinical-entry rights.
Reception: patient registration/search/basic demographics, no unrestricted clinical editing.
Inventory: future stock-specific permissions.

## Clinical permissions (Sprint 2, see ADR-020)
| Code | Admin | Doctor | Nurse/Assistant | Reception |
|---|---|---|---|---|
| clinical.read | yes | yes | yes | no |
| clinical.write | no | yes | yes | no |
| clinical_option.add | yes | yes | no | no |
| clinical_option.manage | yes | no | no | no |

An admin who also needs to edit clinical entries must additionally be assigned the Doctor role.
