# iCare Integration
Treat iCare as an external system.

iCare → Connector/Adapter → Patient matching → Internal Patient UUID

Never use iCare patient/file number as this application's PK.
Prefer read-only integration initially.
Log sync outcomes.
Prevent duplicates with deterministic matching and manual resolution for ambiguity.
Possible future modes: API, DB read-only, scheduled import, manual lookup/sync.

The iCare file number is the "File / Medical ID" shown to users (ADR-028): stored as the
`ICARE_FILE_NO` external id, unique, manually editable now, and the row a future sync writes.
There is no competing clinic file number.
