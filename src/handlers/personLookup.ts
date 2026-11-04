import type { Handler } from '../types.ts';
import { clientBudgetLeft } from '../spend.ts';

// Paid skip trace (decision 2 in the handoff). Not built: the vendor and Francis's
// monthly cap aren't decided, so every job is parked as blocked with the reason.
// When it's built, it must check agent_budget_left before each paid call, record
// cost_cents on the job, and store vendor Do Not Call flags (handoff 4.4, 4.5).
export const personLookup: Handler = async ({ db, job }) => {
  const left = await clientBudgetLeft(db, job.business_id, 'scrub');
  return {
    status: 'blocked',
    error:
      'Paid skip trace is off: the data vendor and monthly budget have not been approved yet ' +
      `(Scrub budget left this month: $${(left / 100).toFixed(2)}).`,
    result: { reason: 'vendor_not_selected', budget_left_cents: left },
  };
};
