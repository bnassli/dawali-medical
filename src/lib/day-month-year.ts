/**
 * SonoSoft takes the birthdate as day/month/year ("E.G. 01/01/1925", PS3).
 * Returns ISO yyyy-mm-dd, "" for an empty field, or null when it is not a real date.
 */
export function parseDayMonthYear(text: string): string | null {
  const t = text.trim();
  if (t === "") return "";
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
