import { COMMON_LAST, firstNameVariants, isCommonName, type PersonName } from './names.ts';
import type { SearchHit } from './search.ts';

// Turns logged-out search results into at most one Facebook profile match.
// Accuracy over volume: Francis reviews every match, and a wrong person is worse
// than no match. Scores run 0–0.95 (never 1; a search result is never proof).

const RESERVED = new Set([
  'pages', 'groups', 'events', 'watch', 'marketplace', 'public', 'search', 'login', 'help', 'policies', 'privacy',
  'stories', 'reel', 'reels', 'hashtag', 'gaming', 'fundraisers', 'business', 'ads', 'share', 'sharer', 'photo.php',
  'photo', 'photos', 'video', 'videos', 'story.php', 'permalink.php', 'media', 'notes', 'l.php', 'dialog', 'plugins',
  'places', 'directory', 'friends', 'messages', 'settings', 'legal', 'careers', 'about', 'home.php', 'recover',
]);

// Normalised profile URL, or null for anything that isn't a personal profile
// (pages, groups, posts, photos, redirect links).
export function profileUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!/(^|\.)facebook\.com$/.test(host) || /^(l|lm|business|developers|about|m\.l)\./.test(host)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'profile.php') {
    const id = u.searchParams.get('id');
    return id && /^\d{5,}$/.test(id) && parts.length === 1 ? `https://www.facebook.com/profile.php?id=${id}` : null;
  }
  if (parts[0] === 'people' && parts.length >= 3 && /^\d{5,}$/.test(parts[2]!)) {
    return `https://www.facebook.com/people/${parts[1]}/${parts[2]}`;
  }
  const name = parts[0]!;
  if (RESERVED.has(name.toLowerCase()) || !/^[A-Za-z0-9.]{5,50}$/.test(name)) return null;
  // A personal profile has letters in its username; all-digit ids are pages.
  if (/^\d+$/.test(name)) return null;
  if (parts.length === 1) return `https://www.facebook.com/${name}`;
  // The person's own post or photo: /<username>/posts/..., /<username>/photos/...
  // The username is the author's profile. Only used when the result's title is
  // the owner's name (checked in scoreHit), so page posts and comments that
  // merely mention the owner are never taken.
  if (['posts', 'photos', 'videos'].includes(parts[1]!)) return `https://www.facebook.com/${name}`;
  return null;
}

// True when the link is a post/photo rather than the profile page itself.
export function isAuthoredContent(raw: string): boolean {
  try {
    const parts = new URL(raw).pathname.split('/').filter(Boolean);
    return parts.length > 1 && ['posts', 'photos', 'videos'].includes(parts[1]!);
  } catch {
    return false;
  }
}

const STATES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan',
  MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire',
  NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma',
  OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee',
  TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
};

export type Subject = {
  person: PersonName;
  coOwnerFirst: string | null; // another owner on the same row, often a spouse
  cities: string[]; // mailing and property city
  states: string[]; // two-letter codes from the row
};

export type Scored = { url: string; score: number; signals: string[] };

function words(s: string): string[] {
  return s.toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);
}

export function scoreHit(hit: SearchHit, s: Subject): Scored | null {
  const url = profileUrl(hit.url);
  if (!url) return null;
  const name = hit.title.replace(/\s*[|\-–—]\s*facebook.*$/i, '').replace(/\(.*?\)/g, ' ');
  const nameWords = words(name);
  const text = `${hit.title} ${hit.snippet}`.toLowerCase();
  const signals: string[] = [];

  // Name: last name and first name (or a nickname) must both be in the profile name.
  const last = s.person.last.split(' ');
  if (!last.every((l) => nameWords.includes(l))) return null;
  const firsts = firstNameVariants(s.person.first);
  const firstIdx = nameWords.findIndex((w) => firsts.has(w));
  if (firstIdx < 0) return null;
  if (nameWords.length > last.length + 3) return null; // a page or a long title, not a person's name
  let score = 0.35;
  signals.push('name');
  if (isAuthoredContent(hit.url)) {
    // A post's title is its author. Require the title to be the name alone and
    // the username to contain the last name, so a post merely about or
    // mentioning the owner is never mistaken for their profile.
    const username = url.split('/').pop()!.toUpperCase().replace(/[^A-Z]/g, '');
    const lastJoined = s.person.last.replace(/[^A-Z]/g, '');
    if (nameWords.length > last.length + 2 || !username.includes(lastJoined)) return null;
    signals.push('from their own post');
  }

  if (s.person.middle) {
    const mid = s.person.middle[0]!;
    const between = nameWords.slice(firstIdx + 1).filter((w) => !last.includes(w));
    if (between.length) {
      if (between.some((w) => w[0] === mid)) {
        score += 0.1;
        signals.push('middle initial');
      } else {
        score -= 0.2;
        signals.push('different middle name');
      }
    }
  }

  // Place: a city from the row in the title or snippet. Another state named
  // where the row has none is a strong sign it's someone else.
  const cityHit = s.cities.find((c) => c && new RegExp(`\\b${escapeRe(c.toLowerCase())}\\b`).test(text));
  const rowStates = new Set(s.states.map((x) => x.toUpperCase()));
  const stateHit = [...rowStates].some((st) => STATES[st] && new RegExp(`\\b${STATES[st]}\\b`).test(text));
  const otherState = Object.entries(STATES).some(
    ([code, full]) => !rowStates.has(code) && new RegExp(`\\b(lives in|from)\\s+[a-z .'-]+,\\s*${full}\\b`).test(text),
  );
  if (cityHit) {
    score += 0.3;
    signals.push(`city: ${cityHit}`);
  } else if (stateHit) {
    score += 0.05;
    signals.push('state only');
  }
  if (otherState) {
    score -= 0.4;
    signals.push('lives in another state');
  }

  if (s.coOwnerFirst) {
    const co = firstNameVariants(s.coOwnerFirst);
    if (words(hit.snippet).some((w) => co.has(w))) {
      score += 0.15;
      signals.push('co-owner named');
    }
  }

  if (isCommonName(s.person)) {
    score -= 0.15;
    signals.push('common name');
  } else if (!s.person.last.split(' ').some((l) => COMMON_LAST.has(l))) {
    score += 0.15;
    signals.push('uncommon name');
  }

  // No place signal at all: never enough, however rare the name.
  if (!cityHit && !stateHit) score = Math.min(score, 0.45);
  return { url, score: Math.max(0, Math.min(0.95, Math.round(score * 100) / 100)), signals };
}

// Best match across all queries for one owner, or null. A close second means we
// can't tell which person it is, so nothing is written.
export function pickMatch(hits: SearchHit[], s: Subject, minConfidence: number): { match: Scored | null; reason: string; considered: number } {
  const byUrl = new Map<string, Scored>();
  for (const h of hits) {
    const sc = scoreHit(h, s);
    if (!sc) continue;
    const prev = byUrl.get(sc.url);
    if (!prev || sc.score > prev.score) byUrl.set(sc.url, sc);
  }
  const ranked = [...byUrl.values()].sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  if (!best) return { match: null, reason: 'no profile with a matching name', considered: 0 };
  if (best.score < minConfidence) return { match: null, reason: `best match too weak (${best.score})`, considered: ranked.length };
  if (second && second.score >= minConfidence && best.score - second.score < 0.15) {
    return { match: null, reason: 'two profiles match about equally', considered: ranked.length };
  }
  return { match: best, reason: 'matched', considered: ranked.length };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
