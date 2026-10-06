// Display names for blocks the app generates itself (V2-G). The scheduler
// saves these to schedule_items.name in English ("Break", "Free time",
// "Breakfast"/"Lunch"/"Dinner") — stored data stays exactly as it is; this
// only translates the label at display time. User-created names (classes,
// study tasks) are never touched.

const MEAL_KEYS = { Breakfast: 'meals.breakfast', Lunch: 'meals.lunch', Dinner: 'meals.dinner' };

// @param {string} name — a stored meal name
// @param {(key:string) => string} t
export function mealLabel(name, t) {
  return MEAL_KEYS[name] ? t(MEAL_KEYS[name]) : name;
}

// @param {{type?:string, item_type?:string, name?:string}} block
export function displayBlockName(block, t) {
  if (!block) return '';
  const type = block.type ?? block.item_type;
  if (type === 'break') return t('legend.break');
  if (type === 'free') return t('legend.free');
  if (type === 'meal') return mealLabel(block.name, t);
  return block.name || '';
}
