export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim();
}

export function includesNormalized(haystack: string | undefined, needle: string): boolean {
  return haystack !== undefined && normalizeSearchText(haystack).includes(needle);
}
