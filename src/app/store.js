// Small request cache shared by V3 views, so moving between Courses,
// Grades and the Dashboard doesn't refetch the same course list over and
// over, and two views asking at once share one in-flight request.
// Writes call invalidate(prefix) so the next read is fresh.

const entries = new Map(); // key -> { promise, at }
const DEFAULT_TTL = 60 * 1000;

export function cached(key, loader, { ttl = DEFAULT_TTL } = {}) {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = Promise.resolve()
    .then(loader)
    .catch((err) => {
      entries.delete(key); // never cache a failure
      throw err;
    });
  entries.set(key, { promise, at: Date.now() });
  return promise;
}

export function invalidate(prefix = '') {
  [...entries.keys()].forEach((key) => {
    if (!prefix || key === prefix || key.startsWith(`${prefix}:`)) entries.delete(key);
  });
}
