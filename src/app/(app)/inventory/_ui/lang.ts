import { cookies } from "next/headers";
import { DICTS, LANG_COOKIE, parseLang, type Dict, type Lang } from "@/modules/inventory/i18n";

/** The inventory screens' language for this request (cookie, Arabic by default). */
export async function inventoryLang(): Promise<{ lang: Lang; d: Dict }> {
  const lang = parseLang((await cookies()).get(LANG_COOKIE)?.value);
  return { lang, d: DICTS[lang] };
}

/** dd/mm/yyyy, as everywhere else in the app. */
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}
