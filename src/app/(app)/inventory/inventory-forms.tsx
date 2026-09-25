"use client";

import { useState } from "react";
import type { ExtractedInvoice } from "@/db/schema";
import { newMutationId } from "@/modules/clinical/autosave-client";
import { adjustAction, receiveAction, scanInvoiceAction, transferAction, type ActionResult } from "./actions";

interface Warehouse {
  id: string;
  name: string;
}
interface Line {
  productName: string;
  unit: string;
  lotNumber: string;
  expiryDate: string;
  quantity: string;
  packSize: string;
  unitCost: string;
}
const emptyLine = (): Line => ({ productName: "", unit: "", lotNumber: "", expiryDate: "", quantity: "", packSize: "1", unitCost: "" });

function Result({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p className={result.ok ? "muted" : "inline-error"} role={result.ok ? "status" : "alert"}>
      {result.message}
    </p>
  );
}

/**
 * Scan -> AI draft -> review -> Confirm (I1, ADR-035). Nothing is added to the
 * stock until the reviewed form is confirmed; every value stays editable.
 */
export function ReceiveInvoice({ warehouses, products }: { warehouses: Warehouse[]; products: { name: string; unit: string }[] }) {
  const [scanId, setScanId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [head, setHead] = useState({ warehouseId: warehouses[0]?.id ?? "", supplierName: "", invoiceNumber: "", invoiceDate: "" });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [receiptId, setReceiptId] = useState(newMutationId);

  function load(x: ExtractedInvoice) {
    setHead((h) => ({ ...h, supplierName: x.supplierName ?? "", invoiceNumber: x.invoiceNumber ?? "", invoiceDate: x.invoiceDate ?? "" }));
    setLines(
      x.lines.length === 0
        ? [emptyLine()]
        : x.lines.map((l) => ({
            productName: l.productName,
            // The stock unit of a known product; a pack description ("box of 5") is not a unit.
            unit: products.find((p) => p.name.toLowerCase() === l.productName.toLowerCase())?.unit ?? "",
            lotNumber: l.lotNumber ?? "",
            expiryDate: l.expiryDate ?? "",
            quantity: l.quantity === null ? "" : String(l.quantity),
            packSize: l.packSize === null ? "1" : String(l.packSize),
            unitCost: l.unitCost === null ? "" : String(l.unitCost),
          })),
    );
  }

  async function scan(form: HTMLFormElement) {
    setBusy(true);
    setResult(null);
    const r = await scanInvoiceAction(new FormData(form));
    setBusy(false);
    if (!r.ok) return setNote(r.message);
    if (r.extracted && r.extracted.documentType !== "invoice") {
      setScanId(null);
      return setNote(
        r.extracted.documentType === "statement"
          ? "This is a statement of account, not an invoice — nothing to receive. Scan the invoices themselves."
          : "This document does not look like a purchase invoice — nothing to receive.",
      );
    }
    setScanId(r.scanId);
    if (r.extracted) load(r.extracted);
    setNote(
      r.error ??
        "Read by AI — check every value against the paper invoice, and add lot and expiry from the boxes, before confirming.",
    );
  }

  async function confirm() {
    setBusy(true);
    const r = await receiveAction({
      receiptId,
      scanId,
      warehouseId: head.warehouseId,
      supplierName: head.supplierName,
      invoiceNumber: head.invoiceNumber,
      invoiceDate: head.invoiceDate,
      lines: lines.map((l) => ({
        productName: l.productName,
        unit: l.unit,
        lotNumber: l.lotNumber,
        expiryDate: l.expiryDate || null,
        quantity: Number(l.quantity),
        packSize: Number(l.packSize),
        unitCost: l.unitCost === "" ? null : Number(l.unitCost),
      })),
    });
    setBusy(false);
    setResult(r);
    if (r.ok) {
      setScanId(null);
      setNote(null);
      setLines([emptyLine()]);
      setHead((h) => ({ ...h, supplierName: "", invoiceNumber: "", invoiceDate: "" }));
      setReceiptId(newMutationId());
    }
  }

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <section className="card" aria-label="Receive invoice">
      <h3>Receive purchase invoice</h3>
      <form
        className="inv-row"
        onSubmit={(e) => {
          e.preventDefault();
          void scan(e.currentTarget);
        }}
      >
        <label>
          Scanned invoice (JPG, PNG or PDF){" "}
          <input type="file" name="scan" accept="image/jpeg,image/png,image/webp,application/pdf" required />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Reading…" : "Scan and read with AI"}
        </button>
      </form>
      {note ? <p className="muted" role="status">{note}</p> : null}

      <div className="inv-row">
        <label>
          Store{" "}
          <select value={head.warehouseId} onChange={(e) => setHead({ ...head, warehouseId: e.target.value })}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Supplier <input value={head.supplierName} onChange={(e) => setHead({ ...head, supplierName: e.target.value })} />
        </label>
        <label>
          Invoice number <input value={head.invoiceNumber} onChange={(e) => setHead({ ...head, invoiceNumber: e.target.value })} />
        </label>
        <label>
          Invoice date <input type="date" value={head.invoiceDate} onChange={(e) => setHead({ ...head, invoiceDate: e.target.value })} />
        </label>
      </div>
      <datalist id="inv-products">
        {products.map((p) => (
          <option key={p.name} value={p.name} />
        ))}
      </datalist>
      <table className="inv-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Stock unit</th>
            <th>Lot</th>
            <th>Expiry</th>
            <th>Packs</th>
            <th>Units / pack</th>
            <th>Pack price (ex VAT)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><input aria-label={`Product ${i + 1}`} list="inv-products" value={l.productName} onChange={(e) => setLine(i, { productName: e.target.value })} /></td>
              <td><input aria-label={`Unit ${i + 1}`} value={l.unit} size={6} onChange={(e) => setLine(i, { unit: e.target.value })} /></td>
              <td><input aria-label={`Lot ${i + 1}`} value={l.lotNumber} size={8} onChange={(e) => setLine(i, { lotNumber: e.target.value })} /></td>
              <td><input aria-label={`Expiry ${i + 1}`} type="date" value={l.expiryDate} onChange={(e) => setLine(i, { expiryDate: e.target.value })} /></td>
              <td><input aria-label={`Quantity ${i + 1}`} inputMode="decimal" size={6} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
              <td><input aria-label={`Units per pack ${i + 1}`} inputMode="decimal" size={4} value={l.packSize} onChange={(e) => setLine(i, { packSize: e.target.value })} /></td>
              <td><input aria-label={`Unit cost ${i + 1}`} inputMode="decimal" size={7} value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} /></td>
              <td>
                <button type="button" className="secondary" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="inv-row">
        <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
          + Add line
        </button>
        <button type="button" disabled={busy} onClick={() => void confirm()}>
          Confirm and add to stock
        </button>
      </div>
      <Result result={result} />
    </section>
  );
}

