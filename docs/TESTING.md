# Testing Strategy

This document lists product-level priorities. The mandatory engineering verification layers, evidence requirements, and failure testing are defined in `quality/VERIFICATION_STRATEGY.md`; system-wide rules are defined in `quality/SYSTEM_INVARIANTS.md`.
Risk-based testing to keep delivery fast.

High-priority automated tests:
- authentication
- permissions
- patient creation/search
- visit creation
- patient/visit separation
- clinical save/load
- audit log
- diagram save/versioning
- report generation
- correct patient/visit association
- finalized report versioning

Low priority: cosmetic spacing, static labels, broad snapshot tests.

Core target smoke flow:
Login → Search/Create Patient → Open/Create Visit → Patient Chart → Save clinical data → Create Diagram → Generate Report → Logout.

Passing this smoke flow alone is not sufficient for release. Apply the relevant invariant, authorization, concurrency, failure, security, migration, and recovery checks from `quality/VERIFICATION_STRATEGY.md`.
