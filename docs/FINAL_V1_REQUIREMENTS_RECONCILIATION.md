# Dawali Medical — Final V1 Requirements & Reconciliation
**Status:** Product-owner reviewed after re-checking the original SonoSoft screens.  
**Purpose:** This document is the final functional reference for Claude Code, Codex, and human review.  
**Rule:** Preserve the stable backend already built; reconcile the existing implementation with this document instead of restarting the project.

---

## 1. Product goal

Build a web medical application with a **SonoSoft-familiar clinical workflow** but a modern backend, safer data handling, faster search, audit history, versioning, and editable Word reports.

Doctors are used to the old layout, so preserve:
- familiar screen order,
- familiar field grouping,
- familiar labels,
- stable patient context at the top of the screen.

Modernize the implementation, not the doctor's mental model.

---

## 2. Current repository state — preserve, do not rebuild

The following foundation already exists and should remain:
- Authentication and sessions.
- Users, roles and permissions.
- Patients and visits.
- Audit logging.
- Patient Chart foundation.
- Dynamic clinical options / `+ Add New` / visit-only free text.
- Autosave, optimistic concurrency and navigation protection.
- `Subj Complaints Habits`.
- `Past Medical Hx`.
- `Assessment Plan+`.
- Tests, CI, migrations and data-driven clinical section architecture.

Known reconciliation items in the current implementation:
1. Patient Chart shell is too generic visually and must become more SonoSoft-familiar.
2. Patient Search needs SonoSoft-like modal/table UX and Insurance ID search.
3. Past Medical Hx is missing the female-specific statement field.
4. Assessment Plan+ stockings measurements were simplified too much and must become structured fields.
5. Impression / Recommendations need ordered visible rows instead of feeling like one generic multiselect control.
6. Remaining required tabs/modules have not yet been implemented.

**Do not rewrite existing stable clinical/audit/concurrency code merely for UI changes.**
Use additive migrations only when the data model truly needs new fields/tables.

---

# 3. Persistent Patient Header

Every patient/visit clinical screen should show a compact, persistent patient context at the top.

Required information/actions:
- File / Medical ID.
- Patient full name.
- Sex.
- Birthdate.
- Age (calculated).
- Race / nationality when available.
- Create New Patient.
- Patient Search.
- Create Report.
- View Patient Chart.
- Current User.
- Home / Save as appropriate.

The large legacy SonoSoft navigation row is **NOT required**, including:
`Home / Ext Demographics / Contact Info / Insurance Info / Primary Ins / Secondary Ins / Tertiary Ins / Other Insured / Today's Charges / General Note / Physicians / ...`

After the persistent header, go directly to the clinical module/tabs required below.

---

# 4. Patient Search

Use a quick modal/dialog workflow similar to SonoSoft.

Search fields:
- Medical/File ID.
- Last Name.
- First Name.
- Insurance ID.
- Birthdate.
- Cell/Mobile Number.

Results table should show at minimum:
- Medical/File ID.
- Last Name.
- First Name.
- Birthdate.

Behavior:
- Double-click or an explicit Open action opens the selected patient.
- If no patient exists, `Create New Patient Record` opens the create form.
- Values already typed into search should prefill matching create-patient fields where practical.
- Search must be fast and literal-safe.

---

# 5. Create / Edit Patient — V1

Keep the form intentionally short.

Required / useful V1 fields:
- File / Medical ID / iCare external file number.
- First Name.
- Middle Name (optional).
- Last Name.
- Sex.
- Date of Birth.
- Age (derived, not manually maintained).
- Mobile / Cell Phone.
- Email (optional).
- Nationality / Race (optional).
- Preferred Language (optional).
- National ID / Iqama (optional).
- Insurance ID (optional).
- Inactive Patient (admin/authorized users).

Optional emergency contact:
- Name.
- Phone.
- Relationship.

Do **not** reproduce the legacy demographic clutter unless requested later:
nickname, multiple phone categories, DND flags, student/employment blocks, school, occupation, marital/partner blocks, transfer-of-care checkbox, etc.

---

# 6. Clinical tabs/modules — final required V1 scope

## 6.1 Subj Complaints Habits

Preserve SonoSoft grouping and order.

Required:
- Reason for visit.
- Problem List.
- Chief Complaints.
- Associated condition.
- How long?
- Symptoms getting worse over time? (checkbox).
- Affects daily living activities?
- Additional Comments.
- Comment.
- Aggravating Factors.
- Relieving Factors.
- Previous conservative therapy.
- How long?
- Family history of VV? (specific to varicose veins).
- Habits:
  - Alcohol.
  - Exercise.
  - Tobacco use.
