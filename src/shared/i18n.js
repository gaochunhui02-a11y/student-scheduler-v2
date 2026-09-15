// Minimal UI-translation layer — English / Simplified Chinese / Japanese.
//
// Scope (Phase 1 of the Board+Translation work): applies only to STATIC app
// UI text via [data-i18n] attributes, always through .textContent — never
// .innerHTML — so a translation can never delete a nested functional child
// element or id (e.g. the #copySourceDateLabel <strong> inside a hint
// paragraph). Dynamically-generated content (the schedule timeline, warning
// bodies, save-status messages, history stats, etc.) is not covered yet;
// that's a deliberate boundary for this phase, not an oversight — see the
// project plan for why.
//
// User-created content (class names, study task names/notes, board node
// text) is never touched by this module and never will be auto-translated.

const STORAGE_KEY = 'student-scheduler-lang';

const en = {
  'nav.overview': 'Overview',
  'nav.planner': 'Planner',
  'nav.history': 'History',
  'nav.settings': 'Settings',
  'header.title': 'Student Scheduler',
  'header.logout': 'Log out',
  'theme.dark': 'Dark mode',
  'theme.light': 'Light mode',
  'lang.label': 'Language',
  'day.title': 'Your Day',
  'day.planningFor': 'Planning for',
  'day.wakeTime': 'Wake-up time',
  'day.sleepTime': 'Sleep time',
  'day.hintBefore': "Staying up past midnight? Enter the early time as-is (e.g.",
  'day.hintAfter': ") — it's read as after midnight, not before your wake-up time.",
  'history.title': 'History',
  'meals.title': 'Meals to include',
  'meals.breakfast': 'Breakfast',
  'meals.lunch': 'Lunch',
  'meals.dinner': 'Dinner',
  'meals.min30': '30 min',
  'meals.min45': '45 min',
  'classes.title': 'Classes',
  'classes.add': 'Add class',
  'study.title': 'Subjects to study',
  'study.add': 'Add subject',
  'prefs.title': 'Study preferences',
  'prefs.preferredTime': 'Preferred study time',
  'prefs.periodNone': 'No preference',
  'prefs.periodMorning': 'Morning',
  'prefs.periodAfternoon': 'Afternoon',
  'prefs.periodEvening': 'Evening',
  'prefs.maxSession': 'Max study session (min)',
  'prefs.breakLength': 'Break length (min)',
  'prefs.minBlock': 'Minimum study block (min)',
  'prefs.earliestTime': 'Earliest study time',
  'prefs.latestTime': 'Latest study time',
  'prefs.hint': 'Leave earliest/latest study time blank to allow studying any time between wake-up and bedtime.',
  'copy.title': 'Copy to another day',
  'copy.hintBefore': 'Copying from',
  'copy.hintAfter': ': wake/sleep time, meals, classes, subjects, and study preferences. Not copied: the generated schedule, locks, or completion.',
  'copy.destDate': 'Destination date',
  'copy.button': 'Copy to another day',
  'actions.generate': 'Generate Schedule',
  'actions.regenerate': 'Regenerate Schedule',
  'lockConflict.title': 'Locked block conflict',
  'schedule.title': 'Your Schedule',
  'legend.class': 'Class',
  'legend.meal': 'Meal',
  'legend.study': 'Study',
  'legend.break': 'Break',
  'legend.free': 'Free time',
  'shortfall.title': 'Not enough available time',
  'summary.title': 'Daily Summary',
  'nav.board': 'Board',
  'board.titleLabel': 'Board title',
  'board.addNode': 'Add node',
  'board.emptyState': 'No nodes yet.',
  'board.noBoardHint': "You don't have a board yet.",
  'board.createBoard': 'Create board',
  'board.zoomIn': 'Zoom in',
  'board.zoomOut': 'Zoom out',
  'board.zoomReset': 'Reset',
  'board.deleteNode': 'Delete node',
  'board.nodeTypeLabel': 'Node type',
  'board.nodeTitlePlaceholder': 'Untitled node',
  'nodeType.goal': 'Goal',
  'nodeType.subject': 'Subject',
  'nodeType.task': 'Task',
  'nodeType.note': 'Note',
  'board.connect': 'Connect',
  'board.dragToConnect': 'Drag to connect',
  'board.deleteConnection': 'Delete connection',
  'board.connectionLabel': 'Connection',
  'board.invalidConnection': 'Invalid connection.',
  'board.connectionExists': 'These nodes are already connected.',
  'board.addToPlanner': 'Add to Planner',
  'board.convertToStudyTask': 'Convert to Study Task',
  'board.taskName': 'Task name',
  'board.estimatedMinutes': 'Estimated Minutes',
  'board.priority': 'Priority',
  'board.dueDate': 'Due Date',
  'board.notes': 'Notes',
  'board.priorityLow': 'Low',
  'board.priorityMedium': 'Medium',
  'board.priorityHigh': 'High',
  'board.cancel': 'Cancel',
  'board.alreadyAdded': 'Already added to Planner',
  'board.viewInPlanner': 'View in Planner',
  'board.taskCreated': 'Task created successfully',
  'board.conversionFailed': 'Conversion failed',
};

