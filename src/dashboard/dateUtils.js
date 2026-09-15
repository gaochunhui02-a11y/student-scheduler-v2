// Pure date-string arithmetic — no Supabase, no DOM. Works entirely in
// "YYYY-MM-DD" strings, deliberately not going through Date#toISOString()
// (which converts to UTC and can land on the wrong calendar day depending on
// the browser's timezone offset from UTC).

function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// `base` defaults to the real current time; tests can pass a fixed Date.
export function tomorrowDateStr(base = new Date()) {
  const d = new Date(base);
  d.setDate(d.getDate() + 1);
  return formatLocalDate(d);
}

export function addDaysToDateStr(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return formatLocalDate(d);
}
