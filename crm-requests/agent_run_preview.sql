-- For Garrett: put this in the CRM's next numbered migration (not an edit of an old one).
-- The Control page calls it to show live counts and cost while Francis picks a run.
-- Read-only, runs as the signed-in user (RLS applies). It mirrors the worker's
-- run.custom rules exactly; the worker's test suite checks the two agree.

create or replace function public.agent_run_preview(
  p_business uuid,
  p_import uuid,
  p_rank_from int,
  p_rank_to int,
  p_types text[],                 -- any of 'person', 'company', 'estate'
  p_include_mailed boolean default false,
  p_big_doors int default 20      -- companies with this many properties or more are skipped
) returns jsonb
language sql stable security invoker set search_path = public as $$
  with best as (
    select distinct on (r.owner_key) r.id, r.owner_key, r.owner_name, r.bucket, r.vendor_rank, r.person_id, r.mail_selected,
           (coalesce(btrim(r.raw ->> 'PROBATE ADDRESS ID'), '') <> '' or coalesce(r.raw ->> 'MOTIVATIONS', '') ilike '%probate%') as probate,
           greatest(coalesce(r.vendor_property_count, 0),
                    case when (r.raw ->> 'OWNER TOTAL PROPERTIES') ~ '^[0-9]+(\.0+)?$'
                         then (r.raw ->> 'OWNER TOTAL PROPERTIES')::numeric::int else 0 end) as doors
      from list_rows r join list_imports li on li.id = r.import_id and li.status = 'done'
     where r.business_id = p_business and r.import_id = p_import and r.owner_key is not null
       and r.vendor_rank between p_rank_from and p_rank_to
     order by r.owner_key, r.vendor_rank
  ),
  traced as (   -- owners already sent for phones and emails (any list), live batches only
    select distinct r2.owner_key
      from agent_jobs j
      cross join lateral jsonb_array_elements_text(coalesce(j.input -> 'list_row_ids', '[]'::jsonb)) x(id)
      join list_rows r2 on r2.id::text = x.id
     where j.business_id = p_business and j.job_type = 'skiptrace.submit'
       and j.status in ('queued', 'running', 'done')
       and coalesce((j.result ->> 'test_mode')::boolean, false) = false
  ),
  fb as (       -- owners already searched on Facebook
    select distinct r3.owner_key
      from agent_jobs j join list_rows r3 on r3.id::text = j.input ->> 'list_row_id'
     where j.business_id = p_business and j.job_type = 'person.facebook' and j.status in ('queued', 'running', 'done')
    union
    select split_part(j.idempotency_key, ':', 3) from agent_jobs j
     where j.business_id = p_business and j.idempotency_key like 'person.facebook:%'
  ),
  o as (
    select b.*,
           case when b.probate then 'estate' when b.bucket = 'entity' then 'company' else 'person' end as owner_type,
           (b.mail_selected or exists (select 1 from mailing_pieces mp join list_rows r4 on r4.id = mp.list_row_id
                                        where r4.business_id = p_business and r4.owner_key = b.owner_key)) as mailed,
           b.owner_key in (select owner_key from traced) as is_traced,
           (b.owner_key in (select owner_key from fb)
            or exists (select 1 from people p where p.id = b.person_id and p.facebook_url is not null)) as fb_done
      from best b
  ),
  picked as (select * from o where owner_type = any(p_types) and (p_include_mailed or not mailed)),
  todo as (
    select * from picked
     where not is_traced and not (owner_type = 'company' and doors >= p_big_doors)
  )
  select jsonb_build_object(
    'owners_in_ranks', (select count(*) from o),
    'owners_picked', (select count(*) from picked),
    'skipped_mailed', case when p_include_mailed then 0
                           else (select count(*) from o where owner_type = any(p_types) and mailed) end,
    'contact', jsonb_build_object(
      'to_look_up', (select count(*) from todo),
      'people', (select count(*) from todo where owner_type = 'person'),
      'companies_and_estates', (select count(*) from todo where owner_type <> 'person'),
      'already_looked_up', (select count(*) from picked where is_traced),
      'skipped_big_companies', (select count(*) from picked where not is_traced and owner_type = 'company' and doors >= p_big_doors),
      -- what the worker holds (the most it can cost) and what live batches have averaged
      'max_cents', (select coalesce(sum(case when owner_type = 'person' then 14 else 16 end), 0) from todo),
      'typical_cents', (select coalesce(sum(case when owner_type = 'person' then 11 else 15 end), 0) from todo)
    ),
    'facebook', jsonb_build_object(
      'to_search', (select count(*) from picked where owner_type = 'person' and not fb_done),
      'already_searched', (select count(*) from picked where owner_type = 'person' and fb_done),
      'not_people', (select count(*) from picked where owner_type <> 'person')
    ),
    'budget_left_cents', agent_budget_left(p_business, 'scrub')
  );
$$;

revoke all on function public.agent_run_preview(uuid, uuid, int, int, text[], boolean, int) from public, anon;
grant execute on function public.agent_run_preview(uuid, uuid, int, int, text[], boolean, int) to authenticated;
