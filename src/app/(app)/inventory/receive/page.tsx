import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/modules/auth/current-actor";
import { listProducts, listWarehouses } from "@/modules/inventory/service";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { inventoryLang } from "../_ui/lang";
import { ReceiveInvoice } from "../inventory-forms";

/** Scan -> AI draft -> review -> confirm (I1), on its own screen (I3). */
export default async function ReceivePage() {
  const actor = await requireActor();
  if (!actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE)) notFound();
  const { d } = await inventoryLang();
  const db = getDb();
  const [warehouses, products] = await Promise.all([listWarehouses(db, actor), listProducts(db, actor)]);
  return <ReceiveInvoice d={d} warehouses={warehouses} products={products.map((p) => ({ name: p.name, unit: p.unit }))} />;
}
