/** The single replaced span that turns `from` into `to` (common prefix and suffix kept). */
export function replacedSpan(from: string, to: string) {
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let endFrom = from.length, endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) { endFrom--; endTo--; }
  return { index: start, remove: endFrom - start, insert: to.slice(start, endTo) };
}
