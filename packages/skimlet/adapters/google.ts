import { JSDOM } from 'jsdom';
import { parse as domain } from 'tldts';
import { http } from '../url.js';

const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
export const googleHost = (host: string) => {
  const parsed = domain(host);
  return parsed.isIcann && /^(www\.)?google\./.test(host) && parsed.domain === host.replace(/^www\./, '');
};
export const searchUrl = (query: string) => `https://www.google.com/search?${new URLSearchParams({ q: query, hl: 'en', udm: '14' })}`;
export const searchReadySelector = '#rso, #search, #topstuff, #botstuff, form[action*="consent"], form#captcha-form, .g-recaptcha';

const selectors = {
  skip: '[hidden], [aria-hidden="true"], [data-text-ad], [data-ad], #tads, #tadsb, .uEierd, [data-attrid], .related-question-pair',
  snippet: '[data-sncf="1"], .VwiC3b, .IsZvec, .aCOpRe, .st',
};
export type Result = {
  rank: number; title: string; url: string; observedUrl: string; snippet: string;
  linkStatus: 'direct' | 'unwrapped' | 'unresolved' | 'resolved';
};
export function parseGoogle(html: string, pageUrl: string) {
  const current = http(pageUrl);
  const dom = new JSDOM(html, { url: pageUrl }); // No scripts or subresource loading.
  try {
    const doc = dom.window.document, body = clean(doc.body?.textContent);
    if (/^consent\.google\./.test(current.hostname) || doc.querySelector('form[action*="consent.google"]'))
      throw new Error('consent_required');
    if (current.pathname.startsWith('/sorry') || doc.querySelector('form#captcha-form, .g-recaptcha') || /unusual traffic from your computer/i.test(body))
      throw new Error('challenge_detected');
    if (!googleHost(current.hostname) || current.pathname !== '/search') throw new Error('unexpected_search_page');
    const root = doc.querySelector('#rso, #search');
    const results: Result[] = [], seen = new Set<string>();
    for (const heading of root?.querySelectorAll('h3') ?? []) {
      if (heading.closest(selectors.skip)) continue;
      const anchor = heading.closest('a[href]') ?? heading.querySelector('a[href]');
      if (!anchor || !clean(heading.textContent)) continue;
      try {
        const observed = http(anchor.getAttribute('href')!, pageUrl);
        if (/googleadservices\.com$/.test(observed.hostname)) continue;
        let target = observed, linkStatus: Result['linkStatus'] = 'direct';
        if (googleHost(observed.hostname)) {
          if (observed.pathname !== '/url') continue;
          const inner = observed.searchParams.get('url') ?? observed.searchParams.get('q');
          if (inner && /^https?:\/\//i.test(inner)) { target = http(inner); linkStatus = 'unwrapped'; }
          else linkStatus = 'unresolved';
        }
        // Preserve port, path case, query order, parameters, and hash routes.
        if (seen.has(target.href)) continue;
        seen.add(target.href);
        const card = heading.closest('.tF2Cxc, .MjjYud, .g');
        results.push({ rank: results.length + 1, title: clean(heading.textContent).slice(0, 300),
          url: target.href, observedUrl: observed.href, linkStatus,
          snippet: clean(card?.querySelector(selectors.snippet)?.textContent).slice(0, 500) });
      } catch { /* Reject malformed or non-HTTP links, without guessing a destination. */ }
    }
    if (!results.length) {
      const empty = clean(doc.querySelector('#topstuff, #botstuff, #result-stats')?.textContent);
      if (!/did not match any documents|no results found|^0 results/i.test(empty))
        throw new Error(/enable javascript/i.test(body) ? 'javascript_required' : 'layout_changed');
    }
    let next: string | null = null;
    const href = doc.querySelector('a#pnnext, a[rel="next"]')?.getAttribute('href');
    if (href) {
      try {
        const candidate = http(href, pageUrl);
        if (candidate.origin === current.origin && candidate.pathname === '/search' && candidate.searchParams.get('q') === current.searchParams.get('q')) next = candidate.href;
      } catch { /* Invalid pagination must not discard valid results. */ }
    }
    return { results, next };
  } finally { dom.window.close(); }
}
