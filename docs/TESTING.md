# Testing Strategy
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
