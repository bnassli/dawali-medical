"use client";

import { useState } from "react";
import { newMutationId } from "@/modules/clinical/autosave-client";
import type { CountSheet } from "@/modules/inventory/catalog";
import type { Dict } from "@/modules/inventory/i18n";
import { stockCountAction, type ActionResult } from "../actions";

interface NewLine {
  productName: string;
  unit: string;
  lotNumber: string;
  expiryDate: string;
  counted: string;
}
const emptyNew = (productName = "", unit = ""): NewLine => ({ productName, unit, lotNumber: "", expiryDate: "", counted: "" });
const num = (s: string) => (s.trim() === "" ? null : Number(s));
const show = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function StocktakeForm({ d, warehouseId, sheet }: { d: Dict; warehouseId: string; sheet: CountSheet }) {
  const [counted, setCounted] = useState<Record<string, string>>({});
  // Products with nothing in this store are counted as new lines (lot and expiry from the box).
  const [lines, setLines] = useState<NewLine[]>(() => sheet.emptyProducts.map((p) => emptyNew(p.name, p.unit)));
  const [notes, setNotes] = useState("");
  const [countId, setCountId] = useState(newMutationId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const knownUnits = new Map([...sheet.batches, ...sheet.emptyProducts].map((p) => ["productName" in p ? p.productName : p.name, p.unit]));

  const setLine = (i: number, p: Partial<NewLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  async function post() {
    const payload = [
      ...sheet.batches.flatMap((b) => {
        const c = num(counted[b.batchId] ?? "");
        return c === null ? [] : [{ batchId: b.batchId, productName: "", unit: "", lotNumber: "", expiryDate: null, countedQuantity: c }];
      }),
      ...lines.flatMap((l) => {
        const c = num(l.counted);
        return c === null
          ? []
          : [{ batchId: null, productName: l.productName, unit: l.unit, lotNumber: l.lotNumber, expiryDate: l.expiryDate || null, countedQuantity: c }];
      }),
    ];
    if (payload.length === 0) return setResult({ ok: false, message: d.countEmpty });
    setBusy(true);
    const r = await stockCountAction({ countId, warehouseId, notes, lines: payload });
    setBusy(false);
    setResult(r);
    if (r.ok) {
      setCounted({});
      setLines([]);
      setNotes("");
      setCountId(newMutationId());
    }
  }

  return (
    <>
      <datalist id="count-products">
        {[...knownUnits.keys()].map((n) => <option key={n} value={n} />)}
      </datalist>
      <table className="inv-table inv-count">
        <thead>
          <tr>
            <th>{d.product}</th><th>{d.lot}</th><th>{d.expiry}</th><th>{d.systemQty}</th><th>{d.countedQty}</th><th>{d.difference}</th>
          </tr>
        </thead>
        <tbody>
          {sheet.batches.map((b) => {
            const c = num(counted[b.batchId] ?? "");
            const diff = c === null ? null : Math.round((c - b.quantity) * 100) / 100;
            return (
              <tr key={b.batchId}>
                <td>{b.productName}</td>
                <td>{b.lotNumber || d.none}</td>
                <td>{b.expiryDate ? b.expiryDate.split("-").reverse().join("/") : d.none}</td>
                <td><span className="inv-q">{show(b.quantity)} {b.unit}</span></td>
                <td>
                  <input
                    aria-label={`${d.countedQty} ${b.productName} ${b.lotNumber}`}
                    inputMode="decimal"
                    size={6}
                    value={counted[b.batchId] ?? ""}
                    onChange={(e) => setCounted((m) => ({ ...m, [b.batchId]: e.target.value }))}
                  />
                </td>
                <td dir="ltr" className={diff === null || diff === 0 ? undefined : diff < 0 ? "inv-neg" : "inv-pos"}>
                  {diff === null ? "" : `${diff > 0 ? "+" : ""}${show(diff)}`}
                </td>
              </tr>
            );
          })}
          {lines.map((l, i) => (
            <tr key={`new-${i}`} className="inv-editing">
              <td>
                <input aria-label={`${d.product} ${d.newLine} ${i + 1}`} list="count-products" value={l.productName} onChange={(e) => setLine(i, { productName: e.target.value, unit: knownUnits.get(e.target.value) ?? l.unit })} />{" "}
                <input aria-label={`${d.unit} ${d.newLine} ${i + 1}`} placeholder={d.unit} size={6} value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} />
              </td>
              <td><input aria-label={`${d.lot} ${d.newLine} ${i + 1}`} size={8} value={l.lotNumber} onChange={(e) => setLine(i, { lotNumber: e.target.value })} /></td>
              <td><input aria-label={`${d.expiry} ${d.newLine} ${i + 1}`} type="date" value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} /></td>
              <td>0</td>
              <td><input aria-label={`${d.countedQty} ${d.newLine} ${i + 1}`} inputMode="decimal" size={6} value={l.counted} onChange={(e) => setLine(i, { counted: e.target.value })} /></td>
              <td>
                <button type="button" className="secondary" aria-label={`${d.removeLine} ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="inv-row">
        <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, emptyNew()])}>{d.addCountLine}</button>
      </div>
      <div className="inv-row">
        <label>
          {d.notes} <input size={40} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button type="button" disabled={busy} onClick={() => void post()}>{d.postCount}</button>
      </div>
      {result ? <p className={result.ok ? "muted" : "inline-error"} role={result.ok ? "status" : "alert"}>{result.message}</p> : null}
    </>
  );
}
