# SonoSoft reference screens

Screenshots of the legacy SonoSoft desktop app used at Dawali clinics. They are the
visual reference for the new UI: the Product Owner decided (2026-09-25) that each tab
the clinic uses must look the same as in SonoSoft — same tabs, same boxes, same field
positions and labels — so doctors do not have to relearn the workflow.

**Privacy.** Every identifying detail was blacked out before these files were committed:
patient names, file / medical ID, birthdate, age, visit and procedure dates, and the
report file name. Never add an unredacted screenshot to this repository. New screenshots
must be redacted the same way, or taken on a test patient.

## Tabs

SonoSoft has two tab sets, switched by the `Workup` / `Treatment` radio in the header.
The number in each file name is the tab's position in its set.

| File | Tab | Set |
| --- | --- | --- |
| `tabs/workup-01-subj-complaints-habits.jpg` | Subj Complaints Habits | Workup |
| `tabs/workup-03-past-medical-hx.jpg` | Past Medical Hx | Workup |
| `tabs/workup-09-assessment-plan-plus.jpg` | Assessment Plan+ | Workup |
| `tabs/treatment-01-treatment-plan.jpg` | Treatment Plan | Treatment |
| `tabs/treatment-02-laser-ablation.jpg` | Laser Ablation | Treatment |
| `tabs/treatment-09-follow-up-office-visit.jpg` | Follow Up Office Visit | Treatment |
| `tabs/treatment-10-post-evlt-comp-follow-up-part1.jpg` | Post EVLT Comp Follow Up (top: vitals to Cardio) | Treatment |
| `tabs/treatment-10-post-evlt-comp-follow-up-part2.jpg` | Post EVLT Comp Follow Up (bottom: ultrasound to recommendations) | Treatment |

Workup tab order: Subj Complaints Habits, Past Venous Hx, Past Medical Hx, Review of
Systems, Vascular Findings, Physical Exam, Initial US Exam, CEAP VCSS, Assessment Plan+.

Treatment tab order: Treatment Plan, Laser Ablation, Multi Vessel Abl, Post Abl US,
Venous Duplex DVT, Sclero, Surface Laser, Hemorrhoid Tx, Follow Up Office Visit,
Post EVLT Comp Follow Up.

Not yet captured: Past Venous Hx, Review of Systems, Vascular Findings, Physical Exam,
Initial US Exam, CEAP VCSS, Multi Vessel Abl, Post Abl US, Venous Duplex DVT, Sclero,
Surface Laser, Hemorrhoid Tx, and the part of Post EVLT Comp Follow Up between Cardio and
the ultrasound section. Whether each of these is needed in V1 is still open.

The grey legacy row under the patient header (Home, Ext Demographics, Contact Info,
Insurance Info, Primary / Secondary / Tertiary Ins, Other Insured, Today's Charges,
General Note, Chart Status and CCR, Physicians, Interp Phys, LocationTab) is **not** part
of the new UI (Product Owner decision, 2026-09-25).

## Reports

The folder is `report-samples/`, not `reports/`: `.gitignore` blocks every `reports/` folder so real patient reports can never be committed. Keep it that way.

| File | What it shows |
| --- | --- |
| `report-samples/sclerotherapy-report-a.jpg` | Sclerotherapy report: Template 1 (short procedure report), leg diagram with injection points |
| `report-samples/sclerotherapy-report-b.jpg` | Sclerotherapy report, second patient, same template |
| `report-samples/template2-venous-evaluation-report.jpg` | Template 2 (Initial Venous Consultation / Vascular Evaluation), both pages. The diagrams came out blank in SonoSoft |
| `report-samples/initial-consultation-report.jpg` | Consultation report built from the Workup tabs above, with no ultrasound section |

What the reports show about SonoSoft:

- The narrative is assembled from the selected dropdown sentences. When a field is empty,
  the text comes out broken ("associated with  for many years", empty bullets, empty
  headings), and values are glued without spaces or commas ("polidocanolto", "andleg").
  The new report engine must not repeat this.
- Report dates are month/day ("9/22/2026"), while the Treatment Plan grid uses day/month.
  Use one unambiguous format.
- Sex and title come from separate fields in SonoSoft and contradicted each other on a
  real report. Derive them from the patient's sex.

## Product Owner decisions on marked printouts (2026-10-12)

Printed SonoSoft screens marked by hand (✓ = needed, X = not needed):

- **Physical Exam** — not needed in V1 (every field crossed; never part of Dawali).
- **CEAP VCSS** — not needed in V1 (whole screen crossed).
- **Assessment Plan+** — keep exactly as built (no change, including Stockings detail).
- **Initial US Exam** — needed, as a new tab. Keep: Right/Left Deep Vessels With Reflux
  (Common Femoral, Femoral, Popliteal); Right/Left GSV and SSV (Competent / Incompetent /
  Absent, size at the femoral / popliteal junction, size at knee, Tortuous, Reflux time /
  Rec. Time, Dist Ext of Reflux); Incompetent Accessories (anterior, posterior);
  Incompetent perforators (Thigh, Proximal Calf, Mid Calf, Distal Calf, Ankle) with the
  "There are no incompetent perforators seen in the right / left leg" statement;
  Add'l Measurements; Create Diagram; Add'l Findings 1–3; Impression; "There is NO evidence
  of DVT found during this examination"; Location / Extent of DVT, superficial
  thrombophlebitis or flow characteristics. Drop: Date of Service, Name of Exam, Add Charge,
  Leg Study, Tutorial, insurance guideline text, and the Branch Tributarie section
  (Group 1 / Group 2). Needs a clean screenshot before it is built.

Follow-up the same day (second set of marked printouts):

- **Rule:** nothing is removed from a tab that is already built (Subj Complaints Habits,
  Past Medical Hx, Assessment Plan+, Treatment Plan, ...), even where a printout crosses it
  out. Only new tabs or missing items are added.
- **Past Venous Hx** — needed, as a new tab: the twelve Venous History checkboxes
  (Phlebitis, DVT, Pulmonary Embolism, Bleeding from veins, Sclerotherapy, Sonogram, Prior
  Vein Surgery, Hemorrhoids, IV drug use, AIDS/HIV/Hepatitis, Previous Trauma, Clotting
  Disorder), Vein History Narrative and its sentences. Drop: Calculate Caprini Score, Tutorial.
- **Review of Systems** and **Vascular Findings** — not needed in V1 (crossed out; the only
  ticked item, Create Diagram, already exists in the visit's Diagrams section).
