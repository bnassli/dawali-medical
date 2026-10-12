import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { todayIn } from "@/lib/age";
import { getEnv } from "@/lib/env";
import { requireActor } from "@/modules/auth/current-actor";
import { fill, type DictKey } from "@/modules/inventory/i18n";
import { listSuppliers, listWarehouses, stockLevels } from "@/modules/inventory/service";
import { lastSupplierByBatch, listWriteOffs } from "@/modules/inventory/write-offs";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { fmtDate, fmtQty, inventoryLang } from "../_ui/lang";
import { WriteOffForm } from "./write-off-form";

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** I5 (ADR-043): returns to the supplier and disposals, with their value. */
export default async function WriteOffsPage() {
  const actor = await requireActor();
  if (!actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE)) notFound();
  const { lang, d } = await inventoryLang();
  const db = getDb();
  const timeZone = getEnv().APP_TIME_ZONE;
  const today = todayIn(timeZone);
  const [warehouses, stock, suppliers, lastSupplier, history] = await Promise.all([
    listWarehouses(db, actor),
    stockLevels(db, actor),
    listSuppliers(db, actor),
    lastSupplierByBatch(db, actor),
    listWriteOffs(db, actor),
  ]);
  const locale = lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB";

  return (
    <>
      <section className="card" aria-label={d.woTitle}>
        <h3>{d.woTitle}</h3>
        <p className="muted">{d.woHint}</p>
        <WriteOffForm
          d={d}
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          suppliers={suppliers}
          batches={stock.map((r) => ({
            warehouseId: r.warehouseId,
            batchId: r.batchId,
            label: `${r.productName} · ${d.lot} ${r.lotNumber || d.none} · ${fmtDate(r.expiryDate)}`,
            unit: r.unit,
            quantity: r.quantity,
            expired: r.expiryDate !== null && r.expiryDate < today,
            supplierId: lastSupplier.get(r.batchId) ?? null,
          }))}
        />
      </section>
      <section className="card" aria-label={d.woHistory}>
        <h3>{d.woHistory}</h3>
        {history.length === 0 ? (
          <p className="muted">{d.woNone}</p>
        ) : (
          <table className="inv-table">
            <thead>
              <tr>
                <th>{d.date}</th><th>{d.woKind}</th><th>{d.woReason}</th><th>{d.store}</th><th>{d.supplier}</th>
                <th>{d.woLines}</th><th>{d.woValue}</th><th>{d.by}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((w) => (
                <tr key={w.id}>
                  <td>{w.createdAt.toLocaleDateString(locale, { timeZone })}</td>
                  <td>{d[`kind_${w.kind}` as DictKey]}</td>
                  <td>{d[`reason_${w.reason}` as DictKey]}{w.notes ? ` — ${w.notes}` : ""}</td>
                  <td>{w.warehouseName}</td>
                  <td><bdi>{w.supplierName ?? d.none}</bdi>{w.reference ? <> · <bdi>{w.reference}</bdi></> : null}</td>
                  <td>
                    {w.lines.map((l, i) => (
                      <div key={i}>
                        <bdi>{l.productName}</bdi> — <bdi className="inv-q">{fmtQty(l.quantity)} {l.unit}</bdi> · {d.lot} <bdi>{l.lotNumber || d.none}</bdi> · <bdi>{fmtDate(l.expiryDate)}</bdi>
                      </div>
                    ))}
                  </td>
                  <td>
                    <span className="inv-q">{money(w.value)}</span>
                    {w.unpricedLines > 0 ? <div className="muted">{fill(d.woUnpriced, { n: w.unpricedLines })}</div> : null}
                  </td>
                  <td>{w.createdBy ?? d.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
