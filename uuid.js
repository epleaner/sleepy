// PostgreSQL accepts braces, omitted hyphens, and hyphens after groups of four.
// Its uuid column stores and returns the canonical lowercase 8-4-4-4-12 form.
export function canonicalUuid(value) {
  if (typeof value !== 'string') return null;
  const unwrapped = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
  if (!/^(?:[0-9a-fA-F]{4}-?){7}[0-9a-fA-F]{4}$/.test(unwrapped)) return null;
  const hex = unwrapped.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
