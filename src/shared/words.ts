// Turning what someone typed into search words. Used by the shops' search, the scripted shopper, and the
// retry ladder that the real shopper must climb before it may say "I could not find that".

/** Small words that never help find a product. */
const FILLER = new Set([
  "for", "the", "and", "with", "to", "of", "in", "on", "at", "my", "me", "an", "some", "that", "this", "it", "its",
  "your", "you", "buy", "get", "want", "need", "find", "please", "from", "any", "good", "best", "nice",
]);

/** Lower-case words of a phrase, with filler words dropped and a trailing "s" ignored ("socks" finds "sock"). */
export function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/**
 * Searches to try, in order, when looking for something: what was asked, then only its key words, then fewer and
 * fewer of them (dropping the last each time). "water bottle for hiking" gives
 * "water bottle for hiking", "water bottle hiking", "water bottle", "water".
 */
export function searchLadder(item: string): string[] {
  const asked = item.trim().replace(/\s+/g, " ").toLowerCase();
  const words = item.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !FILLER.has(w));
  const ladder = [asked];
  for (let n = words.length; n >= 1; n--) ladder.push(words.slice(0, n).join(" "));
  return [...new Set(ladder.filter(Boolean))].slice(0, 5);
}
