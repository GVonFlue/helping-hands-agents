import { z } from 'zod';
import { parseJsonObject } from '../ai.ts';
import type { Db } from '../db.ts';
import { addAi, houseSpendThisMonth } from '../spend.ts';
import { UUID_RE, type Handler } from '../types.ts';

const Input = z.object({
  person_id: z.string().regex(UUID_RE),
  purpose: z.enum(['warm', 'cold']).default('cold'),
  channel: z.enum(['email', 'sms']).default('email'),
});

// Contact: writes ONE personal draft into outbound_drafts (source 'agent', status
// 'draft'). It never sends; Francis approves every draft in Approvals and the CRM
// sends it. No cold texts: SMS only when the CRM's can_text() says yes (they
// opted in, texted us, or are a non-list contact of Francis's), the same check
// the CRM's sender runs.
export const messageDraft: Handler = async ({ db, job, llm, config, spend }) => {
  const parsed = Input.safeParse(job.input);
  if (!parsed.success) return { status: 'failed', error: 'input needs person_id (uuid), purpose warm|cold, channel email|sms' };
  const { person_id, purpose } = parsed.data;
  let channel = parsed.data.channel;
  const notes: string[] = [];

  const ctx = await loadContext(db, job.business_id, person_id);
  if (!ctx) return { status: 'failed', error: 'person is not in this business' };

  if (channel === 'sms' && !ctx.textsAllowed) {
    if (!ctx.email) {
      return { status: 'blocked', error: 'No cold texts: this person has not agreed to texts or texted us, and has no email.' };
    }
    channel = 'email';
    notes.push('switched to email: can_text() is false (no opt-in and never texted us)');
  }
  if (channel === 'email' && !ctx.email) return { status: 'blocked', error: 'No usable email on file for this person.' };
  if (channel === 'sms' && !ctx.phone) return { status: 'blocked', error: 'No usable phone on file for this person.' };

  const allowed = await db.query('select public.can_contact($1, $2, $3) as ok', [person_id, job.business_id, channel]);
  if (!allowed.rows[0].ok) return { status: 'blocked', error: `Contact not allowed on ${channel} (opted out or do not contact).` };

  // One open agent draft per person and channel; and never twice for one job.
  const existing = await db.query(
    `select id from public.outbound_drafts
      where business_id = $1 and person_id = $2 and source = 'agent' and (agent_job_id = $3 or (channel = $4 and status = 'draft'))
      limit 1`,
    [job.business_id, person_id, job.id, channel],
  );
  if (existing.rowCount) return { status: 'done', result: { skipped: 'an agent draft is already waiting', draft_id: existing.rows[0].id } };

  if (!llm) return { status: 'blocked', error: 'Drafting is off: ANTHROPIC_API_KEY is not set on the worker.' };
  const house = await houseSpendThisMonth(db);
  if (house.ai_cents >= config.aiMonthlyCeilingCents) {
    return { status: 'blocked', error: "ProyTech's AI budget for this month is used up; drafting resumes next month." };
  }

  const res = await llm.complete({
    system: systemPrompt(channel, purpose),
    prompt: JSON.stringify(ctx.forModel, null, 1),
    maxTokens: 600,
  });
  addAi(spend, llm.model, res.inputTokens, res.outputTokens);
  const out = parseJsonObject(res.text);
  const body = typeof out?.body === 'string' ? out.body.trim() : '';
  const subject = channel === 'email' && typeof out?.subject === 'string' ? out.subject.trim().slice(0, 120) : null;
  if (!body || (channel === 'email' && !subject)) return { status: 'failed', error: 'model returned no usable draft' };
  if (channel === 'sms' && body.length > 320) return { status: 'failed', error: 'text draft too long' };

  return {
    status: 'done',
    lockKey: `draft:${job.business_id}:${person_id}:${channel}`,
    result: { channel, purpose, notes },
    write: async (tx) => {
      const again = await tx.query(
        `select id from public.outbound_drafts
          where business_id = $1 and person_id = $2 and source = 'agent' and (agent_job_id = $3 or (channel = $4 and status = 'draft'))
          limit 1`,
        [job.business_id, person_id, job.id, channel],
      );
      if (again.rowCount) return { written: false, draft_id: again.rows[0].id };
      const r = await tx.query(
        `insert into public.outbound_drafts (business_id, person_id, channel, purpose, subject, body, source, agent_job_id)
         values ($1, $2, $3, $4, $5, $6, 'agent', $7) returning id, status`,
        [job.business_id, person_id, channel, purpose, subject, body, job.id],
      );
      return { written: true, draft_id: r.rows[0].id, draft_status: r.rows[0].status };
    },
  };
};

