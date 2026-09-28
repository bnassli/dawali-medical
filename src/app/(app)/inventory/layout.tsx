import { notFound } from "next/navigation";
import { requireActor } from "@/modules/auth/current-actor";
import { PERMISSIONS } from "@/modules/permissions/constants";
import { inventoryLang } from "./_ui/lang";
import { InventoryNav, LanguageSwitch } from "./_ui/nav";

/** I3 (ADR-038): the inventory section — its own navigation, Arabic (RTL) or English. */
export default async function InventoryLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  if (!actor.permissions.has(PERMISSIONS.INVENTORY_READ)) notFound();
  const manage = actor.permissions.has(PERMISSIONS.INVENTORY_MANAGE);
  const { lang, d } = await inventoryLang();
  const items = [
    { href: "/inventory", label: d.navDashboard, exact: true },
    { href: "/inventory/stock", label: d.navStock },
    { href: "/inventory/products", label: d.navProducts },
    ...(manage
      ? [
          { href: "/inventory/stocktake", label: d.navStocktake },
          { href: "/inventory/receive", label: d.navReceive },
          { href: "/inventory/transfer", label: d.navTransfer },
          { href: "/inventory/consumption", label: d.navReports },
        ]
      : []),
  ];
  return (
    <div className="inv-shell" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang}>
      <div className="inv-head">
        <h1>{d.inventory}</h1>
        <LanguageSwitch next={lang === "ar" ? "en" : "ar"} label={d.switchLang} />
      </div>
      <InventoryNav items={items} label={d.inventory} />
      <div className="inv-body">{children}</div>
    </div>
  );
}
