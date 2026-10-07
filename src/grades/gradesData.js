// Data access for grade categories and graded items (V3-C).

import { supabase } from '../lib/supabaseClient.js';
import { cached, invalidate } from '../app/store.js';
import { emitChange } from '../app/context.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}
const nowIso = () => new Date().toISOString();

function changed() {
  invalidate('grades');
  emitChange('grades');
}

export function listGradeCategories(userId) {
  return cached('grades:categories', async () => unwrap(await supabase.from('grade_categories').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

export function listGradeItems(userId) {
  return cached('grades:items', async () => unwrap(await supabase.from('grade_items').select('*').eq('user_id', userId).order('sort_order', { ascending: true })));
}

export async function loadGradeData(userId) {
  const [categories, items] = await Promise.all([listGradeCategories(userId), listGradeItems(userId)]);
  return { categories, items };
}

export async function createCategory(userId, courseId, fields, sortOrder = 0) {
  const row = unwrap(await supabase.from('grade_categories').insert({ user_id: userId, course_id: courseId, sort_order: sortOrder, ...fields }).select().single());
  changed();
  return row;
}

export async function createCategories(userId, courseId, list) {
  if (!list.length) return [];
  const rows = unwrap(await supabase.from('grade_categories').insert(list.map((f, i) => ({ user_id: userId, course_id: courseId, sort_order: i, ...f }))).select());
  changed();
  return rows;
}

export async function updateCategory(id, fields) {
  unwrap(await supabase.from('grade_categories').update({ ...fields, updated_at: nowIso() }).eq('id', id));
  changed();
}

export async function deleteCategory(id) {
  unwrap(await supabase.from('grade_categories').delete().eq('id', id));
  changed();
}

export async function createGradeItem(userId, courseId, fields, sortOrder = 0) {
  const row = unwrap(await supabase.from('grade_items').insert({ user_id: userId, course_id: courseId, sort_order: sortOrder, ...fields }).select().single());
  changed();
  return row;
}

export async function updateGradeItem(id, fields) {
  unwrap(await supabase.from('grade_items').update({ ...fields, updated_at: nowIso() }).eq('id', id));
  changed();
}

export async function deleteGradeItem(id) {
  unwrap(await supabase.from('grade_items').delete().eq('id', id));
  changed();
}
