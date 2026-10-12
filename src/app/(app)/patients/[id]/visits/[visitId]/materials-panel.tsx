"use client";

import { useState } from "react";
import { consumeAction, type ActionResult } from "@/app/(app)/inventory/actions";
import { newMutationId } from "@/modules/clinical/autosave-client";

interface BatchOption {
  warehouseId: string;
  warehouseName: string;
  batchId: string;
  label: string;
  /** Past its expiry date: listed in red, never selectable (the server refuses it too). */
  expired: boolean;
  /** dd/mm/yyyy, or "no expiry". */
  expiry: string;
  /** Days to expiry when within the warning period, else null. */
  expiresInDays: number | null;
}

const keyOf = (b: BatchOption) => `${b.warehouseId}:${b.batchId}`;
const expiresText = (days: number) => (days === 0 ? "expires today" : days === 1 ? "expires tomorrow" : `expires in ${days} days`);

/**
 * Materials used on this visit (I1, ADR-035): the nurse picks the store's
 * batch (earliest expiry first), the quantity and the treating doctor. The
 * item is charged to the patient and the doctor and taken off the stock.
 */
export function MaterialsPanel(props: {
  visitId: string;
  path: string;
  batches: BatchOption[];
  doctors: { id: string; name: string }[];
  defaultDoctorId: string | null;
  canRecord: boolean;
  used: { id: string; text: string }[];
}) {
  const usable = props.batches.filter((b) => !b.expired);
  const expiredCount = props.batches.length - usable.length;
  const [batchKey, setBatchKey] = useState(usable[0] ? keyOf(usable[0]) : "");
  const [quantity, setQuantity] = useState("1");
  const [doctorId, setDoctorId] = useState(props.defaultDoctorId ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const chosen = usable.find((b) => keyOf(b) === batchKey);

  return (
    <section className="card diagrams-panel" aria-label="Materials used">
      <h3>Materials used</h3>
      {props.canRecord ? (
        props.batches.length === 0 ? (
          <p className="muted">No stock available to record.</p>
        ) : (
          <>
          <div className="inv-row">
            <select aria-label="Item and batch" value={batchKey} onChange={(e) => setBatchKey(e.target.value)}>
              {usable.length === 0 ? <option value="">No usable stock</option> : null}
              {props.batches.map((b) => (
                <option key={keyOf(b)} value={keyOf(b)} disabled={b.expired} className={b.expired ? "inv-option-expired" : undefined}>
                  {b.expired ? "EXPIRED — " : ""}
                  {b.warehouseName}: {b.label}
                  {b.expiresInDays !== null ? ` ⚠ ${expiresText(b.expiresInDays)}` : ""}
                </option>
              ))}
            </select>
            <input aria-label="Quantity used" inputMode="decimal" size={5} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            <select aria-label="Doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
              <option value="">Doctor…</option>
              {props.doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !chosen || !doctorId}
              onClick={async () => {
                if (!chosen) return;
                setBusy(true);
                setResult(
                  await consumeAction(
                    {
                      clientMutationId: newMutationId(),
                      visitId: props.visitId,
                      warehouseId: chosen.warehouseId,
                      batchId: chosen.batchId,
                      doctorId,
                      quantity: Number(quantity),
                    },
                    props.path,
                  ),
                );
                setBusy(false);
              }}
            >
              Record
            </button>
          </div>
          {chosen && chosen.expiresInDays !== null ? (
            <p className="inv-use-warning" role="status">
              ⚠ This batch {expiresText(chosen.expiresInDays)} ({chosen.expiry}). Check the date on the box before use.
            </p>
          ) : null}
          {expiredCount > 0 ? (
            <p className="inv-use-expired" role="note">
              {expiredCount} expired {expiredCount === 1 ? "batch is" : "batches are"} in stock and cannot be used — tell the storekeeper to remove {expiredCount === 1 ? "it" : "them"}.
            </p>
          ) : null}
          </>
        )
      ) : null}
      {result ? (
        <p className={result.ok ? "muted" : "inline-error"} role={result.ok ? "status" : "alert"}>
          {result.message}
        </p>
      ) : null}
      {props.used.length === 0 ? (
        <p className="muted">Nothing recorded for this visit.</p>
      ) : (
        <ul>
          {props.used.map((u) => (
            <li key={u.id}>{u.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
