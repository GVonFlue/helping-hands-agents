// What a list row says beyond the CRM's mapped columns, read from list_rows.raw
// (the original CSV row the CRM keeps). Built around Francis's vendor file
// (Sep 2026: FULL NAME, FIRST NAME, TOTAL, RANK, MOTIVATIONS, PROBATE ADDRESS ID,
// OWNER TOTAL PROPERTIES), with fallbacks to the mapped columns for other files.
//
// Why raw: the CRM's import auto-maps this vendor's RANK (a 0–4.58 score) to
// vendor_rank and strips the decimal point, so vendor_rank can't be trusted for
// ordering. TOTAL (= RANK + MOTIVATION POINTS) is the vendor's full score;
// higher = more likely to sell.

// Probate: the owner of record may have died; the heirs are the real contact.
export const PROBATE_SQL = (r: string) =>
  `(coalesce(btrim(${r}.raw ->> 'PROBATE ADDRESS ID'), '') <> '' or coalesce(${r}.raw ->> 'MOTIVATIONS', '') ilike '%probate%')`;

// Higher = more likely to sell.
export const PRIORITY_SQL = (r: string) =>
  `(case when (${r}.raw ->> 'TOTAL') ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${r}.raw ->> 'TOTAL')::numeric else ${r}.vendor_score end)`;

// Doors the owner holds, as the vendor reports it (one row per owner on this list).
export const DOORS_SQL = (r: string) =>
  `greatest(coalesce(${r}.vendor_property_count, 0),
            case when (${r}.raw ->> 'OWNER TOTAL PROPERTIES') ~ '^[0-9]+(\\.0+)?$'
                 then (${r}.raw ->> 'OWNER TOTAL PROPERTIES')::numeric::int else 0 end)`;

export function isProbate(raw: Record<string, unknown> | null | undefined): boolean {
  if (!raw) return false;
  const pid = String(raw['PROBATE ADDRESS ID'] ?? '').trim();
  return pid !== '' || /probate/i.test(String(raw['MOTIVATIONS'] ?? ''));
}
