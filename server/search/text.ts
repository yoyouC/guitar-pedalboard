export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Returns the most selective token that PostgreSQL can use to build a superset
 * of the exact application-level matches. Short tokens deliberately skip the
 * database prefilter because trigram matching cannot safely preserve prefixes.
 */
export function searchCandidateToken(value: string): string | null {
  const tokens = normalizeSearchText(value).split(' ').filter(Boolean);
  const longest = tokens.sort((left, right) => right.length - left.length)[0];
  return longest && longest.length >= 4 ? longest : null;
}

function isWithinOneEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const distance = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
      current.push(distance);
      rowMinimum = Math.min(rowMinimum, distance);
    }
    if (rowMinimum > 1) return false;
    previous = current;
  }
  return previous[right.length] <= 1;
}

export function matchesSearchText(query: string, fields: readonly string[]): boolean {
  const queryTokens = normalizeSearchText(query).split(' ').filter(Boolean);
  if (queryTokens.length === 0) return true;
  const documentTokens = fields.flatMap((field) => normalizeSearchText(field).split(' ').filter(Boolean));
  return queryTokens.every((queryToken) => documentTokens.some((documentToken) => (
    documentToken.startsWith(queryToken)
    || (queryToken.length >= 4 && isWithinOneEdit(queryToken, documentToken))
  )));
}

export function marketplaceTagSearchFields(
  tag: MarketplaceTag & { aliases?: readonly string[] },
): string[] {
  return [tag.nameZh, tag.nameEn, ...(tag.aliases ?? [])];
}
import type { MarketplaceTag } from '../../shared/marketplace.js';
