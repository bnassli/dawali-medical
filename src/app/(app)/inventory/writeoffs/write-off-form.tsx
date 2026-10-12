"use client";

import { useState } from "react";
import { WRITE_OFF_REASONS, type WriteOffKind, type WriteOffReason } from "@/modules/inventory/write-off-kinds";
import { newMutationId } from "@/modules/clinical/autosave-client";
import type { Dict, DictKey } from "@/modules/inventory/i18n";
import { writeOffAction, type ActionResult } from "../actions";

interface Batch {
  warehouseId: string;
  batchId: string;
  label: string;
  unit: string;
  quantity: number;
  expired: boolean;
  /** The supplier it was last received from, suggested for a return. */
  supplierId: string | null;
}
interface Line {
  batchId: string;
  quantity: string;
}

const show = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** I5 (ADR-043): one return / disposal document — store, reason, batches; all or nothing. */
export function WriteOffForm({ d, warehouses, suppliers, batches }: {
  d: Dict;
  warehouses: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
  batches: Batch[];
}) {
  const [docId, setDocId] = useState(newMutationId);
  const [kind, setKind] = useState<WriteOffKind>("disposal");
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [supplierId, setSupplierId] = useState("");
  // Until the user picks a supplier, a return suggests the one the chosen batch came from.
  const [supplierChosen, setSupplierChosen] = useState(false);
  const [reason, setReason] = useState<WriteOffReason>("expired");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ batchId: "", quantity: "" }]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  const here = batches.filter((b) => b.warehouseId === warehouseId);
  const byId = (id: string) => here.find((b) => b.batchId === id);
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const suggestSupplier = (batchId: string) => {
    if (!supplierChosen) setSupplierId(byId(batchId)?.supplierId ?? "");
  };

  function addExpired() {
    const expired = here.filter((b) => b.expired && !lines.some((l) => l.batchId === b.batchId));
    if (expired.length === 0) return setResult({ ok: false, message: d.woNoExpired });
    setResult(null);
    setReason("expired");
    setLines((ls) => [...ls.filter((l) => l.batchId !== ""), ...expired.map((b) => ({ batchId: b.batchId, quantity: show(b.quantity) }))]);
  }

  async function post() {
    setBusy(true);
    const r = await writeOffAction({
      id: docId,
      kind,
      warehouseId,
      supplierId: kind === "supplier_return" && supplierId ? supplierId : null,
      reason,
      reference,
      notes,
      lines: lines.filter((l) => l.batchId !== "").map((l) => ({ batchId: l.batchId, quantity: Number(l.quantity) })),
    });
    setBusy(false);
    setResult(r);
    if (r.ok) {
      setLines([{ batchId: "", quantity: "" }]);
      setReference("");
      setNotes("");
      setSupplierId("");
      setSupplierChosen(false);
      setDocId(newMutationId());
    }
  }

  return (
    <>
      <div className="inv-row">
        <label>
          {d.woKind}{" "}
          <select
            aria-label={d.woKind}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as WriteOffKind);
              const first = lines.find((l) => l.batchId !== "");
              if (first) suggestSupplier(first.batchId);
            }}
          >
            <option value="disposal">{d.kind_disposal}</option>
            <option value="supplier_return">{d.kind_supplier_return}</option>
          </select>
        </label>
        <label>
          {d.store}{" "}
          <select aria-label={d.store} value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLines([{ batchId: "", quantity: "" }]); }}>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <label>
          {d.woReason}{" "}
          <select aria-label={d.woReason} value={reason} onChange={(e) => setReason(e.target.value as WriteOffReason)}>
            {WRITE_OFF_REASONS.map((r) => <option key={r} value={r}>{d[`reason_${r}` as DictKey]}</option>)}
          </select>
        </label>
        {kind === "supplier_return" ? (
          <label>
            {d.supplier}{" "}
            <select aria-label={d.supplier} value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setSupplierChosen(true); }}>
              <option value="">{d.chooseSupplier}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        ) : null}
        <label>
          {d.woReference} <input aria-label={d.woReference} size={12} value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
      </div>
      <table className="inv-table inv-wo-lines">
        <thead>
          <tr><th>{d.woBatch}</th><th>{d.quantity}</th><th /></tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const b = byId(l.batchId);
            return (
              <tr key={i} className={b?.expired ? "inv-expired" : undefined}>
                <td>
                  <select aria-label={`${d.woBatch} ${i + 1}`} value={l.batchId} onChange={(e) => { setLine(i, { batchId: e.target.value, quantity: l.quantity || show(byId(e.target.value)?.quantity ?? 0) }); suggestSupplier(e.target.value); }}>
                    <option value="">{d.woChooseBatch}</option>
                    {here.map((x) => (
                      <option key={x.batchId} value={x.batchId} disabled={lines.some((o, j) => j !== i && o.batchId === x.batchId)}>
                        {x.expired ? `${d.expired} — ` : ""}{x.label} ({show(x.quantity)} {x.unit})
                      </option>
                    ))}
                  </select>
                </td>
                <td className="inv-nowrap">
                  <input aria-label={`${d.quantity} ${i + 1}`} inputMode="decimal" size={6} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />{" "}
                  {b ? <>{d.woOf} <bdi className="inv-q">{show(b.quantity)} {b.unit}</bdi></> : null}
                </td>
                <td>
                  <button type="button" className="secondary" aria-label={`${d.removeLine} ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="inv-row">
        <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, { batchId: "", quantity: "" }])}>{d.addLine}</button>
        <button type="button" className="secondary" onClick={addExpired}>{d.woAddExpired}</button>
      </div>
      <div className="inv-row">
        <label>
          {d.notes} <input aria-label={d.notes} size={40} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button type="button" disabled={busy || lines.every((l) => l.batchId === "")} onClick={() => void post()}>{d.woPost}</button>
      </div>
      {result ? <p className={result.ok ? "muted" : "inline-error"} role={result.ok ? "status" : "alert"}>{result.message}</p> : null}
    </>
  );
}
