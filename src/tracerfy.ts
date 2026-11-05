import { RetryableError } from './ai.ts';

// Tracerfy skip trace (batch) + DNC scrub. Docs: tracerfy.com/skip-tracing-api-documentation
//
// Batch, not instant lookup: instant costs 5 credits a hit; batch is 1 credit
// (normal: name + mailing address) or 2 (advanced: address only, finds the owner,
// pierces LLCs/trusts). Credits are $0.02. DNC scrub is 1 credit per phone.
// Terms (Nov 2026): data is for the customer's internal business use; results
// don't include DNC scrubbing, so we scrub every phone before it's saved.

export type TraceType = 'normal' | 'advanced';

export type TraceRecord = {
  ref: string; // our list_row_id, sent as a column in case Tracerfy passes it through
  address: string;
  city: string;
  state: string;
  zip: string;
  first_name?: string;
  last_name?: string;
  mail_address?: string;
  mail_city?: string;
  mail_state?: string;
  mail_zip?: string;
};

export type QueueStatus = { pending: boolean; creditsDeducted: number | null; note?: string };
export type DncResult = { phone: string; clean: boolean; litigator: boolean };

export interface Tracerfy {
  submitTrace(type: TraceType, records: TraceRecord[]): Promise<{ queueId: number; creditsPerLead: number | null }>;
  getQueue(queueId: number): Promise<QueueStatus | null>; // null = not found
  getQueueRows(queueId: number): Promise<Record<string, unknown>[]>;
  submitDnc(phones: string[]): Promise<{ dncQueueId: number }>;
  getDncQueue(dncQueueId: number): Promise<{ pending: boolean; creditsDeducted: number | null; results: DncResult[] } | null>;
}

