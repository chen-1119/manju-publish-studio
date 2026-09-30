import { matchesKind, uniqueResults } from './search.js';

export function selectTrending(results, now = Date.now(), limit = 6) {
  const cutoff = now - 31 * 86400000;
  return uniqueResults(results
    .filter((item) => matchesKind(item, 'works'))
    .filter((item) => item.publishedAt && Date.parse(item.publishedAt) >= cutoff))
    .sort((a, b) => (b.heat || 0) - (a.heat || 0)
      || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, limit);
}
