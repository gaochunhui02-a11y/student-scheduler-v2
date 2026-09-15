// Pure aggregation for the History list — no Supabase, no DOM. Given raw rows
// shaped like the Supabase query results data.js's listScheduleHistory()
// fetches (schedules/classes/study_subjects/schedule_items for a user),
// computes per-date stats: how many classes, how many study subjects, and
// study-block completion progress.
//
// @param {{id:string, for_date:string}[]} schedules
// @param {{schedule_id:string}[]} classes
// @param {{schedule_id:string}[]} subjects
// @param {{schedule_id:string, item_type:string, completed:boolean}[]} items
export function aggregateScheduleHistory(schedules, classes, subjects, items) {
  const countBy = (rows) => {
    const map = new Map();
    for (const r of rows) map.set(r.schedule_id, (map.get(r.schedule_id) || 0) + 1);
    return map;
  };
  const classCounts = countBy(classes);
  const subjectCounts = countBy(subjects);

  const studyItemCounts = new Map();
  const completedItemCounts = new Map();
  for (const item of items) {
    if (item.item_type !== 'study') continue;
    studyItemCounts.set(item.schedule_id, (studyItemCounts.get(item.schedule_id) || 0) + 1);
    if (item.completed) completedItemCounts.set(item.schedule_id, (completedItemCounts.get(item.schedule_id) || 0) + 1);
  }

  return schedules.map((s) => {
    const studyBlockCount = studyItemCounts.get(s.id) || 0;
    const completedBlockCount = completedItemCounts.get(s.id) || 0;
    return {
      id: s.id,
      forDate: s.for_date,
      classCount: classCounts.get(s.id) || 0,
      subjectCount: subjectCounts.get(s.id) || 0,
      studyBlockCount,
      completedBlockCount,
      completionPercent: studyBlockCount > 0 ? Math.round((completedBlockCount / studyBlockCount) * 100) : 0,
    };
  });
}