const zh = {
  'nav.overview': '概览',
  'nav.planner': '计划',
  'nav.history': '历史',
  'nav.settings': '设置',
  'header.title': '学生日程规划',
  'header.logout': '退出登录',
  'theme.dark': '深色模式',
  'theme.light': '浅色模式',
  'lang.label': '语言',
  'day.title': '今日安排',
  'day.planningFor': '计划日期',
  'day.wakeTime': '起床时间',
  'day.sleepTime': '睡觉时间',
  'day.hintBefore': '熬夜到凌晨？请直接输入较早的时间（例如',
  'day.hintAfter': '），系统会将其理解为凌晨之后，而不是起床时间之前。',
  'history.title': '历史',
  'meals.title': '包含的用餐',
  'meals.breakfast': '早餐',
  'meals.lunch': '午餐',
  'meals.dinner': '晚餐',
  'meals.min30': '30 分钟',
  'meals.min45': '45 分钟',
  'classes.title': '课程',
  'classes.add': '添加课程',
  'study.title': '学习科目',
  'study.add': '添加科目',
  'prefs.title': '学习偏好',
  'prefs.preferredTime': '偏好学习时间',
  'prefs.periodNone': '无偏好',
  'prefs.periodMorning': '上午',
  'prefs.periodAfternoon': '下午',
  'prefs.periodEvening': '晚上',
  'prefs.maxSession': '最长学习时段（分钟）',
  'prefs.breakLength': '休息时长（分钟）',
  'prefs.minBlock': '最短学习时段（分钟）',
  'prefs.earliestTime': '最早学习时间',
  'prefs.latestTime': '最晚学习时间',
  'prefs.hint': '将最早/最晚学习时间留空，即可在起床到睡觉之间的任何时间学习。',
  'copy.title': '复制到其他日期',
  'copy.hintBefore': '复制自',
  'copy.hintAfter': '：起床/睡觉时间、用餐、课程、科目和学习偏好。不会复制：已生成的日程、锁定状态或完成状态。',
  'copy.destDate': '目标日期',
  'copy.button': '复制到其他日期',
  'actions.generate': '生成日程',
  'actions.regenerate': '重新生成日程',
  'lockConflict.title': '锁定项冲突',
  'schedule.title': '你的日程',
  'legend.class': '课程',
  'legend.meal': '用餐',
  'legend.study': '学习',
  'legend.break': '休息',
  'legend.free': '空闲时间',
  'shortfall.title': '学习时间不足',
  'summary.title': '每日总结',
  'nav.board': '看板',
  'board.titleLabel': '看板标题',
  'board.addNode': '添加节点',
  'board.emptyState': '暂无节点。',
  'board.noBoardHint': '你还没有看板。',
  'board.createBoard': '创建看板',
  'board.zoomIn': '放大',
  'board.zoomOut': '缩小',
  'board.zoomReset': '重置',
  'board.deleteNode': '删除节点',
  'board.nodeTypeLabel': '节点类型',
  'board.nodeTitlePlaceholder': '未命名节点',
  'nodeType.goal': '目标',
  'nodeType.subject': '科目',
  'nodeType.task': '任务',
  'nodeType.note': '备注',
  'board.connect': '连接',
  'board.dragToConnect': '拖动以连接',
  'board.deleteConnection': '删除连接',
  'board.connectionLabel': '连接',
  'board.invalidConnection': '无效的连接。',
  'board.connectionExists': '这两个节点已经连接。',
  'board.addToPlanner': '添加到计划',
  'board.convertToStudyTask': '转换为学习任务',
  'board.taskName': '任务名称',
  'board.estimatedMinutes': '预计分钟数',
  'board.priority': '优先级',
  'board.dueDate': '截止日期',
  'board.notes': '备注',
  'board.priorityLow': '低',
  'board.priorityMedium': '中',
  'board.priorityHigh': '高',
  'board.cancel': '取消',
  'board.alreadyAdded': '已添加到计划',
  'board.viewInPlanner': '在计划中查看',
  'board.taskCreated': '任务创建成功',
  'board.conversionFailed': '转换失败',
};

