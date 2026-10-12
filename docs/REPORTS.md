# Reports — Medical V1

Reports are editable `.docx`.

## Template 1 — Short report
Header/logo; Patient; File Number; Date; report text; diagram/image; doctor identity/signature/initials.

## Template 2 — Initial Venous Consultation / Vascular Evaluation
Page 1: header; Patient; File Number; Date; HISTORY; PAST MEDICAL HISTORY; PHYSICAL EXAMINATION; diagram.
Page 2: ULTRASOUND FINDINGS; venous findings; venous diagram; IMPRESSION; RECOMMENDATIONS; doctor identity/signature.

Rules:
- Pull data from visit/clinical tabs.
- Avoid retyping.
- Preview before finalization.
- Finalized reports are versioned.
- Later edits create amended/new versions.
- Save to patient file area and DB index.
- Keep templates data-driven, not hard-coded in page components.

## Where the first draft comes from (ADR-034, ADR-045)
- HISTORY: Subj Complaints Habits (reason, complaints, duration, progression, therapy, family history of VV, medications) and Past Venous Hx (checked items, Vein History Narrative).
- PAST MEDICAL HISTORY: Past Medical Hx (history, allergies, surgical and family history).
- ULTRASOUND FINDINGS: Initial US Exam (a paragraph per leg, then measurements, findings, DVT statement, US impression), then the Post EVLT ultrasound fields.
- IMPRESSION / RECOMMENDATIONS: the Assessment Plan+ rows.
- Template 1 narrative: Treatment Plan procedures completed that day and the follow-up plan.