export function AdjustForm({ warehouses }: { warehouses: Warehouse[] }) {
  const [f, setF] = useState({ warehouseId: warehouses[0]?.id ?? "", productName: "", unit: "", lotNumber: "", expiryDate: "", quantity: "", reason: "Opening balance" });
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <section className="card" aria-label="Opening balance / adjustment">
      <h3>Opening balance / stock count</h3>
      <p className="muted">Positive to add, negative to remove (with a reason).</p>
      <div className="inv-row">
        <select aria-label="Store" value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <input aria-label="Adjust product" placeholder="Product" list="inv-products" value={f.productName} onChange={(e) => setF({ ...f, productName: e.target.value })} />
        <input aria-label="Adjust unit" placeholder="Unit" size={6} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
        <input aria-label="Adjust lot" placeholder="Lot" size={8} value={f.lotNumber} onChange={(e) => setF({ ...f, lotNumber: e.target.value })} />
        <input aria-label="Adjust expiry" type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
        <input aria-label="Adjust quantity" placeholder="± Qty" size={6} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
        <input aria-label="Reason" size={18} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <button
          type="button"
          onClick={async () =>
            setResult(
              await adjustAction({
                clientMutationId: newMutationId(),
                warehouseId: f.warehouseId,
                productName: f.productName,
                unit: f.unit,
                lotNumber: f.lotNumber,
                expiryDate: f.expiryDate || null,
                quantity: Number(f.quantity),
                reason: f.reason,
              }),
            )
          }
        >
          Save adjustment
        </button>
      </div>
      <Result result={result} />
    </section>
  );
}

export function TransferForm({ warehouses, batches }: { warehouses: Warehouse[]; batches: { key: string; warehouseId: string; batchId: string; label: string }[] }) {
  const [sel, setSel] = useState(batches[0]?.key ?? "");
  const [to, setTo] = useState("");
  const [quantity, setQuantity] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const chosen = batches.find((b) => b.key === sel);
  return (
    <section className="card" aria-label="Transfer between stores">
      <h3>Transfer between stores</h3>
      <div className="inv-row">
        <select aria-label="Batch to transfer" value={sel} onChange={(e) => setSel(e.target.value)}>
          {batches.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        <select aria-label="To store" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">To store…</option>
          {warehouses.filter((w) => w.id !== chosen?.warehouseId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <input aria-label="Transfer quantity" placeholder="Qty" size={6} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <button
          type="button"
          disabled={!chosen || !to}
          onClick={async () =>
            chosen &&
            setResult(
              await transferAction({
                clientMutationId: newMutationId(),
                fromWarehouseId: chosen.warehouseId,
                toWarehouseId: to,
                batchId: chosen.batchId,
                quantity: Number(quantity),
              }),
            )
          }
        >
          Transfer
        </button>
      </div>
      <Result result={result} />
    </section>
  );
}
