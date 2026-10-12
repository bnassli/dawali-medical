"use client";

import { useState } from "react";
import { issueKitAction, type ActionResult } from "@/app/(app)/inventory/actions";
import { newMutationId } from "@/modules/clinical/autosave-client";
import { allocateFefo, daysUntil, USE_WARNING_DAYS } from "@/modules/inventory/fefo";

export interface KitOption {
  id: string;
  name: string;
  items: { productId: string; productName: string; unit: string; quantity: number }[];
}
export interface StockBatch {
  warehouseId: string;
  productId: string;
  batchId: string;
  lotNumber: string;
  /** ISO yyyy-mm-dd or null. */
  expiryDate: string | null;
  quantity: number;
}

const dmy = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "no expiry");

/**
 * I4 (ADR-042): record a procedure kit in one step. The quantities start from
 * the kit and can be changed (or a line removed) for this case; each line
 * shows the batches it will be taken from — earliest expiry first, never an
 * expired batch — the same rule the server applies when it records.
 */
export function KitSection(props: {
  visitId: string;
  path: string;
  kits: KitOption[];
  stores: { id: string; name: string }[];
  stock: StockBatch[];
  today: string;
  doctorId: string;
}) {
  const [kitId, setKitId] = useState("");
  const [storeId, setStoreId] = useState(props.stores[0]?.id ?? "");
  const [lines, setLines] = useState<{ productId: string; productName: string; unit: string; quantity: string }[]>([]);
  const [mutationId, setMutationId] = useState(newMutationId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  function chooseKit(id: string) {
    setKitId(id);
    setResult(null);
    setMutationId(newMutationId());
    const kit = props.kits.find((k) => k.id === id);
    setLines(kit ? kit.items.map((i) => ({ ...i, quantity: String(i.quantity) })) : []);
  }

  const plan = lines.map((l) => {
    const q = Number(l.quantity);
    const valid = l.quantity.trim() !== "" && Number.isFinite(q) && q > 0;
    const batches = props.stock.filter((b) => b.warehouseId === storeId && b.productId === l.productId);
    const { takes, short } = valid ? allocateFefo(batches, q, props.today) : { takes: [], short: 0 };
    return {
      ...l,
      valid,
      short,
      from: takes.map((t) => {
        const b = batches.find((x) => x.batchId === t.batchId)!;
        const left = b.expiryDate === null ? null : daysUntil(b.expiryDate, props.today);
        const warn = left !== null && left <= USE_WARNING_DAYS ? ` ⚠ expires in ${left} ${left === 1 ? "day" : "days"}` : "";
        return `lot ${b.lotNumber || "—"} (exp ${dmy(b.expiryDate)}) × ${t.quantity}${warn}`;
      }),
    };
  });
  const ready = plan.length > 0 && plan.every((p) => p.valid && p.short === 0) && props.doctorId !== "";

  async function record() {
    setBusy(true);
    const r = await issueKitAction(
      {
        clientMutationId: mutationId,
        visitId: props.visitId,
        warehouseId: storeId,
        doctorId: props.doctorId,
        kitId,
        items: plan.map((p) => ({ productId: p.productId, quantity: Number(p.quantity) })),
      },
      props.path,
    );
    setBusy(false);
    setResult(r);
    if (r.ok) {
      setKitId("");
      setLines([]);
    }
  }

  return (
    <div className="inv-kit-use" role="group" aria-label="Record a procedure kit">
      <h4>Procedure kit</h4>
      <div className="inv-row">
        <select aria-label="Procedure kit" value={kitId} onChange={(e) => chooseKit(e.target.value)}>
          <option value="">Procedure kit…</option>
          {props.kits.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
        {kitId ? (
          <select aria-label="Kit store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {props.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : null}
      </div>
      {kitId ? (
        <>
          <table className="inv-table" aria-label="Kit items">
            <thead>
              <tr><th>Item</th><th>Quantity</th><th>Taken from (earliest expiry first)</th><th /></tr>
            </thead>
            <tbody>
              {plan.map((p, i) => (
                <tr key={p.productId} className={p.valid && p.short === 0 ? undefined : "inv-expired"}>
                  <td>{p.productName}</td>
                  <td className="inv-nowrap">
                    <input
                      aria-label={`Kit quantity ${p.productName}`}
                      inputMode="decimal"
                      size={5}
                      value={p.quantity}
                      onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)))}
                    />{" "}
                    {p.unit}
                  </td>
                  <td>
                    {!p.valid
                      ? "Type a quantity above 0."
                      : p.short > 0
                        ? `Not enough usable stock in this store (${p.short} ${p.unit} missing).`
                        : p.from.join(", ")}
                  </td>
                  <td>
                    <button type="button" className="secondary" aria-label={`Remove ${p.productName} from this record`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="inv-row">
            <button type="button" disabled={busy || !ready} onClick={() => void record()}>
              Record kit ({plan.length} {plan.length === 1 ? "item" : "items"})
            </button>
            {props.doctorId === "" ? <span className="muted">Choose the doctor first.</span> : null}
          </div>
        </>
      ) : null}
      {result ? (
        <p className={result.ok ? "muted" : "inline-error"} role={result.ok ? "status" : "alert"}>
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
