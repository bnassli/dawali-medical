"use client";

import { useState } from "react";
import type { CatalogProduct } from "@/modules/inventory/catalog";
import type { Dict } from "@/modules/inventory/i18n";
import { saveProductAction, type ActionResult } from "../actions";

interface Draft {
  id: string | null;
  name: string;
  unit: string;
  category: string;
  minLevel: string;
  barcode: string;
  isActive: boolean;
}

const blank: Draft = { id: null, name: "", unit: "", category: "", minLevel: "", barcode: "", isActive: true };
const toDraft = (p: CatalogProduct): Draft => ({
  id: p.id,
  name: p.name,
  unit: p.unit,
  category: p.category ?? "",
  minLevel: p.minLevel === null ? "" : String(p.minLevel),
  barcode: p.barcode ?? "",
  isActive: p.isActive,
});

function Fields({ d, v, set, unitLocked }: { d: Dict; v: Draft; set: (p: Partial<Draft>) => void; unitLocked: boolean }) {
  return (
    <>
      <td><input aria-label={d.product} value={v.name} onChange={(e) => set({ name: e.target.value })} /></td>
      <td>
        <input aria-label={d.unit} size={7} value={v.unit} disabled={unitLocked} title={unitLocked ? d.unitLockedHint : undefined} onChange={(e) => set({ unit: e.target.value })} />
      </td>
      <td><input aria-label={d.category} size={10} value={v.category} onChange={(e) => set({ category: e.target.value })} /></td>
      <td><input aria-label={d.minLevel} size={5} inputMode="decimal" value={v.minLevel} onChange={(e) => set({ minLevel: e.target.value })} /></td>
      <td><input aria-label={d.barcode} size={12} value={v.barcode} onChange={(e) => set({ barcode: e.target.value })} /></td>
      <td><input aria-label={d.active} type="checkbox" checked={v.isActive} onChange={(e) => set({ isActive: e.target.checked })} /></td>
    </>
  );
}

export function ProductsEditor({ d, products, canManage }: { d: Dict; products: CatalogProduct[]; canManage: boolean }) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  async function save() {
    if (!editing) return;
    setBusy(true);
    const r = await saveProductAction({
      id: editing.id,
      name: editing.name,
      unit: editing.unit,
      category: editing.category,
      minLevel: editing.minLevel.trim() === "" ? null : Number(editing.minLevel),
      barcode: editing.barcode,
      isActive: editing.isActive,
    });
    setBusy(false);
    setResult(r);
    if (r.ok) setEditing(null);
  }

  const set = (p: Partial<Draft>) => setEditing((e) => (e ? { ...e, ...p } : e));
  const needle = filter.trim().toLowerCase();
  const shown = products.filter((p) => !needle || [p.name, p.category ?? "", p.barcode ?? ""].some((v) => v.toLowerCase().includes(needle)));
  const actions = (
    <td className="inv-nowrap">
      <button type="button" disabled={busy} onClick={() => void save()}>{d.save}</button>{" "}
      <button type="button" className="secondary" onClick={() => setEditing(null)}>{d.cancel}</button>
    </td>
  );

  return (
    <>
      <div className="inv-row">
        <input type="search" aria-label={d.search} placeholder={d.searchPlaceholder} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {canManage ? (
          <button type="button" disabled={editing?.id === null} onClick={() => { setResult(null); setEditing({ ...blank }); }}>
            + {d.newProduct}
          </button>
        ) : null}
      </div>
      {result ? <p className={result.ok ? "muted" : "inline-error"} role={result.ok ? "status" : "alert"}>{result.message}</p> : null}
      <table className="inv-table">
        <thead>
          <tr>
            <th>{d.product}</th><th>{d.unit}</th><th>{d.category}</th><th>{d.minLevel}</th><th>{d.barcode}</th><th>{d.active}</th>
            {canManage ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {editing?.id === null ? (
            <tr className="inv-editing" aria-label={d.newProduct}>
              <Fields d={d} v={editing} set={set} unitLocked={false} />
              {actions}
            </tr>
          ) : null}
          {shown.map((p) =>
            editing?.id === p.id ? (
              <tr key={p.id} className="inv-editing">
                <Fields d={d} v={editing} set={set} unitLocked={p.hasMovements} />
                {actions}
              </tr>
            ) : (
              <tr key={p.id} className={p.isActive ? undefined : "muted"}>
                <td>{p.name}</td>
                <td>{p.unit}</td>
                <td>{p.category ?? d.none}</td>
                <td>{p.minLevel ?? d.none}</td>
                <td dir="ltr">{p.barcode ?? d.none}</td>
                <td>{p.isActive ? "✓" : d.inactive}</td>
                {canManage ? (
                  <td>
                    <button type="button" className="secondary" aria-label={`${d.editProduct} ${p.name}`} onClick={() => { setResult(null); setEditing(toDraft(p)); }}>
                      {d.editProduct}
                    </button>
                  </td>
                ) : null}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </>
  );
}