- Pain Meds for CC.
- Current Meds.
- Allergies.

Rule:
- Do not flatten this into one generic vertical form.
- Preserve visible grouped blocks.
- Where appropriate use predefined options + `Add New` + visit-only free text.

---

## 6.2 Past Medical Hx

Final order:
1. Past Medical Hx.
2. Family Medical Hx.
3. Unknown (checkbox).
4. Prior Test Results.
5. Additional Comments.
6. Surgical Hx.
7. Female-specific statement dropdown:
   `If FEMALE select the appropriate statement; otherwise disregard`.

Rules:
- Female-specific field is **required**, not deferred.
- It should be visible/enabled only when patient sex is Female.
- `Unknown` remains mutually exclusive with Past Medical Hx values as already implemented.
- Keep existing shared Family History source of truth if already architected that way.

---

## 6.3 Assessment Plan+

### Impression
- Bullets / Numbers display mode.
- `Select Impressions`.
- Visible ordered rows 1–8.
- Each row supports reusable predefined content and free text when appropriate.
- Keep `Impr for Init Venous Interp` as a separate field.

### Recommendations
- `Select Recommendations`.
- Visible ordered rows 1–8.
- Each row supports reusable predefined content and free text when appropriate.

### Stockings detail
Structured independent fields:
- Type.
- Compression.
- Gender (stocking cut; not patient sex).
- Color.
- Mid Thigh.
- Mid Calf.
- Mid Ankle.
- Floor to GF.
- Floor to Knee.

Do not use one generic textarea for stocking measurements.

Additional Comments may remain as a separate field if already part of the current model.

---

## 6.4 Treatment Plan

This is a structured repeatable table, not a textarea.

Columns:
1. Scheduled.
2. Completed.
3. Recommended Treatment / Procedures in the order to be received.
4. Approval / Status / Comments.

Rules:
- Multiple rows.
- Scheduled and Completed are dates.
- Procedures support predefined values + add-new/free text.
- Status/comments support predefined values + free text.
- Procedure order matters and must be preserved.
- Future inventory linkage must attach to a treatment/procedure row without changing the doctor's workflow.

---

## 6.5 Follow Up Office Visit

Final layout:

### Subjective
- Patient feels:
  - Better.
  - Worse.
  - Same as last visit.
- Reusable statement dropdown.
- Large narrative area.

### Objective Findings
- Large narrative area.

### Assessment
- Three visible ordered rows (1–3) as in the reference screen.
- Reusable options + free text.

### Plan
- Select action.
- Plan 1 visible large entry area.
- Data model should allow more plan items later without redesigning history.

Each follow-up is a separate historical visit/entry. Never overwrite prior follow-up history.

`Add Charge` is out of scope.

---

## 6.6 Laser Ablation

Structured procedure form.

Required groups/fields:

### Treated Vessel
- Laterality / side.
- Vessel.
- Beginning location.
- Distance from junction.
- Termination location.

### Ambulatory Phlebectomy
- Yes/No or appropriate selection.
- Location.
- Number of incisions.
- Method / blade.

### Anesthesia / preparation
- Anesthesia details.
- Relevant agents/materials.
- Cleansed with.

### Pass details
- Single Pass: entry point and destination.
- Duplication / 2nd Pass: from/to fields.

### Treatment Parameters
- Treatment parameters.
- Treatment changed at...
- Total laser energy.
- Joules.
- Seconds.
- Total length of vein treated.
- Average diameter of vein.
- Optional parameter field.
- Fluence.

### Notes
- Additional Surgical Comments.
- Final Comments.

### Device
- Laser Machine selector, configurable from settings/admin data.

Numeric clinical parameters must remain structured numeric values where appropriate.

`Add Charge` and `Registry Data` are out of scope for V1.

---

## 6.7 Comprehensive / General Clinical Exam

This is one comprehensive screen/module; do not recreate all old SonoSoft tabs separately.

### Vitals
- Height.
- Weight.
- Pulse.
- BP.
- Rhythm.
- Temperature.
- Respiratory Rate.
- BMI (calculate when height/weight are available).

### General clinical
- Subjective.
- Objective Findings.
- Past Medical Hx.
- Current Meds.
- Allergies.
- Social Hx.

### Physical Exam Findings
At minimum preserve the referenced fields:
- Constitution.
- Eyes.
- ENMT.
- Neck.
- Lungs.
- Cardio.
- Additional physical exam rows can be added from the reference set without changing the section pattern.

