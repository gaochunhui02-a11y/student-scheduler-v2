// Data access for exams and revision topics (V3-D). Thin queries only.

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}
const nowIso = () => new Date().toISOString();

export function listExams(userId) {
  return cached('exams', async () => unwrap(await supabase.from('exams').select('*').eq('user_id', userId).order('exam_date', { ascending: true })));
}

export function listExamTopics(userId) {
  return cached('exams:topics', async () => unwrap(await supabase.from('exam_topics').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

function changed() {
  invalidate('exams');
  emitChange('exams');
}

export async function createExam(userId, fields) {
  const row = unwrap(await supabase.from('exams').insert({ user_id: userId, ...fields }).select().single());
  changed();
  return row;
}

export async function updateExam(id, fields) {
  const row = unwrap(await supabase.from('exams').update({ ...fields, updated_at: nowIso() }).eq('id', id).select().single());
  changed();
  return row;
}

export async function deleteExam(id) {
  unwrap(await supabase.from('exams').delete().eq('id', id));
  changed();
}

export async function createTopic(userId, fields) {
  const row = unwrap(await supabase.from('exam_topics').insert({ user_id: userId, ...fields }).select().single());
  changed();
  return row;
}

export async function updateTopic(id, fields) {
  const row = unwrap(await supabase.from('exam_topics').update({ ...fields, updated_at: nowIso() }).eq('id', id).select().single());
  changed();
  return row;
}

export async function deleteTopic(id) {
  unwrap(await supabase.from('exam_topics').delete().eq('id', id));
  changed();
}
