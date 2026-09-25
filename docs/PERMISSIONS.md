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

Sprint 3A adds no permissions: Past Medical Hx and Assessment Plan+ use the four clinical permissions above unchanged. A Nurse/Assistant writes visit-only text and may check Unknown; only Doctor/Admin add permanent options; Admin is read-only unless also a Doctor; Reception has no clinical access and sees no tabs. If Treatment Plan (Sprint 3B) needs a separate approval right, that is a new permission to be decided then.

## Patient permissions added in R1a (ADR-028)
| Code | Admin | Doctor | Nurse/Assistant | Reception |
|---|---|---|---|---|
| patient.set_active (mark inactive / reactivate) | yes | no | no | no |
| patient_option.add (Nationality / Preferred Language "+ Add New") | yes | yes | no | yes |
| patient_option.manage (retire / reactivate those options) | yes | no | no | no |

Existing databases get these by re-running `npm run db:seed` (role permissions are recomputed).

`report.finalize` (R5, ADR-034): finalize or amend a report; Doctor only. Drafts need `clinical.write`.

`inventory.read`, `inventory.manage` (Inventory role, Admin), `inventory.consume` (Doctor, Nurse/Assistant) — I1, ADR-035.
