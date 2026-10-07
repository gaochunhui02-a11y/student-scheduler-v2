// Backup & restore I/O (V3-O). The pure rules live in backupModel.js; this
// file only reads the signed-in user's rows and writes the planned copy.
// Every query is scoped by user_id and RLS enforces the same on the server.

import { supabase } from '../lib/supabaseClient.js';
import { capabilitySnapshot } from '../shared/capabilities.js';
import { BACKUP_TABLES, buildBackup, restoreAvailability, planRestore } from './backupModel.js';

const BATCH = 200;
const PAGE = 1000;

async function fetchTable(name, userId) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(name).select('*').eq('user_id', userId).range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

export async function exportBackup(userId) {
  const { availableTables } = restoreAvailability(capabilitySnapshot());
  const tables = {};
  const errors = {};
  await Promise.all(BACKUP_TABLES.map(async (name) => {
    if (!availableTables.includes(name)) {
      errors[name] = 'not available on this database yet';
      return;
    }
    try {
      tables[name] = await fetchTable(name, userId);
    } catch (err) {
      errors[name] = err.message || 'unavailable';
    }
  }));
  return buildBackup({ tables, errors, exportedAt: new Date().toISOString() });
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// What's already in the account, for conflict detection.
async function loadExisting(userId, caps, tableNames) {
  const existing = { scheduleDates: new Set(), courses: [], semesters: [], ids: {} };
  await Promise.all(tableNames.map(async (name) => {
    const ids = new Set();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from(name).select('id').eq('user_id', userId).range(from, from + PAGE - 1);
      if (error) throw error;
      (data || []).forEach((r) => ids.add(r.id));
      if (!data || data.length < PAGE) break;
    }
    existing.ids[name] = ids;
  }));
  const { data: days, error } = await supabase.from('schedules').select('for_date').eq('user_id', userId);
  if (error) throw error;
  (days || []).forEach((d) => existing.scheduleDates.add(d.for_date));
  if (caps.courses) {
    const { data } = await supabase.from('courses').select('id, name, code').eq('user_id', userId);
    existing.courses = data || [];
  }
  if (caps.semesters) {
    const { data } = await supabase.from('semesters').select('id, name, start_date').eq('user_id', userId);
    existing.semesters = data || [];
  }
  return existing;
}

export async function prepareRestore(userId, validatedTables) {
  const caps = capabilitySnapshot();
  const availability = restoreAvailability(caps);
  const present = availability.availableTables.filter((name) => (validatedTables[name] || []).length);
  const existing = await loadExisting(userId, caps, present);
  return planRestore({ tables: validatedTables, existing, ...availability, newId, userId });
}

/**
 * Inserts the plan in dependency order, in batches. If anything fails, every
 * row this restore inserted is deleted again (children first), so a failed
 * restore leaves the account as it was.
 * @returns {Promise<{ ok:boolean, inserted:number, error?:string, rolledBack?:boolean }>}
 */
export async function executeRestore(plan, { onProgress } = {}) {
  const done = []; // [table, ids[]]
  const total = Object.values(plan.inserts).reduce((s, r) => s + r.length, 0);
  let inserted = 0;
  try {
    for (const table of BACKUP_TABLES) {
      const rows = plan.inserts[table];
      if (!rows || !rows.length) continue;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const { error } = await supabase.from(table).insert(chunk);
        if (error) throw Object.assign(new Error(error.message || 'insert failed'), { table });
        done.push([table, chunk.map((r) => r.id)]);
        inserted += chunk.length;
        if (onProgress) onProgress(inserted, total);
      }
    }
    return { ok: true, inserted };
  } catch (err) {
    let rolledBack = true;
    for (const [table, ids] of done.slice().reverse()) {
      const { error } = await supabase.from(table).delete().in('id', ids);
      if (error) rolledBack = false;
    }
    return { ok: false, inserted: 0, error: err.message, table: err.table, rolledBack };
  }
}