export function tracerfyClient(apiKey: string, base = 'https://tracerfy.com'): Tracerfy {
  const auth = { Authorization: `Bearer ${apiKey}` };

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...auth, Accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (res.status === 429 || res.status === 503 || res.status >= 500) {
      throw new RetryableError(`Tracerfy busy (${res.status})`, 300);
    }
    if (res.status === 402) throw new Error('Tracerfy: not enough credits on the account. Add credits at tracerfy.com.');
    if (res.status === 401 || res.status === 403) throw new Error(`Tracerfy refused the key (${res.status}): ${text.slice(0, 160)}`);
    if (!res.ok) throw Object.assign(new Error(`Tracerfy error ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return {
    async submitTrace(type, records) {
      const form = new FormData();
      form.set('json_data', JSON.stringify(records));
      form.set('trace_type', type);
      form.set('address_column', 'address');
      form.set('city_column', 'city');
      form.set('state_column', 'state');
      form.set('zip_column', 'zip');
      if (type === 'normal') {
        form.set('first_name_column', 'first_name');
        form.set('last_name_column', 'last_name');
        form.set('mail_address_column', 'mail_address');
        form.set('mail_city_column', 'mail_city');
        form.set('mail_state_column', 'mail_state');
        form.set('mailing_zip_column', 'mail_zip');
      }
      const body = (await call('/v1/api/trace/', { method: 'POST', body: form })) as Record<string, unknown>;
      const queueId = Number(body.queue_id);
      if (!Number.isFinite(queueId)) throw new Error(`Tracerfy: no queue_id in response: ${JSON.stringify(body).slice(0, 200)}`);
      return { queueId, creditsPerLead: num(body.credits_per_lead) };
    },

    async getQueue(queueId) {
      // 1. The jobs list (newest first; may be a bare array or wrapped).
      const list = await call('/v1/api/queues/');
      const items = arrayOf(list);
      const q = items.find((x) => Number(x.id ?? x.queue_id) === queueId);
      if (q) return { pending: isPending(q), creditsDeducted: num(q.credits_deducted) };
      // 2. Not listed: ask for the job itself. Rows back = finished; 409/empty = still running.
      const seen = `list had ${items.length} jobs${items[0] ? `, keys: ${Object.keys(items[0]).slice(0, 12).join(',')}, ids: ${items.slice(0, 5).map((x) => x.id ?? x.queue_id).join(',')}` : ''}`;
      try {
        const rows = arrayOf(await call(`/v1/api/queue/${queueId}`));
        if (rows.length) return { pending: false, creditsDeducted: null, note: `not in list (${seen}); queue/${queueId} returned ${rows.length} rows` };
        return { pending: true, creditsDeducted: null, note: `not in list (${seen}); queue/${queueId} returned no rows yet` };
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st === 409 || st === 404 || st === 202) return { pending: true, creditsDeducted: null, note: `not in list (${seen}); queue/${queueId} said ${st}` };
        throw e;
      }
    },

    async getQueueRows(queueId) {
      return arrayOf(await call(`/v1/api/queue/${queueId}`));
    },

    async submitDnc(phones) {
      const body = (await call('/v1/api/dnc/scrub/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones }),
      })) as Record<string, unknown>;
      const id = Number(body.dnc_queue_id ?? body.queue_id ?? body.id);
      if (!Number.isFinite(id)) throw new Error(`Tracerfy DNC: no queue id in response: ${JSON.stringify(body).slice(0, 200)}`);
      return { dncQueueId: id };
    },

    async getDncQueue(dncQueueId) {
      const raw = await call(`/v1/api/dnc/queue/${dncQueueId}`);
      const q = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
      if (!q) return null;
      const pending = isPending(q);
      if (pending) return { pending, creditsDeducted: null, results: [] };
      const url = String(q.download_url ?? '');
      if (!url) return { pending: true, creditsDeducted: null, results: [] };
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new RetryableError(`Tracerfy DNC download failed (${res.status})`, 120);
      return { pending: false, creditsDeducted: num(q.credits_deducted), results: parseDncCsv(await res.text()) };
    },
  };
}

function arrayOf(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  const o = (v ?? {}) as Record<string, unknown>;
  for (const k of ['results', 'data', 'queues', 'rows', 'records', 'items']) if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
  return [];
}

function isPending(q: Record<string, unknown>): boolean {
  if (typeof q.pending === 'boolean') return q.pending;
  const s = String(q.status ?? '').toLowerCase();
  if (s) return !['complete', 'completed', 'done', 'finished', 'success'].includes(s);
  return !q.download_url;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

// ---- Result parsing ---------------------------------------------------------

export function digits10(phone: unknown): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? ten : null;
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return /^(true|yes|y|1|t)$/i.test(String(v ?? '').trim());
}

export type TracedContacts = {
  ref: string | null;
  address: string;
  city: string;
  names: string[];
  phones: { phone: string; type: string | null; rank: number; flaggedDnc: boolean }[];
  emails: { email: string; rank: number }[];
  deceased: boolean;
  litigator: boolean;
};

// One Tracerfy result row (flat columns: primary_phone, mobile_1..5,
// landline_1..3, email_1..5, first_name/last_name or owner_N_*) to contacts.
export function contactsFromRow(row: Record<string, unknown>): TracedContacts {
  const get = (k: string) => {
    const v = row[k];
    return v === null || v === undefined ? '' : String(v).trim();
  };
  const phones: TracedContacts['phones'] = [];
  const seen = new Set<string>();
  const addPhone = (key: string, type: string | null) => {
    const p = digits10(get(key));
    if (!p || seen.has(p)) return;
    seen.add(p);
    phones.push({ phone: p, type: get(`${key}_type`) || type, rank: phones.length + 1, flaggedDnc: truthy(row[`${key}_dnc`]) });
  };
  addPhone('primary_phone', null);
  for (let i = 1; i <= 5; i++) addPhone(`mobile_${i}`, 'Mobile');
  for (let i = 1; i <= 3; i++) addPhone(`landline_${i}`, 'Landline');
  // Nested shape (instant lookup / some queue rows): persons[].phones[]
  const persons = Array.isArray(row.persons) ? (row.persons as Record<string, unknown>[]) : [];
  for (const p of persons) {
    for (const ph of (Array.isArray(p.phones) ? p.phones : []) as Record<string, unknown>[]) {
      const d = digits10(ph.number);
      if (d && !seen.has(d)) {
        seen.add(d);
        phones.push({ phone: d, type: (ph.type as string) ?? null, rank: Number(ph.rank) || phones.length + 1, flaggedDnc: truthy(ph.dnc) });
      }
    }
  }

  const emails: TracedContacts['emails'] = [];
  const seenE = new Set<string>();
  const addEmail = (v: string) => {
    const e = v.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) || seenE.has(e)) return;
    seenE.add(e);
    emails.push({ email: e, rank: emails.length + 1 });
  };
  for (let i = 1; i <= 5; i++) addEmail(get(`email_${i}`));
  for (const p of persons) for (const em of (Array.isArray(p.emails) ? p.emails : []) as Record<string, unknown>[]) addEmail(String(em.email ?? ''));

  const names: string[] = [];
  const addName = (f: string, l: string) => {
    const n = `${f} ${l}`.trim().replace(/\s+/g, ' ');
    if (n && !names.includes(n)) names.push(n);
  };
  addName(get('first_name'), get('last_name'));
  for (let i = 1; i <= 3; i++) addName(get(`owner_${i}_first_name`), get(`owner_${i}_last_name`));
  for (const p of persons) addName(String(p.first_name ?? ''), String(p.last_name ?? ''));

  return {
    ref: get('ref') || null,
    address: get('address') || get('property_address'),
    city: get('city') || get('property_city'),
    names,
    phones,
    emails,
    deceased: truthy(row.deceased) || truthy(row.death) || persons.some((p) => truthy(p.deceased)),
    litigator: truthy(row.litigator) || persons.some((p) => truthy(p.litigator)),
  };
}

// Address key that survives Tracerfy's address standardisation (STREET -> ST, etc.).
const SUFFIX: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', DRIVE: 'DR', ROAD: 'RD', LANE: 'LN', COURT: 'CT', CIRCLE: 'CIR',
  BOULEVARD: 'BLVD', PLACE: 'PL', TERRACE: 'TER', PARKWAY: 'PKWY', HIGHWAY: 'HWY', TRAIL: 'TRL', SQUARE: 'SQ',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  APARTMENT: 'APT', SUITE: 'STE', UNIT: 'UNIT',
};
export function addressKey(address: string, city: string): string {
  const norm = (s: string) =>
    s.toUpperCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] ?? w).join(' ');
  return `${norm(address)}|${norm(city)}`;
}

// Minimal RFC 4180 CSV parser (quoted fields, embedded commas/newlines).
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().replace(/^﻿/, ''));
  return body.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

// DNC scrub CSV: phone, label, national_dnc, state_dnc, dma?, litigator, phone_type?, is_clean
export function parseDncCsv(text: string): DncResult[] {
  return parseCsv(text).flatMap((r) => {
    const phone = digits10(r.phone);
    if (!phone) return [];
    const flagged = truthy(r.national_dnc) || truthy(r.state_dnc) || truthy(r.dma) || truthy(r.litigator);
    const clean = 'is_clean' in r ? truthy(r.is_clean) && !flagged : !flagged;
    return [{ phone, clean, litigator: truthy(r.litigator) }];
  });
}
