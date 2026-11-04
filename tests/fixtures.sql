-- Test data for the worker's database tests. Loaded as postgres after the CRM
-- migrations. Fixed ids so tests can refer to rows directly.
-- Test logins use testgvonflue@gmail.com (CRM repo rule).

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000f001', 'testgvonflue@gmail.com');
update public.profiles set is_suite_owner = true where id = '00000000-0000-0000-0000-00000000f001';

create temp table hh as select id from public.businesses where slug = 'helping-hands';

-- A seller list with five owners.
insert into public.list_imports (id, business_id, file_name, vendor, status, row_count)
select '10000000-0000-0000-0000-000000000001', id, 'nov-list.csv', 'vendor', 'done', 6 from hh;

insert into public.list_rows (id, import_id, business_id, row_num, owner_name, mailing_address, mailing_city, mailing_state,
  mailing_zip, property_address, property_city, property_state, property_zip, vendor_rank, owner_key, property_key, bucket)
select v.id::uuid, '10000000-0000-0000-0000-000000000001', hh.id, v.n, v.owner, v.maddr, v.mcity, 'KS', '67202',
       v.paddr, v.pcity, 'KS', '67202', v.rank, v.okey, v.pkey, v.bucket
from hh, (values
  ('20000000-0000-0000-0000-000000000001', 1, 'STOLTENBERG KARL J & DIANE M', '12 Elm St', 'WICHITA', '400 Oak St', 'WICHITA', 10, 'k-stoltenberg', 'p-oak', 'individual_investor'),
  ('20000000-0000-0000-0000-000000000002', 2, 'STOLTENBERG KARL J & DIANE M', '12 Elm St', 'WICHITA', '402 Oak St', 'WICHITA', 11, 'k-stoltenberg', 'p-oak2', 'individual_investor'),
  ('20000000-0000-0000-0000-000000000003', 3, 'JOHN SMITH', '9 Pine Rd', 'WICHITA', '9 Pine Rd', 'WICHITA', 1, 'k-smith', 'p-pine', 'owner_occupied'),
  ('20000000-0000-0000-0000-000000000004', 4, 'ACME HOLDINGS LLC', 'PO Box 1', 'WICHITA', '77 Main St', 'WICHITA', 3, 'k-acme', 'p-main', 'entity'),
  ('20000000-0000-0000-0000-000000000005', 5, 'MARIA QUINTANILLA', '5 Birch Ln', 'DERBY', '5 Birch Ln', 'DERBY', 2, 'k-quint', 'p-birch', 'owner_occupied'),
  ('20000000-0000-0000-0000-000000000006', 6, 'BRENT ZIMMERLE', '8 Cedar Ct', 'WICHITA', '1 Maple Ave', 'WICHITA', 5, 'k-zimm', 'p-maple', 'individual_investor')
) as v(id, n, owner, maddr, mcity, paddr, pcity, rank, okey, pkey, bucket);

-- Maria was mailed last month.
insert into public.mailings (id, business_id, import_id, name, mailed_on, pieces, cost_total, created_by)
select '30000000-0000-0000-0000-000000000001', id, '10000000-0000-0000-0000-000000000001', 'October mailer',
       current_date - 30, 1, 0.75, '00000000-0000-0000-0000-00000000f001' from hh;
insert into public.mailing_pieces (mailing_id, list_row_id, business_id)
select '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', id from hh;

-- An LLC checked 10 days ago (cached) and one never checked.
insert into public.entities (id, name, normalized_name, last_checked_at) values
  ('40000000-0000-0000-0000-000000000001', 'Acme Holdings LLC', 'acme holdings', now() - interval '10 days'),
  ('40000000-0000-0000-0000-000000000002', 'Prairie Rentals LLC', 'prairie rentals', null);

-- People for the Contact agent.
insert into public.people (id, full_name, first_name, last_name, mailing_city) values
  ('50000000-0000-0000-0000-000000000001', 'Paula Prospect', 'Paula', 'Prospect', 'Wichita'),  -- cold list seller, has email
  ('50000000-0000-0000-0000-000000000002', 'Tom Texter', 'Tom', 'Texter', 'Wichita'),          -- texted us first
  ('50000000-0000-0000-0000-000000000003', 'Cora Cold', 'Cora', 'Cold', 'Wichita'),            -- phone only, never contacted us
  ('50000000-0000-0000-0000-000000000004', 'Olive Optout', 'Olive', 'Optout', 'Wichita'),      -- unsubscribed from email
  ('50000000-0000-0000-0000-000000000005', 'Felix Facebook', 'Felix', 'Facebook', 'Wichita');  -- only a Facebook link
insert into public.relationships (person_id, business_id, role_key)
select p.id::uuid, hh.id, p.role from hh, (values
  ('50000000-0000-0000-0000-000000000001', 'seller_investor'),
  ('50000000-0000-0000-0000-000000000002', 'seller_occupant'),
  ('50000000-0000-0000-0000-000000000003', 'seller_occupant'),
  ('50000000-0000-0000-0000-000000000004', 'seller_investor'),
  ('50000000-0000-0000-0000-000000000005', 'seller_investor')) as p(id, role);
insert into public.contact_points (person_id, kind, value, is_primary) values
  ('50000000-0000-0000-0000-000000000001', 'email', 'paula@example.test', true),
  ('50000000-0000-0000-0000-000000000002', 'phone', '+13165550102', true),
  ('50000000-0000-0000-0000-000000000003', 'phone', '+13165550103', true),
  ('50000000-0000-0000-0000-000000000004', 'email', 'olive@example.test', true);
insert into public.messages (business_id, person_id, channel, direction, from_value, to_value, body, status)
select id, '50000000-0000-0000-0000-000000000002', 'sms', 'in', '+13165550102', '+13165550000',
       'Saw your letter, is the offer still good?', 'received' from hh;
insert into public.consent_events (person_id, business_id, channel, action, source)
values ('50000000-0000-0000-0000-000000000004', null, 'email', 'opt_out', 'unsubscribe link');

-- Francis promoted Paula's email and Felix's Facebook link last week.
insert into public.enrichment_results (business_id, person_id, kind, value, confidence, source, status, reviewed_at)
select id, '50000000-0000-0000-0000-000000000001'::uuid, 'email', 'paula@example.test', 0.9, 'test', 'promoted', now() - interval '1 day' from hh
union all
select id, '50000000-0000-0000-0000-000000000005'::uuid, 'facebook', 'https://www.facebook.com/felix.fb', 0.8, 'test', 'promoted', now() - interval '1 day' from hh;
