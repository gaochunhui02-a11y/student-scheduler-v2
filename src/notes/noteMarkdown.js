// Note rendering (V4-H), pure. A deliberately SMALL Markdown subset, built
// so that a note can never inject HTML or script:
//   1. every character of the note is HTML-escaped first;
//   2. only these patterns are then turned into tags we write ourselves:
//        # / ## / ### headings      - or * bullets       1. numbered items
//        - [ ] / - [x] checklists   > quotes             --- rule
//        **bold**  *italic*  `code`  [text](https://…)  bare https://… links
//   3. links must be http(s) — anything else (javascript:, data:, …) stays
//      plain text — and open with rel="noopener noreferrer" in a new tab.
// Blank lines separate paragraphs; single line breaks are kept.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// Escaped text in → safe inline HTML out.
function inline(escaped) {
  const codes = [];
  let s = escaped.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // [text](url) — url is already escaped; allow only http(s).
  // URLs end at whitespace, ")" or an escaped quote / angle bracket.
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/(?:(?!&quot;|&lt;|&gt;|&#39;)[^\s)])+)\)/g, (_, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  // bare URLs not already inside an href / anchor text we just made
  s = s.replace(/(^|[\s(])(https?:\/\/(?:(?!&quot;|&lt;|&gt;|&#39;)[^\s<)])+)/g, (_, pre, url) => {
    // A sentence's final "." or "," isn't part of the link.
    const m = url.match(/^(.*?)([.,;:!?]*)$/);
    return `${pre}<a href="${m[1]}" target="_blank" rel="noopener noreferrer">${m[1]}</a>${m[2]}`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

/** Note text → safe HTML string. */
export function renderNoteMarkdown(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol' | 'check'
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(escape(l))).join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(list === 'ol' ? '</ol>' : '</ul>');
    list = null;
  };
  const openList = (kind) => {
    if (list === kind) return;
    closeList();
    out.push(kind === 'ol' ? '<ol>' : kind === 'check' ? '<ul class="note-checklist">' : '<ul>');
    list = kind;
  };
  lines.forEach((line) => {
    let m;
    if (!line.trim()) { flushPara(); closeList(); return; }
    if ((m = line.match(/^(#{1,3})\s+(.+)$/))) {
      flushPara(); closeList();
      const level = m[1].length + 2; // # → h3, ## → h4, ### → h5 (the page already has h1/h2)
      out.push(`<h${level}>${inline(escape(m[2].trim()))}</h${level}>`);
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara(); closeList();
      out.push('<hr>');
    } else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      flushPara(); openList('check');
      const done = m[1].toLowerCase() === 'x';
      out.push(`<li class="${done ? 'is-done' : ''}"><span class="note-box" aria-hidden="true">${done ? '✓' : ''}</span><span class="sr-only">${done ? '[x] ' : '[ ] '}</span>${inline(escape(m[2]))}</li>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara(); openList('ul');
      out.push(`<li>${inline(escape(m[1]))}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara(); openList('ol');
      out.push(`<li>${inline(escape(m[1]))}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); closeList();
      out.push(`<blockquote>${inline(escape(m[1]))}</blockquote>`);
    } else {
      closeList();
      para.push(line);
    }
  });
  flushPara();
  closeList();
  return out.join('');
}

/** Plain-text excerpt for lists and search results (Markdown marks removed). */
export function noteExcerpt(text, max = 140) {
  const plain = String(text || '')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^\s*[-*]\s+\[( |x|X)\]\s+/gm, '')
    .replace(/^\s*([-*]|\d+[.)]|>)\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Open / total checklist items in a note ("3 / 5"). */
export function checklistCounts(text) {
  const items = [...String(text || '').matchAll(/^\s*[-*]\s+\[( |x|X)\]\s+/gm)];
  return { done: items.filter((m) => m[1].toLowerCase() === 'x').length, total: items.length };
}

/** Toggles the n-th checklist item in the note text (for ticking in preview). */
export function toggleChecklistItem(text, index) {
  let n = -1;
  return String(text || '').replace(/^(\s*[-*]\s+\[)( |x|X)(\]\s+)/gm, (all, a, mark, b) => {
    n += 1;
    if (n !== index) return all;
    return `${a}${mark.trim() ? ' ' : 'x'}${b}`;
  });
}
