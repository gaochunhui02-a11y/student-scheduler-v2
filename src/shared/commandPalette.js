// Pure logic for the command palette (V2-F). No DOM, no i18n: commands are
// plain objects the caller builds ({ id, title, keywords?, group?, run }),
// and this file only decides which ones match a query, in what order, and
// whether a keypress should open the palette at all.

// Lowercase, trim, and strip diacritics so "resume" matches "Résumé".
export function normalizeForSearch(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Scores how well `query` matches `text`; null = no match. Tiers, highest
// first: exact > prefix > word-start > substring > in-order subsequence
// ("opln" -> "Open Planner"). Shorter texts win ties so the most specific
// command floats up. Works for CJK too (substring/subsequence by char).
export function scoreMatch(query, text) {
  const q = normalizeForSearch(query);
  const s = normalizeForSearch(text);
  if (!q) return 0;
  if (!s) return null;
  const lengthPenalty = Math.min(s.length, 100) / 1000;
  if (s === q) return 1000;
  if (s.startsWith(q)) return 800 - lengthPenalty;
  const wordStart = s.split(/[\s\-_/·]+/).some((w) => w.startsWith(q));
  if (wordStart) return 600 - lengthPenalty;
  const idx = s.indexOf(q);
  if (idx !== -1) return 400 - idx - lengthPenalty;

  // Subsequence: every query char appears in order; tighter = better.
  let pos = -1;
  let gaps = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const next = s.indexOf(ch, pos + 1);
    if (next === -1) return null;
    if (pos !== -1) gaps += next - pos - 1;
    pos = next;
  }
  return Math.max(1, 200 - gaps - lengthPenalty);
}

// Best score across a command's title and keywords (keywords score a bit
// lower than the title so a title hit always ranks first).
export function scoreCommand(command, query) {
  const titleScore = scoreMatch(query, command.title);
  let best = titleScore;
  (command.keywords || []).forEach((k) => {
    const ks = scoreMatch(query, k);
    if (ks !== null) {
      const adjusted = ks * 0.9;
      if (best === null || adjusted > best) best = adjusted;
    }
  });
  return best;
}

// V4-I: an optional scope prefix narrows the palette to one kind of thing:
//   ">" commands & pages · "t:" tasks · "p:" projects · "g:" goals ·
//   "n:" notes · "c:" courses · "r:" routines · "e:" exams
export const SCOPES = {
  '>': ['create', 'navigate', 'commands', 'settings', 'spaces'],
  't:': ['tasks'], 'p:': ['projects'], 'g:': ['goals'], 'n:': ['notes'], 'c:': ['courses'], 'r:': ['routines', 'routinesToday'], 'e:': ['exams'],
};
export function parseScope(query) {
  const raw = String(query ?? '');
  const trimmed = raw.replace(/^\s+/, '');
  const prefix = Object.keys(SCOPES).find((p) => trimmed.toLowerCase().startsWith(p));
  if (!prefix) return { groups: null, rest: raw };
  return { groups: SCOPES[prefix], rest: trimmed.slice(prefix.length) };
}

// Matching commands, best first. An empty query returns every command in
// its original order (the caller's order is the "suggested" order).
export function filterCommands(commands, rawQuery, limit = 50) {
  const { groups, rest: query } = parseScope(rawQuery);
  const list = (commands || []).filter((c) => c && c.title && (!groups || groups.includes(c.group)));
  if (!normalizeForSearch(query)) return list.slice(0, limit);
  return list
    .map((c, index) => ({ c, index, score: scoreCommand(c, query) }))
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.c);
}

// True when the keyboard focus is somewhere the user is typing — the
// palette shortcut must never steal Ctrl/Cmd+K from a text field.
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = String(target.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

// Ctrl+K (Windows/Linux) or Cmd+K (macOS), with no Alt/Shift, and not
// while typing in a field.
export function isPaletteShortcut(event) {
  if (!event || String(event.key || '').toLowerCase() !== 'k') return false;
  if (event.altKey || event.shiftKey) return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return !isTypingTarget(event.target);
}

// Keyboard selection that wraps at both ends; -1 when there's nothing.
export function moveSelection(current, delta, count) {
  if (!count) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}
