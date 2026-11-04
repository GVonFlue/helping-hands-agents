import { makeEntityLookup } from './handlers/entityLookup.ts';
import { messageDraft } from './handlers/messageDraft.ts';
import { personFacebook } from './handlers/personFacebook.ts';
import { personLookup } from './handlers/personLookup.ts';
import { planDrafts, planFacebook } from './handlers/planners.ts';
import { reportWeekly } from './handlers/reportWeekly.ts';
import type { Handler } from './types.ts';

export const handlers: Record<string, Handler> = {
  // Scrub
  'entity.lookup': makeEntityLookup(null), // no source until the SOS CAPTCHA question is settled
  'person.facebook': personFacebook,
  'person.lookup': personLookup, // stub: blocked until vendor + budget are approved
  // Contact
  'message.draft': messageDraft,
  // Manager
  'report.weekly': reportWeekly,
  'plan.facebook': planFacebook,
  'plan.drafts': planDrafts,
};