const ja = {
  'nav.overview': '概要',
  'nav.planner': 'プランナー',
  'nav.history': '履歴',
  'nav.settings': '設定',
  'header.title': '学生スケジューラー',
  'header.logout': 'ログアウト',
  'theme.dark': 'ダークモード',
  'theme.light': 'ライトモード',
  'lang.label': '言語',
  'day.title': '今日の予定',
  'day.planningFor': '計画日',
  'day.wakeTime': '起床時間',
  'day.sleepTime': '就寝時間',
  'day.hintBefore': '夜更かしする予定ですか？早い時刻をそのまま入力してください（例：',
  'day.hintAfter': '）。これは起床時間より前ではなく、深夜以降として扱われます。',
  'history.title': '履歴',
  'meals.title': '含める食事',
  'meals.breakfast': '朝食',
  'meals.lunch': '昼食',
  'meals.dinner': '夕食',
  'meals.min30': '30分',
  'meals.min45': '45分',
  'classes.title': '授業',
  'classes.add': '授業を追加',
  'study.title': '学習科目',
  'study.add': '科目を追加',
  'prefs.title': '学習設定',
  'prefs.preferredTime': '希望する学習時間帯',
  'prefs.periodNone': '指定なし',
  'prefs.periodMorning': '朝',
  'prefs.periodAfternoon': '午後',
  'prefs.periodEvening': '夜',
  'prefs.maxSession': '最大学習セッション（分）',
  'prefs.breakLength': '休憩時間（分）',
  'prefs.minBlock': '最小学習ブロック（分）',
  'prefs.earliestTime': '学習開始の最早時刻',
  'prefs.latestTime': '学習終了の最遅時刻',
  'prefs.hint': '最早/最遅の学習時間を空欄にすると、起床から就寝までいつでも学習できます。',
  'copy.title': '他の日にコピー',
  'copy.hintBefore': 'コピー元：',
  'copy.hintAfter': '：起床/就寝時間、食事、授業、科目、学習設定。コピーされないもの：生成済みのスケジュール、ロック状態、完了状態。',
  'copy.destDate': 'コピー先の日付',
  'copy.button': '他の日にコピー',
  'actions.generate': 'スケジュールを生成',
  'actions.regenerate': 'スケジュールを再生成',
  'lockConflict.title': 'ロックされたブロックの競合',
  'schedule.title': 'あなたのスケジュール',
  'legend.class': '授業',
  'legend.meal': '食事',
  'legend.study': '学習',
  'legend.break': '休憩',
  'legend.free': '空き時間',
  'shortfall.title': '学習時間が不足しています',
  'summary.title': 'デイリーサマリー',
  'nav.board': 'ボード',
  'board.titleLabel': 'ボードタイトル',
  'board.addNode': 'ノードを追加',
  'board.emptyState': 'ノードはまだありません。',
  'board.noBoardHint': 'まだボードがありません。',
  'board.createBoard': 'ボードを作成',
  'board.zoomIn': '拡大',
  'board.zoomOut': '縮小',
  'board.zoomReset': 'リセット',
  'board.deleteNode': 'ノードを削除',
  'board.nodeTypeLabel': 'ノードの種類',
  'board.nodeTitlePlaceholder': '無題のノード',
  'nodeType.goal': '目標',
  'nodeType.subject': '科目',
  'nodeType.task': 'タスク',
  'nodeType.note': 'メモ',
  'board.connect': '接続',
  'board.dragToConnect': 'ドラッグして接続',
  'board.deleteConnection': '接続を削除',
  'board.connectionLabel': '接続',
  'board.invalidConnection': '無効な接続です。',
  'board.connectionExists': 'これらのノードは既に接続されています。',
  'board.addToPlanner': 'プランナーに追加',
  'board.convertToStudyTask': '学習タスクに変換',
  'board.taskName': 'タスク名',
  'board.estimatedMinutes': '推定時間（分）',
  'board.priority': '優先度',
  'board.dueDate': '期限日',
  'board.notes': 'メモ',
  'board.priorityLow': '低',
  'board.priorityMedium': '中',
  'board.priorityHigh': '高',
  'board.cancel': 'キャンセル',
  'board.alreadyAdded': 'プランナーに追加済み',
  'board.viewInPlanner': 'プランナーで見る',
  'board.taskCreated': 'タスクを作成しました',
  'board.conversionFailed': '変換に失敗しました',
};

export const SUPPORTED_LANGUAGES = ['en', 'zh', 'ja'];
const dictionaries = { en, zh, ja };

export function getLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && dictionaries[stored]) return stored;
  } catch {
    // localStorage unavailable (e.g. a strict privacy mode) — fall back to English
  }
  return 'en';
}

export function setLanguage(lang) {
  if (!dictionaries[lang]) return;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // per-viewer convenience only — fine if it can't persist
  }
}

export function t(key) {
  const lang = getLanguage();
  return (dictionaries[lang] && dictionaries[lang][key]) || dictionaries.en[key] || key;
}

// Sets .textContent (never .innerHTML) on every element with [data-i18n]
// under `root`. Because it only ever assigns textContent to the exact
// element carrying the attribute, it can never remove a nested functional
// child or id — the HTML is written so translatable text and functional
// sub-elements are always siblings, never parent/child of a translated node.
//
// [data-i18n-placeholder], [data-i18n-aria-label], and [data-i18n-title]
// additionally translate the `placeholder`, `aria-label`, and `title`
// attributes (Phase 3/4, for the Board's controls, including the SVG edge
// hit-lines and the node connection handle) — attribute-only, so these
// never touch an element's children either.
//
// Called on every language switch, so it re-sweeps the whole document,
// including Board nodes/edges rendered after the page loaded (they carry
// the same data-i18n* attributes at render time — see src/board/board.js).
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  document.documentElement.lang = getLanguage();
}
