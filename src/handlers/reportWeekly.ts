import { z } from 'zod';
import type { Db } from '../db.ts';
import { addAi, houseSpendThisMonth } from '../spend.ts';
import type { Handler } from '../types.ts';

const Input = z.object({
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type MailRow = {
  key: string; label: string; mailed_on: string | null; pieces: number; cost: number;
  responses: number; deals: number; won: number; fees: number;
};

// Manager: one report per business per week into agent_reports. The numbers are
// computed here, in code; Claude only writes the plain-English summary around
// them, and is told to use no other figures. Without AI (no key, or the monthly
// ceiling reached) the report is still written from a template.
export const reportWeekly: Handler = async ({ db, job, llm, config, spend }) => {
  const parsed = Input.safeParse(job.input);
  if (!parsed.success) return { status: 'failed', error: 'input needs period_start and period_end (YYYY-MM-DD)' };
  const { period_start, period_end } = parsed.data;
  if (period_end < period_start) return { status: 'failed', error: 'period_end is before period_start' };

  if (await reportExists(db, job.business_id, period_start, period_end)) {
    return { status: 'done', result: { skipped: 'report for this period already exists' } };
  }

  const metrics = await gatherMetrics(db, job.business_id, period_start, period_end);
  const title = `Week of ${fmtDate(period_start)} to ${fmtDate(period_end)}`;
  let body = templateBody(metrics);
  let writer = 'template';

  const house = await houseSpendThisMonth(db);
  if (llm && house.ai_cents < config.aiMonthlyCeilingCents) {
    const res = await llm.complete({ system: SYSTEM, prompt: JSON.stringify(metrics, null, 1), maxTokens: 900 });
    addAi(spend, llm.model, res.inputTokens, res.outputTokens);
    if (res.text.length > 40) {
      body = res.text;
      writer = 'ai';
    }
  }

  return {
    status: 'done',
    lockKey: `report:${job.business_id}:${period_start}:${period_end}`,
    result: { writer, period_start, period_end },
    write: async (tx) => {
      if (await reportExists(tx, job.business_id, period_start, period_end)) return { written: false };
      const r = await tx.query(
        `insert into public.agent_reports (business_id, agent, period_start, period_end, title, body, metrics)
         values ($1, 'manager', $2, $3, $4, $5, $6::jsonb) returning id`,
        [job.business_id, period_start, period_end, title, body, JSON.stringify({ ...metrics, writer, agent_job_id: job.id })],
      );
      return { written: true, report_id: r.rows[0].id };
    },
  };
};

const SYSTEM = `You write the weekly report for a Wichita cash home buyer's CRM. The owner reads it on his phone.
Use ONLY the numbers in the JSON you are given. Never invent, estimate or round a number into a new one.
Plain words, short sentences, no hype, no exclamation marks. Under 250 words.
Plain text only: the CRM shows it as-is, so no markdown (no **, #, or tables). Use a line break between sections and "- " for bullets.
Structure, in this order, each a short section with a one-line heading:
1. This week: new people, replies, texts and emails out, deals won.
2. Mail: for each recent mailing give response rate, cost per closed deal and return, exactly as given (say "none yet" for nulls).
3. Agents: findings waiting for review, drafts waiting for approval, what the agents did this week, and anything blocked and why.
4. One thing to do next, drawn only from the numbers (e.g. review waiting findings).
If rank_bands is present, add one line on whether owners ranked past 2,000 to 2,500 still produced deals.
Do not mention AI, models, tokens or costs of running the agents.`;

async function reportExists(q: Pick<Db, 'query'>, businessId: string, start: string, end: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `select 1 from public.agent_reports where business_id = $1 and agent = 'manager' and period_start = $2 and period_end = $3`,
    [businessId, start, end],
  );
  return (rowCount ?? 0) > 0;
}

export async function gatherMetrics(db: Db, businessId: string, start: string, end: string) {
  const since = `${start} 00:00 America/Chicago`;
  const until = `${end} 00:00 America/Chicago`;
  const [biz, stats, mail, bands, jobs, findings, drafts] = await Promise.all([
    db.query('select name from public.businesses where id = $1', [businessId]),
    db.query('select public.business_stats($1, $2::timestamptz) as s', [businessId, since]),
    db.query<MailRow>(`select * from public.mail_results($1) order by mailed_on desc nulls last limit 6`, [businessId]),
    db.query<MailRow>(`select * from public.mail_results($1, 'rank', 500)`, [businessId]),
    db.query(
      `select job_type, status, count(*)::int as n from public.agent_jobs
        where business_id = $1 and finished_at >= $2::timestamptz and finished_at < $3::timestamptz + interval '1 day'
          and job_type not like 'plan.%' and job_type <> 'report.weekly'
        group by 1, 2 order by 1, 2`,
      [businessId, since, until],
    ),
    db.query(
      `select kind, count(*)::int as n from public.enrichment_results
        where business_id = $1 and created_at >= $2::timestamptz and created_at < $3::timestamptz + interval '1 day'
        group by 1 order by 1`,
      [businessId, since, until],
    ),
    db.query(
      `select count(*)::int as n from public.outbound_drafts
        where business_id = $1 and source = 'agent' and created_at >= $2::timestamptz and created_at < $3::timestamptz + interval '1 day'`,
      [businessId, since, until],
    ),
  ]);
  const blocked = await db.query(
    `select job_type, error, count(*)::int as n from public.agent_jobs
      where business_id = $1 and status = 'blocked' and finished_at >= now() - interval '30 days'
      group by 1, 2 order by 3 desc limit 5`,
    [businessId],
  );
  // The weekly stats count from period_start to now; for a report written on the
  // Monday after, that's the week plus a few hours. Good enough, and it says so.
  const s = stats.rows[0].s as Record<string, number>;
  const mailings = mail.rows.map((m) => ({
    name: m.label,
    mailed_on: m.mailed_on,
    pieces: m.pieces,
    cost: money(m.cost),
    responses: m.responses,
    deals: m.deals,
    closed: m.won,
    fees: money(m.fees),
    response_rate_pct: m.pieces ? round(m.responses / m.pieces * 100, 2) : null,
    cost_per_closed_deal: m.won ? money(m.cost / m.won) : null,
    return_multiple: m.cost ? round(m.fees / m.cost, 2) : null,
  }));
  const monthsOfMail = new Set(mail.rows.filter((m) => m.mailed_on).map((m) => m.mailed_on!.slice(0, 7))).size;
  return {
    business: biz.rows[0]?.name ?? null,
    period: { start, end },
    week: {
      new_people: s.new_people, replies_in: s.replies_in, texts_out: s.texts_out, emails_out: s.emails_out,
      deals_won: s.deals_won, deals_open: s.deals_open, lists_uploaded: s.lists_uploaded, follow_ups_due: s.follow_ups_due,
    },
    waiting: { findings_for_review: s.findings_pending, drafts_for_approval: s.drafts_waiting },
    agents: {
      jobs: jobs.rows,
      findings_this_week: findings.rows,
      agent_drafts_this_week: drafts.rows[0]?.n ?? 0,
      blocked_last_30_days: blocked.rows,
    },
    mailings,
    // Only once there are a few months of mail, per the handoff.
    rank_bands: monthsOfMail >= 3
      ? bands.rows.map((b) => ({ ranks: b.label, pieces: b.pieces, responses: b.responses, deals: b.deals, closed: b.won }))
      : undefined,
  };
}

type Metrics = Awaited<ReturnType<typeof gatherMetrics>>;

export function templateBody(m: Metrics): string {
  const lines: string[] = [];
  const w = m.week;
  lines.push('This week');
  lines.push(`${w.new_people} new people, ${w.replies_in} replies, ${w.texts_out} texts and ${w.emails_out} emails out, ${w.deals_won} deals won. ${w.deals_open} deals open.`);
  lines.push('');
  lines.push('Mail');
  if (!m.mailings.length) lines.push('No mailings recorded yet.');
  for (const x of m.mailings) {
    lines.push(
      `${x.name}: ${x.pieces} pieces, ${x.responses} responses (${x.response_rate_pct ?? 0}%), ${x.closed} closed. ` +
        `Cost per closed deal: ${x.cost_per_closed_deal === null ? 'none yet' : `$${x.cost_per_closed_deal}`}. ` +
        `Return: ${x.return_multiple === null ? 'none yet' : `${x.return_multiple}x`}.`,
    );
  }
  lines.push('');
  lines.push('Agents');
  lines.push(`${m.waiting.findings_for_review} findings waiting for review, ${m.waiting.drafts_for_approval} drafts waiting for approval.`);
  for (const b of m.agents.blocked_last_30_days) lines.push(`Blocked: ${b.job_type} (${b.n}): ${b.error}`);
  lines.push('');
  lines.push('Next');
  lines.push(m.waiting.findings_for_review ? 'Review the waiting findings on the seller list pages.' : 'Nothing waiting on you.');
  return lines.join('\n');
}

function money(n: number | null): number {
  return round(Number(n ?? 0), 2);
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
