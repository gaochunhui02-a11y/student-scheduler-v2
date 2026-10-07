// Links attached to courses and tasks (V3-N), pure. Only http(s) URLs are
// ever stored or rendered — anything else (javascript:, data:, file:,
// mailto:, relative paths) is rejected, so a saved link can never run
// script when clicked. Rendering always uses rel="noopener noreferrer".

export const RESOURCE_KINDS = ['link', 'document', 'lecture', 'syllabus', 'reference'];

// "example.com/x" -> "https://example.com/x"; returns null when the value
// can't be made into a safe http(s) URL.
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value || value.length > 2048 || /\s/.test(value)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme) {
    if (!/^https?$/i.test(scheme[1])) return null;
  } else {
    if (value.startsWith('//') || value.startsWith('/')) return null;
    value = `https://${value}`;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.') && url.hostname !== 'localhost') return null;
  if (url.username || url.password) return null; // no credentials in links
  return url.href.length <= 2048 ? url.href : null;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function guessKind(url) {
  const u = String(url || '').toLowerCase();
  if (/syllabus/.test(u)) return 'syllabus';
  if (/\.(pdf|docx?|pptx?|xlsx?)(\?|#|$)/.test(u) || /docs\.google\.com|drive\.google\.com/.test(u)) return 'document';
  if (/youtube\.com|youtu\.be|vimeo\.com|panopto|lecture|zoom\.us\/rec/.test(u)) return 'lecture';
  return 'link';
}

export function validateResourceFields(input = {}) {
  const errors = {};
  const url = normalizeUrl(input.url);
  if (!url) errors.url = 'resources.errUrl';
  let title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
  if (!title && url) title = hostOf(url);
  if (!title) errors.title = 'resources.errTitle';
  const kind = RESOURCE_KINDS.includes(input.kind) ? input.kind : guessKind(url);
  return { ok: Object.keys(errors).length === 0, errors, fields: { url, title, kind, notes: typeof input.notes === 'string' ? input.notes.slice(0, 2000) : '' } };
}
