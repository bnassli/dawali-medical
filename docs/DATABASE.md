# Database — Initial Domain Model

Core:
- users
- roles
- permissions
- user_roles / role_permissions
- patients
- patient_external_ids
- visits

Clinical:
- clinical_sections
- clinical_field_definitions
- clinical_option_lists
- clinical_options
- clinical_entries

Procedures:
- treatment_plans
- treatment_plan_items
- procedures
- laser_ablations
- followups

Diagrams:
- diagram_templates
- diagrams
- diagram_versions

Reports:
- report_templates
- reports
- report_versions

Files:
- patient_files

Audit:
- audit_logs

Rules:
- Historical visits are never overwritten.
- Final reports are versioned/amended.
- Saved diagrams are versioned.
- Clinical deletion is soft/privileged and audited.
