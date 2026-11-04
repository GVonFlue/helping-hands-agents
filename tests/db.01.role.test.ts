import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentDb, HH } from './helpers.ts';

// The worker's login must be exactly as locked down as the handoff says.

test('worker logs in as agents_worker, a member of agent_service, with no bypass', async () => {
  const { rows } = await agentDb.query(
    `select current_user as u, pg_has_role(current_user, 'agent_service', 'member') as member,
            (select rolbypassrls or rolsuper from pg_roles where rolname = current_user) as powerful`,
  );
  assert.equal(rows[0].u, 'agents_worker');
  assert.equal(rows[0].member, true);
  assert.equal(rows[0].powerful, false);
});

test('worker can call the functions it needs, including advisory locks', async () => {
  const biz = await HH();
  await agentDb.query('select public.agent_budget_left($1, $2)', [biz, 'scrub']);
  await agentDb.query('select public.business_stats($1, now() - $2::interval)', [biz, '7 days']);
  await agentDb.query('select * from public.mail_results($1)', [biz]);
  await agentDb.query(`select pg_advisory_xact_lock(hashtextextended('x', 0))`);
});

for (const [what, sql] of [
  ['insert a message', `insert into public.messages (business_id, channel, direction, from_value, to_value) select id, 'sms', 'out', 'a', 'b' from public.businesses limit 1`],
  ['edit a person', `update public.people set full_name = 'x'`],
  ['change consent', `insert into public.consent_events (person_id, channel, action, source) select id, 'sms', 'opt_in', 'agent' from public.people limit 1`],
  ['promote a finding', `select public.promote_enrichment(gen_random_uuid())`],
  ['approve a draft', `update public.outbound_drafts set status = 'approved'`],
  ['insert a pre-approved finding', `insert into public.enrichment_results (business_id, kind, value, source, status) select id, 'email', 'x@y.z', 't', 'promoted' from public.businesses limit 1`],
] as const) {
  test(`worker cannot ${what}`, async () => {
    await assert.rejects(agentDb.query(sql), /permission denied|row-level security|violates/);
  });
}
