# Product Specification — Medical V1

## Goal
Web medical application with a SonoSoft-familiar workflow, modern backend, file management, audit, reporting, and extensibility.

## Main flow
Login → patient search/open → create/open visit → Patient Chart → clinical tabs → optional diagram → editable Word report → save/index files.

## UX principle
Preserve tab order, section order, familiar labels, and general layout. Modernize behind the scenes: auto-save, auditing, validation, faster search, dynamic options, reporting, file indexing.

## Confirmed V1 modules
Authentication; users/roles/permissions; patients; visits; Patient Chart; clinical tabs; Treatment Plan; Follow Up Office Visit; Laser Ablation; diagrams; reports; patient file registry; audit; iCare integration layer.

## Dynamic options
Predefined values + `+ Add New` + save permanently or use as visit-only free text.

## Reports
Two initial templates:
1. Short procedure-style report.
2. Initial Venous Consultation / Vascular Evaluation, two-page style.
Output editable `.docx`, include patient/visit/clinical data, diagram, doctor, save to patient files, support draft/final/amended lifecycle.

## Future Inventory
Products, suppliers, invoice scanning/AI extraction, manual entry, batches/lots, expiry, stock movements, doctor/procedure consumption.
