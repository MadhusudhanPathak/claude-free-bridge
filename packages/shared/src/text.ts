/** Collapses whitespace and cuts `text` to `max` characters, adding "…" when it was cut. */
export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/** The first line of `text`, shortened. */
export function firstLine(text: string, max: number): string {
  return shorten(text.trim().split('\n')[0], max);
}
