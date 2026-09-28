import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { listProducts, listWarehouses, stockLevels } from "@/modules/inventory/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { fmtDate, inventoryLang } from "../_ui/lang";
import { AdjustForm, TransferForm } from "../inventory-forms";

/** Transfers between stores and single corrections / write-offs (I1 forms, I3 screen). */
export default async function TransferPage() {
  const actor = await requireActor();
  if (!actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE)) notFound();
  const { d } = await inventoryLang();
  const db = getDb();
  const [warehouses, stock, products] = await Promise.all([listWarehouses(db, actor), stockLevels(db, actor), listProducts(db, actor)]);
  return (
    <>
      <datalist id="inv-products">
        {products.map((p) => <option key={p.name} value={p.name} />)}
      </datalist>
      <TransferForm
        d={d}
        warehouses={warehouses}
        batches={stock.map((r) => ({
          key: `${r.warehouseId}:${r.batchId}`,
          warehouseId: r.warehouseId,
          batchId: r.batchId,
          label: `${r.warehouseName}: ${r.productName} · ${d.lot} ${r.lotNumber || "—"} · ${fmtDate(r.expiryDate)} (${r.quantity} ${r.unit})`,
        }))}
      />
      <AdjustForm d={d} warehouses={warehouses} />
    </>
  );
}
