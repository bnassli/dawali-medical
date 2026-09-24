# Future Inventory
Not part of Sprint 1.

Capabilities: products, categories, suppliers, purchase invoices, manual receipt, scanned invoice upload, OCR/AI extraction, human confirmation before posting, lots/batches, expiry dates, stock movements, adjustments, consumption by procedure/doctor/patient.

Expiry belongs to batch/lot, not product.

AI flow:
Scan/PDF → AI/OCR → Draft invoice → Human review → Confirm → Stock receipt.

Procedure consumption:
Patient → Visit → Procedure → Doctor → Consumed Items → Batch/Lot → Stock movement.

Support FEFO later.
