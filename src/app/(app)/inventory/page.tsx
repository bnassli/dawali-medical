import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { consumptionBetween, listProducts, listWarehouses, stockLevels } from "@/modules/inventory/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { AdjustForm, ReceiveInvoice, TransferForm } from "./inventory-forms";

const EXPIRY_WARNING_DAYS = 60;

/** Request time (kept out of the component body: rendering must stay pure). */
function requestTime(): number {
  return Date.now();
}

function fmt(iso: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Inventory I1 (ADR-035): stock by store and batch, receiving, adjustments, transfers, usage. */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const actor = await requireActor();
  if (!actor.permissions.has(PERMISSIONS.INVENTORY_READ)) notFound();
  const canManage = actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE);
  // The storekeeper sees totals by doctor, but patient names only with patient access.
  const canSeePatients = actor.permissions.has(PERMISSIONS.PATIENT_READ);
  const db = getDb();
  const warehouses = await listWarehouses(db, actor);
  const { store } = await searchParams;
  const current = warehouses.find((w) => w.id === store) ?? warehouses[0];
  const stock = await stockLevels(db, actor, current?.id);
  const allStock = canManage ? await stockLevels(db, actor) : [];
  const products = canManage ? await listProducts(db, actor) : [];
  const now = requestTime();
  const soon = new Date(now + EXPIRY_WARNING_DAYS * 86_400_000).toISOString().slice(0, 10);
  const usage = canManage ? await consumptionBetween(db, actor, new Date(now - 30 * 86_400_000), new Date(now + 60_000)) : [];
  const byDoctor = new Map<string, Map<string, number>>();
  for (const u of usage) {
    const d = byDoctor.get(u.doctorName ?? "—") ?? new Map<string, number>();
    const key = `${u.productName} (${u.unit})`;
    d.set(key, (d.get(key) ?? 0) + u.quantity);
    byDoctor.set(u.doctorName ?? "—", d);
  }

  return (
    <div className="inventory">
      <h1>Inventory</h1>
      <nav className="tabs" aria-label="Stores">
        {warehouses.map((w) =>
          w.id === current?.id ? (
            <span key={w.id} className="tab active" aria-current="page">{w.name}</span>
          ) : (
            <a key={w.id} className="tab" href={`/inventory?store=${w.id}`}>{w.name}</a>
          ),
        )}
      </nav>
      <section className="card" aria-label="Stock">
        <h3>Stock — {current?.name}</h3>
        {stock.length === 0 ? (
          <p className="muted">No stock in this store.</p>
        ) : (
          <table className="inv-table">
            <thead>
              <tr><th>Product</th><th>Lot</th><th>Expiry</th><th>Quantity</th></tr>
            </thead>
            <tbody>
              {stock.map((r) => {
                const expired = r.expiryDate !== null && r.expiryDate < new Date(now).toISOString().slice(0, 10);
                const expiring = !expired && r.expiryDate !== null && r.expiryDate <= soon;
                return (
                  <tr key={r.batchId} className={expired ? "inv-expired" : expiring ? "inv-expiring" : undefined}>
                    <td>{r.productName}</td>
                    <td>{r.lotNumber || "—"}</td>
                    <td>
                      {fmt(r.expiryDate)}
                      {expired ? " (expired)" : expiring ? " (expires soon)" : ""}
                    </td>
                    <td>{r.quantity} {r.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {canManage ? (
        <>
          <ReceiveInvoice warehouses={warehouses} products={products.map((p) => ({ name: p.name, unit: p.unit }))} />
          <AdjustForm warehouses={warehouses} />
          <TransferForm
            warehouses={warehouses}
            batches={allStock.map((r) => ({
              key: `${r.warehouseId}:${r.batchId}`,
              warehouseId: r.warehouseId,
              batchId: r.batchId,
              label: `${r.warehouseName}: ${r.productName} lot ${r.lotNumber || "—"} exp ${fmt(r.expiryDate)} (${r.quantity} ${r.unit})`,
            }))}
          />
          <section className="card" aria-label="Materials used by doctor">
            <h3>Materials used — last 30 days, by doctor</h3>
            <p><a href="/inventory/consumption">Full report by period, doctor and product, with cost and Excel export →</a></p>
            {byDoctor.size === 0 ? (
              <p className="muted">Nothing recorded.</p>
            ) : (
              [...byDoctor.entries()].map(([doctor, items]) => (
                <div key={doctor}>
                  <strong>{doctor}</strong>
                  <ul>
                    {[...items.entries()].map(([k, q]) => <li key={k}>{k}: {q}</li>)}
                  </ul>
                </div>
              ))
            )}
            {usage.length > 0 && canSeePatients ? (
              <details>
                <summary>By patient ({usage.length} entries)</summary>
                <table className="inv-table">
                  <thead><tr><th>Date</th><th>Patient</th><th>Doctor</th><th>Product</th><th>Qty</th><th>Recorded by</th></tr></thead>
                  <tbody>
                    {usage.map((u) => (
                      <tr key={u.id}>
                        <td>{u.createdAt.toLocaleDateString("en-GB")}</td>
                        <td>{u.patientName}</td>
                        <td>{u.doctorName ?? "—"}</td>
                        <td>{u.productName} (lot {u.lotNumber || "—"})</td>
                        <td>{u.quantity} {u.unit}</td>
                        <td>{u.recordedBy ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