### Ultrasound Exam
- Indications.
- Findings.
- Impression.

### Scores
- CEAP.
- VCSS Right.
- VCSS Left.

### Impression
- Bullets / Numbers.
- Add/Select Impression.
- Four visible ordered rows as in the reference comprehensive screen.
- `Impr for Init Venous Interp`.

### Recommendations
- Add/Select Recommendations.
- Multiple ordered rows.

Reuse shared/global field definitions where the same clinical concept already exists. Do not create competing sources of truth.

---

# 7. Venous Duplex DVT reference screen

Do **not** recreate the full old Venous Duplex DVT form.

From that old screen we only need diagram creation actions.

Expose two separate actions:
1. `Create Leg Diagram`
2. `Create Vein Diagram`

They are independent actions. One button must not automatically create the other diagram.

---

# 8. Diagram requirements

## 8.1 Leg Diagram
Base template:
- Front.
- Back.

## 8.2 Vein Diagram
Base template:
- Right Posterior.
- Central/front venous anatomy.
- Left Posterior.

## 8.3 Creation and versioning
For either button:
- Copy the correct immutable base template.
- Create a new patient-specific working copy.
- Associate it with patient, visit, doctor/user, type, created date/time.
- Never overwrite an earlier saved version.
- Save a rendered image (PNG/JPG) suitable for Word report insertion.
- Preserve an editable/source representation if the chosen implementation requires one.
- Clear naming with timestamp/version, e.g.:
  - `2026-09-24_1030_LegDiagram_v01.png`
  - `2026-09-24_1030_VeinDiagram_v01.png`

## 8.4 Editing workflow
Product requirement:
- Doctor must be able to open the created diagram, draw/mark on it, save it, reopen it, and keep versions.

The old workflow used an external image editor. Because this is now a web application, implementation may use:
- a lightweight in-app drawing editor, **or**
- a controlled external/local-helper workflow,
provided the doctor experience remains simple and saved edits return to the patient's indexed files.

Do not assume a normal browser can reliably launch/save back from Windows Paint without an explicit integration mechanism.

---

# 9. Reports — final V1

All reports are editable `.docx`.

Reports must use actual patient/visit data and saved diagrams. Do not make the doctor retype information already captured in the chart.

## 9.1 Template 1 — Short procedure-style report

Layout/content:
- Dawali Clinic header/logo.
- Patient name.
- File number.
- Date.
- Procedure/report narrative text.
- **Leg Diagram embedded in the report**.
- Doctor identity / initials / signature area.

Diagram rule:
- Use the latest relevant saved Leg Diagram for that visit/report unless the user explicitly selects another version.
- If no Leg Diagram exists, show a clear warning and allow the doctor to create/select one. Do not silently substitute an untouched base template.

## 9.2 Template 2 — Initial Venous Consultation / Vascular Evaluation

Two-page style.

### Page 1
- Dawali Clinic header/logo.
- Patient.
- File Number.
- Date.
- HISTORY.
- PAST MEDICAL HISTORY.
- PHYSICAL EXAMINATION.
- **Leg Diagram (Front/Back)**.

### Page 2
- ULTRASOUND FINDINGS.
- Venous findings narrative.
- **Vein Diagram**.
- IMPRESSION.
- RECOMMENDATIONS.
- Doctor identity / signature.

Diagram rule:
- Page 1 uses the Leg Diagram.
- Page 2 uses the Vein Diagram.
- Missing required diagram should generate a clear warning and allow create/select; do not silently use a blank base template.

## 9.3 Report lifecycle
- Preview before finalization.
- Editable `.docx`.
- Draft / final / amended lifecycle.
- Finalized versions are never overwritten.
- Later edits create a new/amended version.
- Save/index under the patient.
- Templates must be data-driven.
- Architecture should allow 4–5 doctor-specific templates later without rebuilding the report engine.

---

# 10. Patient folder and file registry

Preserve the familiar file-based concept while also indexing files in the database.

Suggested patient directory:
`PatientCharts/<PATIENT NAME> (<FILE ID>)/`

Existing SonoSoft-style folders may be supported:
- Call Log.
- Consent Forms.
- Diagrams.
- Financial.
- Images.
- Misc.
- Photos.
- Rx.
- Scanned Documents.

V1 does not need to create every folder eagerly. Create folders when first used.

Required behavior:
- Diagrams go under `Diagrams`.
- Reports must be easy to find from the patient record and may be stored in a Reports folder or compatible patient-root location, but must always be indexed in the DB.
- Files should record patient, visit when applicable, type, date, creator/doctor, and version.
- Users should not need Windows Explorer for normal workflow.