function systemPrompt(channel: 'email' | 'sms', purpose: 'warm' | 'cold'): string {
  return `You draft one ${channel === 'email' ? 'email' : 'text message'} for a person at a Wichita cash home buyer.
A person on the team reviews and edits every draft before anything is sent.
${purpose === 'cold'
    ? 'This is a first, cold message to a property owner who has not contacted us. Be brief, respectful and specific to their property. One soft question, easy to ignore. No pressure, no urgency, no price talk.'
    : 'This person already knows us. Pick up naturally from the recent history.'}
Rules:
- Use only facts in the JSON. Never invent offers, prices, timelines, names or past conversations.
- Never mention or hint at why we're writing to them: no taxes, debt, liens, probate, death, divorce, age,
  vacancy, repairs, code violations, tenants or any other personal or financial situation. Never say how
  we found them or that they are on a list.
- Plain words, no hype, no exclamation marks, no emojis.
- Sign off with the sender_name from the JSON.
- Do not add an unsubscribe line or legal footer; the system adds those.
${channel === 'email' ? '- Under 120 words.' : '- Under 300 characters.'}
Reply with JSON only: ${channel === 'email' ? '{"subject": "...", "body": "..."}' : '{"body": "..."}'}`;
}

async function loadContext(db: Db, businessId: string, personId: string) {
  const person = await db.query(
    `select p.id, p.full_name, p.first_name, p.mailing_city, r.role_key, rr.label as role_label, r.tags
       from public.people p
       join public.relationships r on r.person_id = p.id and r.business_id = $2
       left join public.relationship_roles rr on rr.business_id = r.business_id and rr.key = r.role_key
      where p.id = $1
      order by r.created_at limit 1`,
    [personId, businessId],
  );
  const p = person.rows[0];
  if (!p) return null;
  const [biz, points, msgs, acts, deals, props, textCheck] = await Promise.all([
    db.query('select name, short_name, tagline from public.businesses where id = $1', [businessId]),
    db.query(
      `select kind, value, is_primary from public.contact_points
        where person_id = $1 and not do_not_contact order by is_primary desc, created_at`,
      [personId],
    ),
    db.query(
      `select channel, direction, subject, left(body, 400) as body, created_at::date as on
         from public.messages where person_id = $1 and business_id = $2 order by created_at desc limit 8`,
      [personId, businessId],
    ),
    db.query(
      `select kind, subject, left(body, 300) as body, occurred_at::date as on
         from public.activities where person_id = $1 and business_id = $2 and kind in ('note', 'call', 'meeting', 'mail')
        order by occurred_at desc limit 5`,
      [personId, businessId],
    ),
    db.query(
      `select d.title, s.label as stage from public.deals d join public.pipeline_stages s on s.id = d.stage_id
        where d.person_id = $1 and d.business_id = $2 order by d.created_at desc limit 3`,
      [personId, businessId],
    ),
    db.query(
      `select distinct property_address, property_city from public.list_rows
        where person_id = $1 and business_id = $2 and property_address is not null limit 3`,
      [personId, businessId],
    ),
    db.query('select public.can_text($1, $2) as ok', [personId, businessId]),
  ]);
  const email = points.rows.find((c) => c.kind === 'email')?.value ?? null;
  const phone = points.rows.find((c) => c.kind === 'phone')?.value ?? null;
  // can_contact() alone treats "no consent record" as allowed; can_text() adds
  // the A2P rule (opt-in, texted us, or a non-list relationship).
  const textsAllowed = textCheck.rows[0]?.ok === true;
  const b = biz.rows[0];
  return {
    email,
    phone,
    textsAllowed,
    forModel: {
      sender_name: b?.short_name || b?.name,
      business: { name: b?.name, tagline: b?.tagline },
      person: {
        first_name: p.first_name || String(p.full_name).split(' ')[0],
        full_name: p.full_name,
        city: p.mailing_city,
        role: p.role_label ?? p.role_key,
        tags: p.tags,
      },
      properties: props.rows,
      deals: deals.rows,
      recent_messages: msgs.rows,
      recent_notes: acts.rows,
    },
  };
}
