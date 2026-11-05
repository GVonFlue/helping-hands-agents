import { RetryableError } from './ai.ts';

// Logged-out web search. The worker only ever calls a search API; it never
// requests facebook.com itself, never logs in and never messages anyone.

export type SearchHit = { url: string; title: string; snippet: string };

export interface SearchProvider {
  readonly name: string; // stored as enrichment_results.source
  search(query: string): Promise<SearchHit[]>;
}

// Keeps calls at least `minIntervalMs` apart, process-wide.
export function rateLimited(provider: SearchProvider, minIntervalMs: number): SearchProvider {
  let next = 0;
  return {
    name: provider.name,
    async search(query) {
      const wait = next - Date.now();
      next = Math.max(Date.now(), next) + minIntervalMs;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return provider.search(query);
    },
  };
}

// Brave Search API adapter. NOT signed off yet: Brave's standard terms forbid
// storing results beyond transient use, and we store the profile URL for review.
// Only enable once a plan whose terms allow that is chosen (see README).
export function braveSearch(apiKey: string): SearchProvider {
  return {
    name: 'logged out search (brave)',
    async search(query) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', '10');
      url.searchParams.set('country', 'us');
      url.searchParams.set('safesearch', 'moderate');
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`search provider busy (${res.status})`, 900);
      if (!res.ok) throw new Error(`search provider error ${res.status}`);
      const body = (await res.json()) as { web?: { results?: { url: string; title?: string; description?: string }[] } };
      return (body.web?.results ?? []).map((r) => ({
        url: r.url,
        title: stripTags(r.title ?? ''),
        snippet: stripTags(r.description ?? ''),
      }));
    },
  };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

// Serper.dev adapter (picked Nov 4 2026). Its terms let customers keep downloaded
// results "for as long as your use case requires" (Usage License, serper.dev/terms);
// written confirmation requested from the vendor before scaling up. Results are
// Google's, scraped by Serper. ~$1 per 1,000 queries (prepaid), 2,500 free.
export function serperSearch(apiKey: string, endpoint = 'https://google.serper.dev/search'): SearchProvider {
  return {
    name: 'logged out search (serper)',
    async search(query) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'us', hl: 'en', num: 10 }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`search provider busy (${res.status})`, 900);
      if (!res.ok) throw new Error(`search provider error ${res.status}`);
      return mapSerper(await res.json());
    },
  };
}

export function mapSerper(body: unknown): SearchHit[] {
  const organic = (body as { organic?: { link?: string; title?: string; snippet?: string }[] })?.organic ?? [];
  return organic
    .filter((r) => typeof r.link === 'string')
    .map((r) => ({ url: r.link!, title: stripTags(r.title ?? ''), snippet: stripTags(r.snippet ?? '') }));
}
