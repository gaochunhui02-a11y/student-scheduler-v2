// Task dependencies (V3-H), pure. An edge { task_id, depends_on_id } means
// "task waits on prerequisite": Draft depends on Outline. Edges are stored
// between ROOT task rows (task groups), never between multi-day chunks.

export function buildDependencyIndex(deps = []) {
  const prereqs = new Map(); // taskId -> Set(prereqId)
  const dependents = new Map(); // prereqId -> Set(taskId)
  deps.forEach((d) => {
    if (!prereqs.has(d.task_id)) prereqs.set(d.task_id, new Set());
    prereqs.get(d.task_id).add(d.depends_on_id);
    if (!dependents.has(d.depends_on_id)) dependents.set(d.depends_on_id, new Set());
    dependents.get(d.depends_on_id).add(d.task_id);
  });
  return { prereqs, dependents };
}

// Would adding "taskId depends on prereqId" create a loop? True if prereqId
// already (transitively) depends on taskId, or if they are the same task.
export function wouldCreateCycle(deps, taskId, prereqId) {
  if (!taskId || !prereqId) return false;
  if (taskId === prereqId) return true;
  const { prereqs } = buildDependencyIndex(deps);
  const stack = [prereqId];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    (prereqs.get(id) || new Set()).forEach((next) => stack.push(next));
  }
  return false;
}

// Finds an existing cycle (corrupted data) — returns the ids in the loop or null.
export function findCycle(deps = []) {
  const { prereqs } = buildDependencyIndex(deps);
  const state = new Map(); // 1 = visiting, 2 = done
  const path = [];
  function visit(id) {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return path.slice(path.indexOf(id));
    state.set(id, 1);
    path.push(id);
    for (const next of prereqs.get(id) || []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, 2);
    return null;
  }
  for (const id of prereqs.keys()) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

/**
 * Blocked state for each task group.
 * @param {Array} groups task groups (taskModel.buildTaskGroups) — need id, name, done, dependencyOverride
 * @param {Array} deps   task_dependencies rows
 * @returns {Map<string, {blocked:boolean, overridden:boolean, waitingOn:Array<{id,name}>, prereqIds:string[], dependentIds:string[]}>}
 */
export function computeBlockedState(groups = [], deps = []) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const { prereqs, dependents } = buildDependencyIndex(deps);
  const out = new Map();
  groups.forEach((g) => {
    const prereqIds = [...(prereqs.get(g.id) || [])];
    // A prerequisite we can't see (deleted / outside the loaded window) is
    // treated as not blocking — we never block on unknown data.
    const waitingOn = prereqIds.map((id) => byId.get(id)).filter((p) => p && !p.done).map((p) => ({ id: p.id, name: p.name }));
    const blockedByDeps = !g.done && waitingOn.length > 0;
    out.set(g.id, {
      blocked: blockedByDeps && !g.dependencyOverride,
      overridden: blockedByDeps && Boolean(g.dependencyOverride),
      waitingOn,
      prereqIds,
      dependentIds: [...(dependents.get(g.id) || [])],
    });
  });
  return out;
}

// Ordered chain for display: prerequisites before dependents (Kahn's
// algorithm, stable by the given order). Tasks in a cycle are appended.
export function topologicalOrder(ids = [], deps = []) {
  const set = new Set(ids);
  const relevant = deps.filter((d) => set.has(d.task_id) && set.has(d.depends_on_id));
  const indegree = new Map(ids.map((id) => [id, 0]));
  relevant.forEach((d) => indegree.set(d.task_id, indegree.get(d.task_id) + 1));
  const order = [];
  const queue = ids.filter((id) => indegree.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    relevant.filter((d) => d.depends_on_id === id).forEach((d) => {
      indegree.set(d.task_id, indegree.get(d.task_id) - 1);
      if (indegree.get(d.task_id) === 0) queue.push(d.task_id);
    });
  }
  ids.forEach((id) => { if (!order.includes(id)) order.push(id); });
  return order;
}

/**
 * Which of today's Planner subjects should be left out of generation
 * because they wait on unfinished work. `subjects` are Planner rows
 * ({id, name, origin_subject_id}); `groups` are task groups covering the
 * subjects' roots and their prerequisites.
 * Returns { allowed:[subject], skipped:[{subject, waitingOn:[{id,name}]}] }.
 */
export function splitBlockedSubjects(subjects = [], groups = [], deps = []) {
  const state = computeBlockedState(groups, deps);
  const allowed = [];
  const skipped = [];
  subjects.forEach((s) => {
    const rootId = s.origin_subject_id || s.id;
    const st = rootId ? state.get(rootId) : null;
    if (st && st.blocked) skipped.push({ subject: s, waitingOn: st.waitingOn });
    else allowed.push(s);
  });
  return { allowed, skipped };
}