---

# 11. Users and permissions

Core V1 roles:
- Admin.
- Doctor.
- Nurse / Assistant.
- Reception.

Future:
- Inventory role.

General intent:
- Reception can search/create/manage basic patient intake.
- Reception must not receive unrestricted clinical-record access.
- Doctor and authorized clinical staff can enter clinical data according to permissions.
- Important changes are audited.

Keep the current permission/audit architecture unless a specific requirement forces change.

---

# 12. iCare integration

Dawali Medical keeps its own internal patient UUID.

iCare file number is an external identifier, not the database primary key.

Support:
- Manual entry/update of iCare file number.
- Later automatic patient intake/sync from iCare.

Do not tightly couple Dawali's database design to iCare internals.

---

# 13. Inventory — future, not current implementation

Future scope only:
- Products.
- Suppliers.
- Invoice scan/PDF/image.
- AI/OCR extraction to draft invoice.
- Manual entry.
- Batch/lot.
- Expiry.
- Stock movements.
- Consumption linked to patient + visit + procedure + doctor + product/batch + quantity.

Prepare extension points, but do not build Inventory during current V1 reconciliation.

---

# 14. Explicitly excluded legacy SonoSoft areas

Unless separately requested later, do not recreate:
- Ext Demographics tab.
- Contact Info tab.
- Insurance navigation tabs.
- Primary/Secondary/Tertiary insurance tabs.
- Other Insured.
- Today's Charges.
- General Note.
- Physicians tab.
- Time Card.
- Billing workflow.
- Add Charge.
- Registry Data.
- Full Venous Duplex DVT form.
- Every old SonoSoft tab merely because it exists in the screenshots.

---

# 15. Reconciliation plan against the existing repository

Do this in small reviewable branches/PRs. Do not restart the app.

## R1 — Clinical UI reconciliation
- Persistent Patient Header.
- Patient Search modal/table + Insurance ID search.
- Create/Edit Patient simplified V1 form.
- Past Medical Hx female-specific statement.
- Assessment Plan+:
  - ordered Impression rows,
  - ordered Recommendation rows,
  - structured stockings measurements.
- Preserve existing history/audit/concurrency/autosave.

## R2 — Treatment Plan
- New repeatable Treatment Plan entity/table design.
- Additive migration.
- Ordered rows and dates/status/comments.
- No Inventory implementation yet.

## R3 — Follow Up + Laser + Comprehensive Exam
- Follow Up Office Visit.
- Laser Ablation.
- Comprehensive / General Clinical Exam.
- Reuse shared field definitions and option infrastructure.

## R4 — Diagram engine
- Two separate actions:
  - Create Leg Diagram.
  - Create Vein Diagram.
- Template/version/file registry integration.
- Simple editing workflow.
- No overwrite.

## R5 — Report engine
- Template 1 with Leg Diagram.
- Template 2 with Leg Diagram + Vein Diagram.
- Editable DOCX, versioning, patient file indexing.

## R6 — iCare integration
- Manual external identifier complete.
- Connector/sync layer after staging contract is confirmed.

Inventory remains future work.

---

# 16. Engineering rules for Claude Code / Codex

1. Read this file before planning changes.
2. Read `CLAUDE.md` and current `/docs`.
3. Treat this file as the product-owner override when older docs conflict with the reviewed UI requirements above.
4. Do not work directly on `main`.
5. Do not merge automatically.
6. Do not rewrite stable backend services just to alter presentation.
7. Preserve patient history, append-only audit, permissions, optimistic concurrency, idempotency and safe autosave.
8. Use additive DB migrations after the already-merged migrations; do not rewrite merged migration history.
9. Never commit real patient data, screenshots containing PHI, database backups, secrets or `.env` files.
10. Add focused tests for every corrected requirement.
11. Run typecheck, lint, relevant unit/integration tests, E2E where appropriate, production build and DB validation before requesting merge.
12. One reconciliation phase at a time. Do not silently continue to the next phase.

---

# 17. Security / repository note

Before any real patient screenshots, patient files or other PHI are used in development:
- repository must be private,
- PHI must not be committed,
- reference screenshots should be anonymized/redacted if they ever need to become durable project assets.

The screenshots used to derive this document are product references only; their patient data is not seed/demo content.

---

# 18. Acceptance principle

A doctor familiar with SonoSoft should recognize the workflow quickly, while the implementation remains modern, auditable, safe and maintainable.

When there is a choice between:
- adding legacy clutter, or
- preserving only the familiar clinical workflow,

choose the familiar clinical workflow.
