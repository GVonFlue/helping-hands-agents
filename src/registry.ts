import { makeEntityLookup } from './handlers/entityLookup.ts';
import { messageDraft } from './handlers/messageDraft.ts';
import { personFacebook } from './handlers/personFacebook.ts';
import { personLookup, planSkiptrace, skiptraceCollect, skiptraceDnc, skiptraceSubmit } from './handlers/skiptrace.ts';
import { planDrafts, planFacebook } from './handlers/planners.ts';
import { reportWeekly } from './handlers/reportWeekly.ts';
import type { Handler } from './types.ts';

export const handlers: Record<string, Handler> = {
  // Scrub
  'entity.lookup': makeEntityLookup(null), // no source until the SOS CAPTCHA question is settled
  'person.facebook': personFacebook,
  'person.lookup': personLookup, // CRM "Find info": queued for the next skip-trace batch
  'skiptrace.submit': skiptraceSubmit,
  'skiptrace.collect': skiptraceCollect,
  'skiptrace.dnc': skiptraceDnc,
  // Contact
  'message.draft': messageDraft,
  // Manager
  'report.weekly': reportWeekly,
  'plan.facebook': planFacebook,
  'plan.drafts': planDrafts,
  'plan.skiptrace': planSkiptrace,
};
