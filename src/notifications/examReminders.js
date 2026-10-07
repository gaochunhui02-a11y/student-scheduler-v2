// "Exam approaching" reminders (V3). Opt-in, off by default, stored apart
// from the V2 reminder settings so those stay exactly as they were. Fires
// at most once per exam per stage (3 days before, the day before, the day
// of) and only when notification permission is already granted — this
// module never asks for permission itself.

import { diffDays } from '../shared/dates.js';

const STORAGE_KEY = 'student-scheduler-exam-reminders';
const SENT_KEY = 'student-scheduler-exam-reminders-sent';
const POLL_MS = 30 * 60 * 1000;

// Pure: which reminder stage (if any) applies today.
export function examReminderStage(examDate, today) {
  if (!examDate || !today) return null;
  const days = diffDays(today, examDate);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === 3) return 'in3';
  return null;
}

export function examReminderKey(examId, stage, examDate) {
  return `${examId}:${examDate}:${stage}`;
}

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // per-device convenience only
  }
}

export function examRemindersEnabled() {
  return read(STORAGE_KEY, false) === true;
}
export function setExamRemindersEnabled(on) {
  write(STORAGE_KEY, Boolean(on));
}

/**
 * @param {object} p
 * @param {() => string} p.today
 * @param {() => Promise<Array<{id,name,exam_date}>>} p.loadExams
 * @param {(stage:string, exam:object) => {title:string, body:string}} p.format
 */
export function startExamReminders({ today, loadExams, format }) {
  async function check() {
    if (!examRemindersEnabled()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    let exams = [];
    try {
      exams = await loadExams();
    } catch {
      return;
    }
    const day = today();
    // Sent keys persist per device so a reload doesn't repeat today's reminder;
    // keep only recent ones.
    const sent = read(SENT_KEY, []).filter((k) => typeof k === 'string').slice(-200);
    (exams || []).forEach((exam) => {
      const stage = examReminderStage(exam.exam_date, day);
      if (!stage) return;
      const key = examReminderKey(exam.id, stage, exam.exam_date);
      if (sent.includes(key)) return;
      sent.push(key);
      const { title, body } = format(stage, exam);
      try {
        // eslint-disable-next-line no-new
        new Notification(title, { body, icon: '/icons/icon-192.png' });
      } catch {
        // some browsers only allow notifications from a service worker
      }
    });
    write(SENT_KEY, sent);
  }
  setTimeout(check, 8000);
  setInterval(check, POLL_MS);
  return { check };
}
