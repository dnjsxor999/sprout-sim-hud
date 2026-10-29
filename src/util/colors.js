// The actors of the pipeline and their colour tokens. The colours themselves live in styles.css (`--llm`, `--jev`,
// ...) so that the light and dark themes stay one definition; code refers to them by token name only.

/** Every actor a feed line, a tick or a pulse can belong to. `fail` is not an actor but colours refusals. */
export const ACTORS = ['llm', 'jev', 'engine', 'memory', 'task', 'world', 'run', 'fail'];

export const ACTOR_LABEL = {
  llm: 'LLM',
  jev: 'JEV',
  engine: 'Engine',
  memory: 'Memory',
  task: 'Task',
  world: 'World',
  run: 'Run',
  fail: 'JEV',
};

/** The CSS custom property holding an actor's hue (`var(--jev)`), muted for anything unknown. */
export function actorVar(who) {
  return ACTORS.includes(who) ? `var(--${who})` : 'var(--muted)';
}

/** The CSS custom property holding an actor's ink (its hue tuned for text on the panel background). */
export function actorInk(who) {
  return ACTORS.includes(who) ? `var(--${who}-ink)` : 'var(--muted)';
}

/** The motion channels in display order (the rows of the memory graph). */
export const CHANNELS = ['hand', 'gaze', 'base', 'root'];

/** A computed CSS custom property of the document (for canvas or SVG code that needs a literal colour). */
export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}
