# Diagram Engine
Scope: Create Diagram only from the referenced ultrasound area.

Flow:
Create Diagram → copy base template → drawing editor → save → rendered PNG + editable version → index by patient/visit/doctor/date → optional report insertion.

V1 tools: pen, color, thickness, eraser, undo, redo, clear, save.
Never modify base template. Never overwrite earlier saved versions.
Suggested names: `YYYY-MM-DD_Sclero_01.png`, `YYYY-MM-DD_US_01.png`.

Implemented in R4 — see ADR-033 (docs/DECISIONS.md). Base templates in `public/diagram-templates/` are placeholders until the clinic supplies the real Leg and Vein images.
