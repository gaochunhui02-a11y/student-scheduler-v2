// How a Focus Mode session ended, for the history row (pure).
export function focusOutcome(kind, completed) {
  if (kind === 'complete') return 'completed';
  return completed ? 'finished_early' : 'stopped';
}
