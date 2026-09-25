import { z } from "zod";
import type { ExtractedInvoice } from "@/db/schema";

/**
 * Reads a scanned purchase invoice (I1, ADR-035). The result is only a DRAFT:
 * nothing reaches the stock until a person has reviewed and confirmed it.
 * Invoices are supplier documents (no patient data).
 */
export interface InvoiceExtractor {
  extract(file: { bytes: Uint8Array; contentType: string }): Promise<ExtractedInvoice>;
}

const num = z.union([z.number(), z.string()]).nullable().transform((v) => {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
});
const isoOrNull = z.string().nullable().transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null));

export const extractedInvoiceSchema = z.object({
  documentType: z.enum(["invoice", "statement", "other"]).catch("other").default("invoice"),
  supplierName: z.string().nullable().default(null),
  invoiceNumber: z.string().nullable().default(null),
  invoiceDate: isoOrNull.default(null),
  lines: z
    .array(
      z.object({
        productName: z.string().min(1),
        lotNumber: z.string().nullable().default(null),
        expiryDate: isoOrNull.default(null),
        quantity: num.default(null),
        packSize: num.default(null),
        unit: z.string().nullable().default(null),
        unitCost: num.default(null),
      }),
    )
    .max(200)
    .default([]),
});

export const EXTRACTION_PROMPT = `You read a scanned purchase invoice of a medical clinic's store.
The document may have several pages; read all of them. Return ONLY a JSON object, no prose:
{"documentType": "invoice"|"statement"|"other", "supplierName": string|null, "invoiceNumber": string|null,
 "invoiceDate": "YYYY-MM-DD"|null,
 "lines": [{"productName": string, "lotNumber": string|null, "expiryDate": "YYYY-MM-DD"|null,
            "quantity": number|null, "packSize": number|null, "unit": string|null, "unitCost": number|null}]}
Rules:
- documentType "invoice" only for a tax invoice / delivery of goods. A "Statement of Accounts" is
  "statement" and has NO lines. Anything else is "other" with no lines.
- One line per invoice item; copy product names exactly as printed (e.g. "Beauty Supplies P 0.25").
- quantity = number of packs invoiced; packSize = units per pack when printed ("10.00 box of 5" ->
  quantity 10, packSize 5, unit "box of 5"); otherwise packSize null.
- unitCost = the printed unit price of one pack BEFORE VAT (not the line total, not incl. VAT).
- Lot/batch and expiry only if printed for that item (usually they are not).
- Dates as YYYY-MM-DD ("03 Jul 2026" -> "2026-07-03"). Use null for anything not printed. Never invent.`;

export function parseExtraction(text: string): ExtractedInvoice {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI did not return an invoice.");
  return extractedInvoiceSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/** Claude Messages API (images: jpeg/png/webp; PDF as a document block). */
export class AnthropicInvoiceExtractor implements InvoiceExtractor {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async extract(file: { bytes: Uint8Array; contentType: string }): Promise<ExtractedInvoice> {
    const data = Buffer.from(file.bytes).toString("base64");
    const block =
      file.contentType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: file.contentType, data } };
    const res = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: [block, { type: "text", text: EXTRACTION_PROMPT }] }],
      }),
    });
    if (!res.ok) throw new Error(`AI reading failed (${res.status}).`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    return parseExtraction(text);
  }
}
