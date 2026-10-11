// V4-H notes (safe Markdown, model, templates), the resource library and
// project templates.
// Run: node tests/notes-library.test.js

import assert from 'node:assert/strict';
import { renderNoteMarkdown, noteExcerpt, checklistCounts, toggleChecklistItem } from '../src/notes/noteMarkdown.js';
import { validateNoteFields, noteDisplayTitle, filterNotes, sortNotes, cleanTags, templateBody, NOTE_TEMPLATES } from '../src/notes/noteModel.js';
import { filterLibrary, resourceParents, validateResourceFields, RESOURCE_KINDS_V4 } from '../src/resources/resourceModel.js';
import { buildFromTemplate, PROJECT_TEMPLATES, PROJECT_TEMPLATE_IDS } from '../src/projects/projectTemplates.js';

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

console.log('\n=== markdown: formatting ===');
check('headings, lists, checklists, quotes, rules, paragraphs', () => {
  const out = renderNoteMarkdown('# Title\n\nPara one\nline two\n\n- a\n- b\n\n1. x\n2. y\n\n- [ ] todo\n- [x] done\n\n> quote\n\n---');
  assert.match(out, /<h3>Title<\/h3>/);
  assert.match(out, /<p>Para one<br>line two<\/p>/);
  assert.match(out, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(out, /<ol><li>x<\/li><li>y<\/li><\/ol>/);
  assert.match(out, /<ul class="note-checklist"><li class="">.*todo<\/li><li class="is-done">.*done<\/li><\/ul>/);
  assert.match(out, /<blockquote>quote<\/blockquote>/);
  assert.match(out, /<hr>/);
});
check('bold, italic, code, links and bare URLs', () => {
  const out = renderNoteMarkdown('**b** and *i* and `x<y` see [docs](https://a.b/c?d=1&e=2) or https://x.y/z');
  assert.match(out, /<strong>b<\/strong>/);
  assert.match(out, /<em>i<\/em>/);
  assert.match(out, /<code>x&lt;y<\/code>/);
  assert.match(out, /<a href="https:\/\/a\.b\/c\?d=1&amp;e=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  assert.match(out, /<a href="https:\/\/x\.y\/z" target="_blank" rel="noopener noreferrer">https:\/\/x\.y\/z<\/a>/);
});

console.log('\n=== markdown: never unsafe ===');
const evil = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[click](javascript:alert(1))',
  '[x](data:text/html,<script>alert(1)</script>)',
  '[x](https://a.b/"onmouseover="alert(1))',
  '**<b onclick=alert(1)>x</b>**',
  '`<svg onload=alert(1)>`',
  '# <iframe src=//evil>',
  '- [ ] <a href="javascript:x">y</a>',
  'javascript:alert(1)',
  '> <style>body{display:none}</style>',
  'https://a.b/"><script>alert(1)</script>',
];
check('no raw tags, event handlers or non-http links survive', () => {
  evil.forEach((src) => {
    const out = renderNoteMarkdown(src);
    assert.doesNotMatch(out, /<(script|img|iframe|svg|style|b |a href="javascript)/i, src);
    (out.match(/<[^>]+>/g) || []).forEach((tag) => assert.doesNotMatch(tag, /\son\w+=/i, src)); // no event handlers in real tags
    assert.doesNotMatch(out, /href="(?!https?:\/\/)/i, src);
    // every <a> we produce is one of ours
    (out.match(/<a [^>]*>/g) || []).forEach((a) => assert.match(a, /^<a href="https?:\/\/[^"]*" target="_blank" rel="noopener noreferrer">$/, src));
  });
});
check('quotes in URLs cannot break out of the attribute', () => {
  const out = renderNoteMarkdown('[x](https://a.b/"onmouseover="alert(1))');
  assert.doesNotMatch(out, /href="[^"]*"[^>]*onmouseover/);
});

console.log('\n=== markdown: helpers ===');
check('excerpt strips marks and trims; checklist counts and toggling', () => {
  assert.equal(noteExcerpt('# Hello\n- [ ] **world** [link](https://a.b)'), 'Hello world link');
  assert.equal(noteExcerpt('x'.repeat(200), 20).length, 20);
  assert.deepEqual(checklistCounts('- [x] a\n- [ ] b\n* [X] c\n- d'), { done: 2, total: 3 });
  assert.equal(toggleChecklistItem('- [ ] a\n- [ ] b', 1), '- [ ] a\n- [x] b');
  assert.equal(toggleChecklistItem('- [x] a', 0), '- [ ] a');
  assert.equal(toggleChecklistItem('- [ ] a', 5), '- [ ] a');
});

console.log('\n=== notes model ===');
check('validation: title length, body length, not entirely empty; tags cleaned', () => {
  assert.equal(validateNoteFields({ title: '', body: '  ' }).errors.body, 'notes.errEmpty');
  assert.equal(validateNoteFields({ title: 'x'.repeat(201), body: '' }).errors.title, 'notes.errTitleLong');
  assert.equal(validateNoteFields({ title: '', body: 'x'.repeat(50001) }).errors.body, 'notes.errBodyLong');
  const v = validateNoteFields({ title: ' Hi ', body: 'b', tags: '#a, b, a, , c', course_id: 'c1', goal_id: '' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.fields.tags, ['a', 'b', 'c']);
  assert.equal(v.fields.course_id, 'c1');
  assert.equal(v.fields.goal_id, null);
  assert.equal(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20);
});
check('display title falls back to the first line, then Untitled', () => {
  assert.equal(noteDisplayTitle({ title: 'T', body: 'x' }), 'T');
  assert.equal(noteDisplayTitle({ title: '', body: '\n## Lecture 4\nmore' }), 'Lecture 4');
  assert.equal(noteDisplayTitle({ title: '', body: '' }, 'Untitled'), 'Untitled');
});
const notes = [
  { id: '1', title: 'Calc', body: 'limits', tags: ['math'], pinned: false, archived: false, updated_at: '2026-10-10T10:00:00Z', course_id: 'c1' },
  { id: '2', title: 'Ideas', body: 'portfolio', tags: [], pinned: true, archived: false, updated_at: '2026-10-01T10:00:00Z' },
  { id: '3', title: 'Old', body: 'x', tags: [], pinned: false, archived: true, updated_at: '2026-10-12T10:00:00Z' },
];
check('filters: archived kept apart, pinned, linked item, tag, search', () => {
  assert.deepEqual(filterNotes(notes, {}).map((n) => n.id), ['1', '2']);
  assert.deepEqual(filterNotes(notes, { view: 'archived' }).map((n) => n.id), ['3']);
  assert.deepEqual(filterNotes(notes, { view: 'pinned' }).map((n) => n.id), ['2']);
  assert.deepEqual(filterNotes(notes, { linkKind: 'course_id', linkId: 'c1' }).map((n) => n.id), ['1']);
  assert.deepEqual(filterNotes(notes, { tag: 'math' }).map((n) => n.id), ['1']);
  assert.deepEqual(filterNotes(notes, { search: 'PORT' }).map((n) => n.id), ['2']);
  assert.deepEqual(sortNotes(notes).map((n) => n.id), ['2', '3', '1']);
});
check('templates build translated bodies; blank is empty', () => {
  const t = (k) => `[${k}]`;
  assert.equal(templateBody('blank', t), '');
  NOTE_TEMPLATES.filter((x) => x !== 'blank').forEach((id) => {
    const body = templateBody(id, t);
    assert.match(body, /^# \[notes\.tpl/);
    assert.ok(renderNoteMarkdown(body).includes('<h3>'));
  });
});

console.log('\n=== library ===');
const res = [
  { id: 'a', title: 'Syllabus', url: 'https://x.edu/s', kind: 'syllabus', course_id: 'c1', created_at: '1' },
  { id: 'b', title: 'Khan', url: 'https://khan.org', kind: 'video', in_library: true, favorite: true, tags: ['calc'], created_at: '2' },
  { id: 'c', title: 'Design', url: 'https://d.io', kind: 'article', project_id: 'p1', created_at: '3' },
  { id: 'd', title: 'Task link', url: 'https://t.io', kind: 'link', task_id: 't1', created_at: '4' },
];
check('library filters: general, by parent kind, kind, favorites, search; starred first', () => {
  assert.deepEqual(filterLibrary(res, {}).map((r) => r.id), ['b', 'd', 'c', 'a']);
  assert.deepEqual(filterLibrary(res, { parent: 'library' }).map((r) => r.id), ['b']);
  assert.deepEqual(filterLibrary(res, { parent: 'project_id' }).map((r) => r.id), ['c']);
  assert.deepEqual(filterLibrary(res, { kind: 'syllabus' }).map((r) => r.id), ['a']);
  assert.deepEqual(filterLibrary(res, { favorites: true }).map((r) => r.id), ['b']);
  assert.deepEqual(filterLibrary(res, { search: 'calc' }).map((r) => r.id), ['b']);
  assert.deepEqual(resourceParents(res[2]), [['project_id', 'p1']]);
});
check('new kinds accepted; unsafe URLs still rejected', () => {
  assert.equal(RESOURCE_KINDS_V4.length, 10);
  assert.equal(validateResourceFields({ url: 'https://a.b/v', kind: 'video' }).fields.kind, 'video');
  assert.equal(validateResourceFields({ url: 'javascript:alert(1)' }).ok, false);
  assert.equal(validateResourceFields({ url: 'data:text/html,x' }).ok, false);
});

console.log('\n=== project templates ===');
check('every template has milestones and tasks pointing at a real milestone', () => {
  PROJECT_TEMPLATE_IDS.forEach((id) => {
    const tpl = PROJECT_TEMPLATES[id];
    assert.ok(tpl.milestones.length && tpl.tasks.length, id);
    tpl.tasks.forEach(([, minutes, offset, m]) => {
      assert.ok(minutes > 0 && minutes <= 1440);
      assert.ok(offset >= 0 && offset <= tpl.days);
      assert.ok(m >= 0 && m < tpl.milestones.length);
    });
  });
});
check('dates fit the project: default length, or squeezed into a given due date', () => {
  const p = buildFromTemplate('researchPaper', '2026-10-01');
  assert.equal(p.dueDate, '2026-11-12');
  assert.equal(p.milestones.at(-1).dueDate, '2026-11-12');
  const squeezed = buildFromTemplate('researchPaper', '2026-10-01', '2026-10-15');
  assert.ok(squeezed.tasks.every((x) => x.dueDate >= '2026-10-01' && x.dueDate <= '2026-10-15'));
  assert.equal(squeezed.milestones.at(-1).dueDate, '2026-10-15');
  for (let i = 1; i < squeezed.milestones.length; i += 1) assert.ok(squeezed.milestones[i].dueDate >= squeezed.milestones[i - 1].dueDate);
  assert.deepEqual(buildFromTemplate('nope', '2026-10-01'), { milestones: [], tasks: [], dueDate: null });
});

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
