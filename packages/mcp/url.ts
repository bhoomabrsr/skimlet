export function http(raw: string, base?: string) {
  const url = new URL(raw, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url');
  return url;
}
