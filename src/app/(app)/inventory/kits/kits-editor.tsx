"use client";

import { useState } from "react";
import { newMutationId } from "@/modules/clinical/autosave-client";
import { fill, type Dict } from "@/modules/inventory/i18n";
import type { KitView } from "@/modules/inventory/kits";
import { saveKitAction, type ActionResult } from "../actions";

interface Product {
  id: string;
  name: string;
  unit: string;
}
interface Draft {
  id: string;
  expectedUpdatedAt: string | null;
  name: string;
  isActive: boolean;
  items: { productId: string; quantity: string }[];
}

const toDraft = (k: KitView): Draft => ({
  id: k.id,
  expectedUpdatedAt: k.updatedAt,
  name: k.name,
  isActive: k.isActive,
  items: k.items.map((i) => ({ productId: i.productId, quantity: String(i.quantity) })),
});
const blank = (): Draft => ({ id: newMutationId(), expectedUpdatedAt: null, name: "", isActive: true, items: [{ productId: "", quantity: "1" }] });

function KitForm({ d, draft, set, products, busy, onSave, onCancel }: {
  d: Dict;
  draft: Draft;
  set: (p: Partial<Draft>) => void;
  products: Product[];
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const setItem = (i: number, p: Partial<Draft["items"][number]>) => set({ items: draft.items.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <div className="inv-kit-form" role="group" aria-label={draft.expectedUpdatedAt === null ? d.newKit : `${d.editKit} ${draft.name}`}>
      <div className="inv-row">
        <label>
          {d.kitName} <input aria-label={d.kitName} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          <input type="checkbox" checked={draft.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> {d.active}
        </label>
      </div>
      <table className="inv-table">
        <thead>
          <tr><th>{d.product}</th><th>{d.quantity}</th><th /></tr>
        </thead>
        <tbody>
          {draft.items.map((item, i) => {
            const unit = products.find((p) => p.id === item.productId)?.unit ?? "";
            return (
              <tr key={i}>
                <td>
                  <select aria-label={`${d.product} ${i + 1}`} value={item.productId} onChange={(e) => setItem(i, { productId: e.target.value })}>
                    <option value="">{d.chooseProduct}</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
                  </select>
                </td>
                <td className="inv-nowrap">
                  <input aria-label={`${d.quantity} ${i + 1}`} inputMode="decimal" size={5} value={item.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} /> {unit}
                </td>
                <td>
                  <button type="button" className="secondary" aria-label={`${d.removeKitItem} ${i + 1}`} disabled={draft.items.length === 1} onClick={() => set({ items: draft.items.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="inv-row">
        <button type="button" className="secondary" onClick={() => set({ items: [...draft.items, { productId: "", quantity: "1" }] })}>{d.addKitItem}</button>
        <button type="button" disabled={busy} onClick={onSave}>{d.save}</button>
        <button type="button" className="secondary" onClick={onCancel}>{d.cancel}</button>
      </div>
    </div>
  );
}

export function KitsEditor({ d, kits, products, canManage }: { d: Dict; kits: KitView[]; products: Product[]; canManage: boolean }) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!editing) return;
    setBusy(true);
    const r = await saveKitAction({
      id: editing.id,
      expectedUpdatedAt: editing.expectedUpdatedAt,
      name: editing.name,
      isActive: editing.isActive,
      items: editing.items.filter((i) => i.productId !== "").map((i) => ({ productId: i.productId, quantity: Number(i.quantity) })),
    });
    setBusy(false);
    setResult(r);
    if (r.ok) setEditing(null);
  }
  const set = (p: Partial<Draft>) => setEditing((e) => (e ? { ...e, ...p } : e));
  // A kit keeps a product that was made inactive later; it stays choosable there.
  const choices = (k: KitView | null) => [
    ...products,
    ...(k?.items ?? []).filter((i) => !products.some((p) => p.id === i.productId)).map((i) => ({ id: i.productId, name: i.productName, unit: i.unit })),
  ];
  const form = (k: KitView | null) =>
    editing ? <KitForm d={d} draft={editing} set={set} products={choices(k)} busy={busy} onSave={() => void save()} onCancel={() => setEditing(null)} /> : null;

  return (
    <>
      {canManage ? (
        <div className="inv-row">
          <button type="button" disabled={editing?.expectedUpdatedAt === null} onClick={() => { setResult(null); setEditing(blank()); }}>
            + {d.newKit}
          </button>
        </div>
      ) : null}
      {result ? <p className={result.ok ? "muted" : "inline-error"} role={result.ok ? "status" : "alert"}>{result.message}</p> : null}
      {editing?.expectedUpdatedAt === null ? form(null) : null}
      {kits.length === 0 ? <p className="muted">{d.noKits}</p> : null}
      <div className="inv-kits">
        {kits.map((k) =>
          editing?.id === k.id ? (
            <div key={k.id}>{form(k)}</div>
          ) : (
            <article key={k.id} className={`inv-kit${k.isActive ? "" : " muted"}`} aria-label={k.name}>
              <header className="inv-kit-head">
                <h3>{k.name}</h3>
                <span className="muted">{fill(d.kitItemCount, { n: k.items.length })}{k.isActive ? "" : ` — ${d.inactive}`}</span>
                {canManage ? (
                  <button type="button" className="secondary" aria-label={`${d.editKit} ${k.name}`} onClick={() => { setResult(null); setEditing(toDraft(k)); }}>
                    {d.editKit}
                  </button>
                ) : null}
              </header>
              <ul>
                {k.items.map((i) => <li key={i.productId}>{i.productName} — {i.quantity} {i.unit}</li>)}
              </ul>
            </article>
          ),
        )}
      </div>
    </>
  );
}
