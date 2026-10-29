// The pipeline reducer: timeline rows -> the HUD state (docs/design/WEB_HUD.md section 8.3).
//
// A row is one record of the experiment timeline (sprout_sim/recorder/timeline.py): `kind`, `t` (sim seconds or
// null), `t_wall` (Unix seconds) and the payload's own keys. Live and replay deliver the same rows, so this one pure
// function drives the page in both modes. It is deterministic (no clocks, no randomness: time comes only from the rows
// and from `tick`), and O(1) per row apart from small bounded lists, because a replay seek re-reduces every row up to
// the target time. Pseudo-rows let the transports hand over what is not a timeline record: `{kind: 'library', items}`
// (the motion memory), `{kind: 'scene', scene, seed}` (the scene dict or name), `{kind: 'robot', mode, state}` (the
// robot's control mode from the live state stream) and `{kind: 'viewer', text}` (the viewer's own action in a live run,
// a dragged object, so the reaction that follows reads as one story).

import { num, isObj, clamp, short, decisionWords, decisionFields, decisionConfidence, bindingsText, fmtCm, fmtP }
  from '../util/format.js';
import { CHANNELS } from '../util/colors.js';

export const FEED_MAX = 500;            // feed lines kept (the feed is the page's only full record)
export const EVENTS_MAX = 50;           // engine events kept
export const PULSES_MAX = 40;           // pulses kept for the panel to animate
export const TEXT_MAX = 400;            // characters of the LLM's last words
export const THINK_FEED_MIN_S = 2.0;    // a gap between a tool answer and the next call this long gets a feed line
export const MARKS_MAX = 64;            // watch / re-edit marks kept on the phase bar
export const STEPS_MAX = 8;             // JEV's steps kept for the current command (the panel shows the last five)
// an extrapolated phase stops short of the end: a motion's last stretch (a grasp closing, a hand settling) can outlast
// its plan, and the bar reads 100 % only when the engine reports the run's end
export const PHASE_EXTRAPOLATION_CAP = 0.99;

const PERCEIVE_TOOLS = new Set(['get_camera_image', 'detect_objects', 'get_depth_at', 'get_robot_state', 'get_contacts',
  'get_task_status']);
const CHOOSE_TOOLS = new Set(['jev_execute', 'jev_modify', 'jev_declare_target', 'jev_stop']);
const DECISION_KEYS = ['face', 'pinch', 'pad_from_top_m', 'elevation_deg', 'yaw_deg', 'via_lift_m', 'clearance_m',
  'point', 'level', 'speed', 'waist', 'min_confidence', 'confidence', 'dimensions', 'exempt', 'reason'];
// the fields a step names when it sums a decision up: the grasp's pose, or where and how a held object is set down
const GIST_GRASP = ['pad_from_top_m', 'elevation_deg', 'yaw_deg'];
const GIST_PLACE = ['clearance_m', 'point', 'level', 'yaw_deg'];
// a step is a sentence, so the card's abbreviated labels are spelled out where they would read as jargon
const STEP_LABEL = { elev: 'elevation', clear: 'clearance' };
// why a decision was taken again, by the change record's kind
const CHANGE_WORDS = { collision: 'collision predicted', modify: 'the LLM modified it', watch: 'the watch asked' };

/** The LLM phase a starting tool call puts the planner in (section 8.3, "Phase rules"). */
export function phaseOfTool(tool) {
  if (PERCEIVE_TOOLS.has(tool)) return 'perceiving';
  if (tool === 'jev_query_options') return 'asking';
  if (CHOOSE_TOOLS.has(tool)) return 'choosing';
  if (tool === 'jev_wait_turn') return 'waiting';
  return 'acting';
}

export function initialState() {
  return {
    seq: 0,        // pulse ids (monotonic: the panel animates each id once)
    feed_seq: 0,   // feed line ids (monotonic: the feed appends what it has not drawn)
    step_seq: 0,   // JEV step ids (monotonic: the panel reveals each id once, in order)
    episode: {
      scene: null, seed: null, task: null, n: null, clock_mode: null, status: 'idle', status_key: null,
      predicates: {}, hud_line: '', outcome: null, message: '', t_start: null, t_elapsed: null,
      t: null, t_wall: null, t0_wall: null,
      regions: [],   // the scene dict's region names (a mover row about one names "the target")
    },
    llm: {
      phase: 'idle', thinking_s: 0, thinking_total_s: 0, thinking_closed_s: 0, gap_t_wall: null,
      text: '', text_t_wall: null, tool: null, calls: [], n_calls: 0,
      image: null, detect: null, choice: null, turn: null,
    },
    jev: {
      busy: null, query: null, menu: null, command: null, decision: null, n_redecisions: 0, refusal: null,
      accepted: null, watch: null, reedits: 0, chain: 0, plan: null, plan_seq: 0,
      // the current command's steps (section 11.2): `{id, t_wall, t, kind, text, tone, decision?, refusal?}`, the newest
      // last; `steps_total` counts the steps the command made (older ones fall off the list), `steps_cmd_t_wall` is
      // when the command started (the steps' time column counts from it)
      steps: [], steps_total: 0, steps_cmd_t_wall: null,
    },
    engine: { run: null, mode: null, control: null, mode_change: null, events: [], fault: null },
    memory: { items: [], added: [], active: null, candidates: [] },
    pulses: [],
    feed: [],
  };
}

// ---- small helpers ------------------------------------------------------------------------------------------------
function feed(s, who, text, tw, t = null, tone = null) {
  if (!text) return;
  s.feed_seq += 1;
  s.feed.push({ n: s.feed_seq, t_wall: tw, t, who, text, tone });
  if (s.feed.length > FEED_MAX) s.feed.shift();
}

function pulse(s, from, to, label, tw) {
  s.seq += 1;
  s.pulses.push({ id: s.seq, from, to, label, t_wall: tw });
  if (s.pulses.length > PULSES_MAX) s.pulses.shift();
}

/** A new command (a question or an execute) begins: its steps start from an empty list. */
function resetSteps(s, tw) {
  s.jev.steps = [];
  s.jev.steps_total = 0;
  s.jev.steps_cmd_t_wall = tw;
}

/** One step of JEV's work on the current command (section 11.2). `tone`: null or 'ok' (teal), 'warn' (amber: a
 * re-decision, a re-edit, an intervention), 'fail' (red: a refusal). `extra` carries the snapshots the decision card
 * and the refusal pill show while this step is the one revealed. */
function addStep(s, kind, text, tw, t, tone = null, extra = null) {
  const j = s.jev;
  s.step_seq += 1;
  j.steps.push({ id: s.step_seq, t_wall: tw, t, kind, text, tone, ...(extra || {}) });
  j.steps_total += 1;
  if (j.steps.length > STEPS_MAX) j.steps.shift();
}

function engineEvent(s, ev, tw, t) {
  s.engine.events.push({ t_wall: tw, t, event: ev.event, motion: ev.motion ?? null, reason: ev.reason ?? null });
  if (s.engine.events.length > EVENTS_MAX) s.engine.events.shift();
}

function trimDecision(d) {
  if (!isObj(d)) return null;
  const o = {};
  for (const k of DECISION_KEYS) if (k in d) o[k] = d[k];
  return o;
}

function kv(args, skip = []) {
  const parts = [];
  for (const [k, v] of Object.entries(isObj(args) ? args : {})) {
    if (skip.includes(k) || v == null) continue;
    parts.push(`${k}=${typeof v === 'string' ? v : short(JSON.stringify(v), 40)}`);
  }
  return short(parts.join(' '), 90);
}

/** A channel guess from a motion id, for motions the library does not list (display only). */
function channelGuess(motion) {
  const m = String(motion ?? '');
  if (/^(look|scan)_/.test(m)) return 'gaze';
  if (/^(walk|turn|strafe|crawl)_/.test(m)) return 'base';
  if (/^lean_/.test(m)) return 'root';
  return 'hand';
}

/** The channel of a motion: the library's when it lists the id, else a guess from the id. */
export function channelOf(state, motion) {
  const it = state.memory.items.find((x) => x.id === motion);
  return it ? it.channel : channelGuess(motion);
}

function normItem(it) {
  const id = String(it.id);
  return {
    id,
    channel: CHANNELS.includes(it.channel) ? it.channel : channelGuess(id),
    intent: it.intent ?? null,
    description: it.description ?? '',
    duration_s: num(it.duration_s),
    success_rate: num(it.success_rate),
    accumulated_from: it.accumulated_from ?? null,
    modes: Array.isArray(it.modes) ? it.modes.slice(0, 8).map(String) : [],
  };
}

function setItems(s, items) {
  if (!Array.isArray(items)) return;
  const next = items.filter((it) => isObj(it) && it.id != null).map(normItem);
  // children learned this episode that the new list does not carry yet (a library message can lag a run end)
  for (const id of s.memory.added) {
    if (!next.some((x) => x.id === id)) {
      const old = s.memory.items.find((x) => x.id === id);
      if (old) next.push(old);
    }
  }
  s.memory.items = next;
}

function addLearned(s, id, parent, channel, tw) {
  if (!s.memory.added.includes(id)) s.memory.added.push(id);
  if (!s.memory.items.some((x) => x.id === id)) {
    const p = s.memory.items.find((x) => x.id === parent);
    s.memory.items.push({
      id,
      channel: CHANNELS.includes(channel) ? channel : (p ? p.channel : channelGuess(parent)),
      intent: p ? p.intent : null,
      description: `kept from a successful run of ${parent}`,
      duration_s: null,
      success_rate: 1,
      accumulated_from: parent ?? null,
      modes: p ? p.modes : [],
      learned_t_wall: tw,
    });
  }
}

// ---- the thinking gap: from a tool answer to the next call ----------------------------------------------------------
function openGap(s, tw) {
  if (tw == null || s.llm.calls.length > 0 || s.llm.phase === 'done') return;
  s.llm.gap_t_wall = tw;
  s.llm.thinking_s = 0;
}

function closeGap(s, tw) {
  if (s.llm.gap_t_wall == null || tw == null) return null;
  const g = Math.max(0, tw - s.llm.gap_t_wall);
  s.llm.thinking_closed_s += g;
  s.llm.thinking_s = g;
  s.llm.thinking_total_s = s.llm.thinking_closed_s;
  s.llm.gap_t_wall = null;
  return g;
}

function setPhase(s, phase) {
  if (s.llm.phase !== 'done') s.llm.phase = phase;
}

// ---- the engine's run -------------------------------------------------------------------------------------------------
function startRun(s, f, tw) {
  const entry = num(f.entry_s, 0);
  const phase = num(f.phase, entry);
  const run = {
    motion: f.motion ?? null,
    channel: CHANNELS.includes(f.channel) ? f.channel : channelOf(s, f.motion),
    arm: f.arm ?? null,
    object_ref: f.object_ref ?? null,
    t_start: num(f.t_start),
    t_wall_start: tw,
    duration_s: num(f.duration_s),
    entry_s: entry,
    phase,
    anchor_t: num(f.t_start),
    anchor_t_wall: tw,
    anchor_phase: phase,
    paused: false,
    pause: null,
    outcome: null,
    reason: null,
    ended: false,
    ended_t_wall: null,
    n_watch: 0,
    n_intervene: 0,   // the decider checks of this run that asked to intervene (the watch line's verdict after the run)
    watch_marks: [],
    reedit_marks: [],
    accumulated: null,
    source: f.source ?? null,
  };
  s.engine.run = run;
  s.memory.active = run.motion;
  return run;
}

/** The run that is still going (optionally: of `motion`), or null. */
function liveRun(s, motion = null) {
  const r = s.engine.run;
  if (!r || r.ended) return null;
  if (motion != null && r.motion != null && r.motion !== motion) return null;
  return r;
}

function anchor(run, phase, t, tw) {
  const p = num(phase);
  if (p == null) return;
  run.phase = clamp(p, 0, 1);
  run.anchor_phase = run.phase;
  run.anchor_t = num(t, run.anchor_t);
  run.anchor_t_wall = tw ?? run.anchor_t_wall;
}

function pushMark(list, phase) {
  const p = num(phase);
  if (p == null) return;
  list.push(clamp(p, 0, 1));
  if (list.length > MARKS_MAX) list.shift();
}

// ---- the menu ----------------------------------------------------------------------------------------------------------
function normCandidate(c) {
  return {
    motion: String(c.motion),
    feasible: c.feasible === true ? true : c.feasible === false ? false : null,
    reason: c.reason ?? null,
    decision: trimDecision(c.decision),
    confidence: num(c.confidence),
    duration_s: num(c.duration_s),
    deviation_needed: num(c.deviation_needed),
    success_rate: num(c.success_rate),
  };
}

function setMenu(s, intent, target, candidates, tw) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => isObj(c) && c.motion != null).map(normCandidate);
  s.jev.menu = { intent: intent ?? null, target: target ?? null, candidates: list, building: false, t_wall: tw };
  s.memory.candidates = list.map((c) => c.motion);
}

function menuText(menu) {
  const n = menu.candidates.length;
  const fit = menu.candidates.filter((c) => c.feasible).map((c) => c.motion);
  return `menu: ${fit.length} of ${n} fit${fit.length ? ` · ${fit.slice(0, 5).join(', ')}${fit.length > 5 ? ', …' : ''}` : ''}`;
}

/** A refusal reason in plain words: "out_of_reach" -> "out of reach", "collision_predicted" -> "collision". */
function reasonWords(reason) {
  if (reason == null || reason === '') return 'refused';
  if (reason === 'collision_predicted') return 'collision';
  return String(reason).replace(/_/g, ' ');
}

/**
 * The menu in one line (section 11.4): `judged 14 candidates for “reach” on obj:cylinder_0 · 2 fit · 3 undecided ·
 * 9 out of reach`. Fit means feasible; undecided means the decider could not choose confidently (an insight settles
 * it); the rest are counted by their reason, the largest group first.
 */
export function menuSummary(menu) {
  if (!menu) return '';
  const list = menu.candidates || [];
  let fit = 0;
  let undecided = 0;
  const rest = new Map();
  for (const c of list) {
    if (c.feasible === true) fit += 1;
    else if (c.reason === 'undecided') undecided += 1;
    else {
      const w = c.feasible === false ? reasonWords(c.reason) : 'not judged';
      rest.set(w, (rest.get(w) || 0) + 1);
    }
  }
  const groups = [...rest.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w, n]) => ` · ${n} ${w}`);
  const n = list.length;
  const what = `${menu.intent ? ` for “${menu.intent}”` : ''}${menu.target ? ` on ${menu.target}` : ''}`;
  return `judged ${n} candidate${n === 1 ? '' : 's'}${what} · ${fit} fit${undecided ? ` · ${undecided} undecided` : ''}${groups.join('')}`;
}

// ---- step wording (section 11.2) ------------------------------------------------------------------------------------------
/** A field with its label for a step: "elevation 0°". The words of the set-down point and of the level speak for
 * themselves ("centre", "level"), as in the feed. */
function stepField(f, value = f.value) {
  return f.key === 'point' || f.key === 'level' ? value : `${STEP_LABEL[f.label] || f.label} ${value}`;
}

/** A decision summed up for a step: "side grasp · pad 2.4 cm · elevation 0° · yaw 0° · conf 0.66". */
function decisionGist(decision) {
  const fields = decisionFields(decision);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const bits = [];
  if (byKey.face) bits.push(`${byKey.face.value} grasp`);
  for (const k of byKey.face || byKey.pinch ? GIST_GRASP : GIST_PLACE) if (byKey[k]) bits.push(stepField(byKey[k]));
  const c = decisionConfidence(decision);
  if (c != null) bits.push(`conf ${c.toFixed(2)}`);
  return bits.join(' · ');
}

/** The fields whose values differ between two decisions: "elevation 0° → 30° · lift 0 cm → 3 cm". */
function decisionDiff(prev, next) {
  if (!isObj(prev) || !isObj(next)) return '';
  const before = new Map(decisionFields(prev).map((f) => [f.key, f.value]));
  return decisionFields(next)
    .filter((f) => before.has(f.key) && before.get(f.key) !== f.value)
    .map((f) => stepField(f, `${before.get(f.key)} → ${f.value}`))
    .join(' · ');
}

/** The first clause of a diagnostic sentence (before a parenthesis, a colon or a semicolon): the step names the cause,
 * the feed and the pill's title keep the whole advice. */
function firstClause(text) {
  const s = String(text ?? '').trim();
  const cut = [' (', ': ', '; ', ' — '].map((m) => s.indexOf(m)).filter((i) => i > 0);
  return cut.length ? s.slice(0, Math.min(...cut)) : s;
}

/** The step a `plan` record makes: what JEV gave the engine. `anchor` is the command's motion (named only when the
 * edited motion is another one). */
function planText(r, anchor) {
  const motion = r.motion ?? 'the motion';
  if (r.channel === 'hand') {
    const D = num(r.D);
    const dur = num(r.duration_s);
    return `edited${anchor && r.motion === anchor ? '' : ` ${motion}`} to the scene${D != null ? ` · D ${D.toFixed(2)}` : ''}`
      + `${dur != null ? ` · ${dur.toFixed(1)} s` : ''} → handed to the engine`;
  }
  if (r.channel === 'gaze') return `aimed ${motion} → handed to the engine`;
  const g = Array.isArray(r.goal) ? r.goal.map((v) => num(v, 0)) : [];
  const moves = [];
  if (Math.abs(g[0] ?? 0) >= 0.005) moves.push(`dx ${g[0].toFixed(2)} m`);
  if (Math.abs(g[1] ?? 0) >= 0.005) moves.push(`dy ${g[1].toFixed(2)} m`);
  if (Math.abs(g[2] ?? 0) >= 0.0087) moves.push(`turn ${Math.round((g[2] * 180) / Math.PI)}°`);
  return `planned ${motion}${moves.length ? ` · ${moves.join(' · ')}` : ''} → handed to the engine`;
}

/** The refusal step: "refused · collision_predicted · the head is turned into the arm's way". */
function refusalStep(s, refusal, tw, t) {
  const why = refusal.why ? firstClause(refusal.why) : '';
  addStep(s, 'refusal', `refused · ${refusal.reason}${why ? ` · ${why}` : ''}`, tw, t, 'fail', { refusal });
}

/** The head moved at `tw` (a gaze run ended, `look_at` or `set_head` answered): an older camera image is stale. */
function headMoved(s, tw) {
  const img = s.llm.image;
  if (img && tw != null && img.t_wall != null && tw > img.t_wall) img.stale = true;
}

/** The latest decision of `motion` among the current command's steps (the one a re-decision changes), or null. */
function stepDecisionOf(j, motion) {
  for (let i = j.steps.length - 1; i >= 0; i--) {
    const d = j.steps[i].decision;
    if (d && d.motion === motion) return d;
  }
  return null;
}

/**
 * The step a decision record makes: the command's own motion decided ("decided · side grasp · …"), another motion
 * of the command decided after the first could not run ("fell back to …"), or a decision taken again, naming the
 * fields that changed from the previous decision of the same motion ("collision predicted → re-decided · elevation
 * 0° → 30° · conf 0.17"; the change's kind and "same values" when no value changed). `d` is the new card snapshot,
 * `prev` the one it replaces.
 */
function decisionStep(s, d, prev, tw, t) {
  const j = s.jev;
  const conf = decisionConfidence(d.decision);
  const confText = conf != null ? ` · conf ${conf.toFixed(2)}` : '';
  if (d.kind === 'redecision') {
    const before = prev && prev.motion === d.motion ? prev : (stepDecisionOf(j, d.motion) ?? prev);
    const diff = decisionDiff(before && before.decision, d.decision);
    const kind = d.change && d.change.kind ? String(d.change.kind) : null;
    const cause = kind ? (CHANGE_WORDS[kind] || kind.replace(/_/g, ' ')) : null;
    const what = diff ? ` · ${diff}` : before ? ' · same values' : '';
    addStep(s, 'redecision', `${cause ? `${cause} → ` : ''}re-decided${what}${confText}`, tw, t, 'warn', { decision: d });
    return;
  }
  const anchor = j.command ? j.command.motion : null;
  if (d.context === 'execute' && anchor != null && d.motion != null && d.motion !== anchor) {
    addStep(s, 'fallback', `fell back to ${d.motion} · decided${conf != null ? ` conf ${conf.toFixed(2)}` : ''}`, tw, t, null,
      { decision: d });
    return;
  }
  const gist = decisionGist(d.decision);
  addStep(s, 'decision', `decided${gist ? ` · ${gist}` : ''}`, tw, t, null, { decision: d });
}

// ---- feed wording (report.py merged_rows, shorter) ------------------------------------------------------------------------
function callText(tool, a) {
  switch (tool) {
    case 'get_camera_image': return `looks through the ${a.camera || 'head'} camera`;
    case 'detect_objects': return `finds the objects in the image${a.method ? ` (${a.method})` : ''}`;
    case 'get_depth_at': {
      const n = Array.isArray(a.pixels) ? a.pixels.length : 1;
      return `measures depth at ${n} pixel${n === 1 ? '' : 's'}`;
    }
    case 'get_robot_state': return 'reads the robot state';
    case 'get_contacts': return 'checks what the hands touch';
    case 'get_task_status': return 'asks whether the task is done';
    case 'jev_memory': return 'lists the motion memory';
    case 'jev_query_options':
      return `asks JEV which motions fit “${a.intent ?? '?'}”${a.target ? ` on ${a.target}` : ''}`;
    case 'jev_execute': {
      const c = parseChoice(a, null);
      const bind = bindingsText(c.bindings);
      return `chooses ${c.motion ?? '?'}${c.allowed.length ? ` (else ${c.allowed.join(', ')})` : ''}`
        + `${bind ? ` · ${bind}` : ''}${c.insight ? ` · “${short(c.insight, 140)}”` : ''}`;
    }
    case 'jev_modify': return `modifies the running motion${kv(a) ? ` · ${kv(a)}` : ''}`;
    case 'jev_stop': return 'stops the motion';
    case 'jev_wait_turn': return `waits for a turn${num(a.max_s) != null ? ` (≤ ${num(a.max_s)} s)` : ''}`;
    case 'jev_declare_target': return `declares the target${kv(a) ? ` · ${kv(a)}` : ''}`;
    default: return `${tool}${kv(a) ? ` ${kv(a)}` : ''}`;
  }
}

function parseChoice(a, tw) {
  const m = a.motion;
  const motion = typeof m === 'string' ? m : isObj(m) ? (m.anchor ?? m.id ?? null) : (a.item_id ?? null);
  const allowed = (isObj(m) && Array.isArray(m.allowed) ? m.allowed : Array.isArray(a.allowed) ? a.allowed : []).map(String);
  return {
    motion: motion == null ? null : String(motion),
    allowed,
    bindings: isObj(a.bindings) ? a.bindings : {},
    insight: typeof a.insight === 'string' && a.insight.trim() ? a.insight.trim() : null,
    wait: typeof a.wait === 'boolean' ? a.wait : null,
    t_wall: tw,
  };
}

function deciderOf(row) {
  return isObj(row.model) && num(row.model.requests, 0) > 0 ? 'model' : 'rules';
}

function watchVerdict(e) {
  const why = typeof e.why === 'string' ? e.why : '';
  const i = why.lastIndexOf(': ');
  const tail = i >= 0 ? why.slice(i + 2).trim() : '';
  if (tail && tail.length <= 40) return tail;
  if (e.intervene) return e.applied ? 'intervened' : 'intervene';
  return 'carry on';
}

// ---- the row handlers ---------------------------------------------------------------------------------------------------
function onMeta(s, r, tw, t) {
  if (r.scene != null) s.episode.scene = String(r.scene);
  if (r.seed != null) s.episode.seed = r.seed;
  if (r.clock_mode != null) s.episode.clock_mode = String(r.clock_mode);
  feed(s, 'run', `simulator up · ${r.scene ?? '?'} · seed ${r.seed ?? '?'}${r.clock_mode ? ` · ${r.clock_mode} clock` : ''}`, tw, t);
}

function onEpisodeStart(s, r, tw, t) {
  const e = s.episode;
  e.n = r.episode ?? e.n;
  if (r.seed != null) e.seed = r.seed;
  e.task = r.task ?? e.task;
  e.t_start = num(r.t, t);
  e.status = 'running';
  e.outcome = null;
  e.message = '';
  e.status_key = null;
  // a new episode: what the blocks show belongs to the old one; the memory (and what it learned) carries over
  Object.assign(s.jev, { busy: null, query: null, menu: null, command: null, decision: null, n_redecisions: 0,
    refusal: null, accepted: null, watch: null, reedits: 0, chain: 0, plan: null, plan_seq: s.jev.plan_seq + 1,
    steps: [], steps_total: 0, steps_cmd_t_wall: null });
  s.engine.run = null;
  s.memory.active = null;
  s.memory.candidates = [];
  s.llm.choice = null;
  s.llm.turn = null;
  if (s.llm.phase === 'done') s.llm.phase = 'idle';
  feed(s, 'task', `episode ${r.episode ?? ''} starts${r.task ? ` · ${r.task}` : ''}`.replace('  ', ' '), tw, t);
}

function onTaskStatus(s, r, tw, t) {
  const e = s.episode;
  if (r.status != null) e.status = String(r.status);
  if (isObj(r.predicates)) e.predicates = { ...r.predicates };
  e.hud_line = r.hud_line ?? e.hud_line;
  e.t_elapsed = num(r.t_elapsed, e.t_elapsed);
  e.message = r.message ?? e.message;
  const key = `${r.status}|${r.hud_line}`;
  if (key !== e.status_key) {
    e.status_key = key;
    feed(s, 'task', `${r.status}${r.hud_line ? ` · ${r.hud_line}` : r.message ? ` · ${r.message}` : ''}`, tw, t);
  }
}

function onEpisodeEnd(s, r, tw, t) {
  const e = s.episode;
  e.outcome = r.status != null ? String(r.status) : 'ended';
  e.status = e.outcome;
  e.message = r.message ?? '';
  if (isObj(r.predicates)) e.predicates = { ...r.predicates };
  e.t_elapsed = num(r.t_elapsed, e.t_elapsed);
  closeGap(s, tw);
  s.llm.phase = 'done';
  feed(s, 'task', `episode end · ${e.outcome}${e.message ? ` — ${short(e.message, 120)}` : ''}`, tw, t,
    e.outcome === 'success' ? 'ok' : 'fail');
}

function onToolStatus(s, r, tw, t) {
  const tool = String(r.tool_id ?? '');
  const state = String(r.state ?? '');
  const args = isObj(r.arguments) ? r.arguments : {};
  if (state === 'starting') {
    const gap = closeGap(s, tw);
    if (gap != null && gap >= THINK_FEED_MIN_S) feed(s, 'llm', `thinks ${gap.toFixed(1)} s`, tw == null ? null : tw - 1e-6, null);
    const call = { id: tool, call_id: r.call_id ?? null, args, t_wall: tw };
    s.llm.calls.push(call);
    if (s.llm.calls.length > 8) s.llm.calls.shift();
    s.llm.tool = call;
    s.llm.n_calls += 1;
    setPhase(s, phaseOfTool(tool));
    onCallStart(s, tool, args, call, tw, t);
    feed(s, 'llm', callText(tool, args), tw, t);
    return;
  }
  if (state === 'error' || state === 'canceled') {
    endCall(s, r.call_id);
    if (tool.startsWith('jev_')) s.jev.busy = null;
    openGap(s, tw);
    if (!s.llm.calls.length) setPhase(s, 'thinking');
    const msg = r.error_message ? `: ${short(r.error_message, 140)}` : '';
    feed(s, tool.startsWith('jev_') ? 'jev' : 'llm', `${tool} ${state}${msg}`, tw, t);
  }
}

function endCall(s, callId) {
  const calls = s.llm.calls;
  let i = callId != null ? calls.findIndex((c) => c.call_id === callId) : -1;
  if (i < 0 && calls.length) i = 0;
  if (i >= 0) calls.splice(i, 1);
  s.llm.tool = calls.length ? calls[calls.length - 1] : null;
}

function onCallStart(s, tool, args, call, tw, t) {
  const j = s.jev;
  if (tool === 'jev_query_options') {
    const intent = args.intent ?? null;
    const target = args.target ?? args.object_id ?? null;
    j.query = { intent, target, call_id: call.call_id, t_wall: tw };
    j.menu = { intent, target, candidates: [], building: true, t_wall: tw };
    j.busy = 'menu';
    // a new question opens a new cycle: the previous command's decision, refusal, re-decisions and steps are history now
    j.decision = null;
    j.n_redecisions = 0;
    j.refusal = null;
    resetSteps(s, tw);
    s.memory.candidates = [];
    pulse(s, 'llm', 'jev', intent ? `intent · ${intent}` : 'intent', tw);
    pulse(s, 'memory', 'jev', 'candidates', tw);
  } else if (tool === 'jev_execute') {
    const c = parseChoice(args, tw);
    // the menu the LLM chose from (if the motion is on it): an undecided candidate is one the insight has to settle
    const cand = j.menu && !j.menu.building ? j.menu.candidates.find((x) => x.motion === c.motion) : null;
    const undecided = !!cand && cand.feasible === false && cand.reason === 'undecided';
    s.llm.choice = c;
    j.busy = 'deciding';
    j.command = { motion: c.motion, call_id: call.call_id, t_wall: tw, refused: false, started: false };
    j.decision = null;
    j.n_redecisions = 0;
    j.refusal = null;
    j.accepted = null;
    j.plan = null;
    j.plan_seq += 1;
    resetSteps(s, tw);
    addStep(s, 'command', `LLM chose ${c.motion ?? 'a motion'}${c.insight ? ' · with an insight' : ''}`
      + `${undecided ? ' · undecided on the menu' : ''}`, tw, t);
    pulse(s, 'llm', 'jev', `chose ${c.motion ?? 'a motion'}${c.insight ? ' · insight' : ''}`, tw);
  } else if (tool === 'jev_modify') {
    j.busy = 'deciding';
    j.command = { motion: j.command?.motion ?? s.engine.run?.motion ?? null, call_id: call.call_id, t_wall: tw,
      refused: false, started: true };
    pulse(s, 'llm', 'jev', 'modify', tw);
  } else if (tool === 'jev_stop') {
    pulse(s, 'llm', 'jev', 'stop', tw);
  } else if (tool === 'jev_declare_target') {
    pulse(s, 'llm', 'jev', 'target', tw);
  }
}

function onToolResult(s, r, tw, t) {
  const tool = String(r.tool_id ?? '');
  const res = isObj(r.result) ? r.result : {};
  endCall(s, r.call_id);
  let phase = 'thinking';
  switch (tool) {
    case 'get_camera_image': {
      const png = res._png;
      const b64 = isObj(png) && typeof png.b64 === 'string' && png.b64 ? png.b64 : null;
      const kind = res.kind ?? (isObj(r.arguments) ? r.arguments.kind : null) ?? 'rgb';
      if (b64 && kind !== 'depth') {
        const img = isObj(res.image) ? res.image : {};
        // `stale`: the head moved after this image was taken (section 11.5); a new image is fresh by definition
        s.llm.image = { b64, t_wall: tw, camera: res.camera ?? null, kind, width: num(img.width), height: num(img.height),
          stale: false };
      }
      if (res.success !== false) pulse(s, 'world', 'llm', 'camera image', tw);
      else feed(s, 'llm', `camera failed: ${res.reason ?? '?'}`, tw, t);
      break;
    }
    case 'detect_objects': {
      const pick = (list) => (Array.isArray(list) ? list : []).filter(isObj).map((o) => ({
        id: String(o.id ?? o.label ?? '?'), bbox: Array.isArray(o.bbox) ? o.bbox.slice(0, 4) : null, occluded: !!o.occluded,
      }));
      const objects = pick(res.objects);
      const regions = pick(res.regions);
      s.llm.detect = { objects, regions, image_size: Array.isArray(res.image_size) ? res.image_size.slice(0, 2) : null,
        camera: res.camera ?? null, t_wall: tw };
      const ids = [...objects, ...regions].map((o) => o.id);
      feed(s, 'llm', ids.length ? `sees ${ids.join(' · ')}` : 'sees nothing it can name', tw, t);
      break;
    }
    case 'jev_memory': {
      if (Array.isArray(res.items) && res.items.length && !s.memory.items.length) setItems(s, res.items);
      feed(s, 'memory', `${num(res.n_items, Array.isArray(res.items) ? res.items.length : 0)} motions in memory`, tw, t);
      break;
    }
    case 'jev_query_options': {
      const j = s.jev;
      if (j.menu && j.menu.building) {
        // no options event reached the timeline: the answer's own list is the menu
        setMenu(s, j.query?.intent ?? res.intent, j.query?.target ?? res.target, res.candidates ?? res.options, tw);
        pulse(s, 'jev', 'llm', `menu · ${j.menu.candidates.length}`, tw);
        feed(s, 'jev', menuText(j.menu), tw, t);
        addStep(s, 'menu', menuSummary(j.menu), tw, t);
      }
      j.query = null;
      j.busy = null;
      break;
    }
    case 'jev_execute': phase = onExecuteResult(s, res, tw, t); break;
    case 'jev_wait_turn': {
      const evs = (Array.isArray(res.events) ? res.events : []).filter(isObj);
      const names = evs.map((e) => `${e.event}${e.reason ? `:${e.reason}` : ''}`);
      s.llm.turn = { n: res.turn ?? null, reason: res.reason ?? null, events: names,
        advice: (Array.isArray(res.advice) ? res.advice : []).slice(0, 3).map(String), waited_s: num(res.waited_s), t_wall: tw };
      phase = evs.length ? 'deciding' : 'thinking';
      const waited = num(res.waited_s);
      feed(s, 'engine', `turn ${res.turn ?? '?'} · ${names.join(', ') || res.reason || 'no events'}${waited != null ? ` · waited ${waited.toFixed(1)} s` : ''}`, tw, t);
      break;
    }
    case 'look_at':
    case 'set_head': {
      // the head turned after the LLM's last image: what the inset shows is no longer what the camera sees
      headMoved(s, tw);
      if (res.success === false) {
        feed(s, 'llm', `${tool} failed${res.reason ? `: ${res.reason}` : ''}${res.message ? ` — ${short(res.message, 100)}` : ''}`, tw, t);
      }
      break;
    }
    default: {
      if (res.success === false) {
        feed(s, 'llm', `${tool} failed${res.reason ? `: ${res.reason}` : ''}${res.message ? ` — ${short(res.message, 100)}` : ''}`, tw, t);
      }
    }
  }
  openGap(s, tw);
  if (!s.llm.calls.length) setPhase(s, phase);
}

function onExecuteResult(s, res, tw, t) {
  const j = s.jev;
  const ex = isObj(res.execute) ? res.execute : res;
  const accepted = ex.accepted === true || res.accepted === true;
  const motion = ex.motion ?? res.motion ?? j.command?.motion ?? null;
  j.busy = null;
  if (!accepted) {
    const reason = ex.reason ?? res.reason ?? 'refused';
    const diag = isObj(ex.diagnostics) ? ex.diagnostics : {};
    if (!j.command || !j.command.refused) {
      // no refusal event reached the timeline (older recordings): the answer's own reason is the refusal
      j.refusal = { reason, why: diag.why ?? diag.message ?? null, motion, t_wall: tw };
      pulse(s, 'jev', 'llm', `refused: ${reason}`, tw);
      feed(s, 'jev', `refused ${motion ?? ''}: ${reason}${diag.why ? ` — ${short(diag.why, 120)}` : ''}`, tw, t, 'fail');
      refusalStep(s, j.refusal, tw, t);
    }
    if (j.command) j.command.refused = true;
    return 'thinking';
  }
  const plan = isObj(ex.plan) ? ex.plan : {};
  const decision = trimDecision(ex.decision);
  j.accepted = { motion, t_wall: tw, duration_s: num(plan.duration_s, num(ex.duration_s)) };
  if (decision && !j.decision) {
    j.decision = { motion, arm: ex.arm ?? null, object_ref: null, decision, decider: decision.decider ?? null,
      context: 'execute', kind: 'decision', change: null, n_reachable: null, n_probed: null, insight: null, t_wall: tw };
  }
  const status = isObj(res.status) ? res.status : {};
  let run = liveRun(s, motion);
  const finished = s.engine.run && s.engine.run.motion === motion && s.engine.run.ended
    && (s.engine.run.ended_t_wall ?? 0) >= (j.command?.t_wall ?? 0);
  if (!run && !finished && status.running !== false) {
    // no plan record started this run (older recordings): the answer of an accepted command starts it
    run = startRun(s, { motion, channel: channelOf(s, motion), t_start: num(ex.t_start, t),
      duration_s: num(plan.duration_s, num(ex.duration_s)), entry_s: num(plan.entry_s, num(status.phase, 0)),
      source: 'result' }, tw);
    pulse(s, 'jev', 'engine', 'edited motion', tw);
  }
  if (j.command) j.command.started = true;
  const words = decision ? decisionWords(decision) : '';
  const dur = j.accepted.duration_s;
  feed(s, 'jev', `accepted ${motion ?? ''}${words ? ` · ${words}` : ''}${dur != null ? ` · ${dur.toFixed(1)} s plan` : ''}`, tw, t);
  return run && !run.ended ? 'executing' : 'thinking';
}

function onJevEvent(s, r, tw, t) {
  const ev = String(r.event ?? '');
  const j = s.jev;
  switch (ev) {
    case 'options': {
      setMenu(s, j.query?.intent ?? r.intent, j.query?.target ?? r.target, r.candidates, tw);
      pulse(s, 'jev', 'llm', `menu · ${j.menu.candidates.length}`, tw);
      feed(s, 'jev', menuText(j.menu), tw, t);
      addStep(s, 'menu', menuSummary(j.menu), tw, t);
      return;
    }
    case 'success': {
      let run = liveRun(s, r.motion);
      if (!run) run = startRun(s, { motion: r.motion, t_start: null, duration_s: num(r.duration_s), source: 'event' }, tw);
      run.outcome = 'success';
      run.phase = 1;
      j.busy = null;
      engineEvent(s, r, tw, t);
      pulse(s, 'engine', 'llm', 'success', tw);
      const seen = Array.isArray(r.seen) && r.seen.length ? ` · sees ${r.seen.join(', ')}` : '';
      feed(s, 'engine', `success · ${r.motion ?? ''}${seen}`, tw, t, 'ok');
      return;
    }
    case 'fail': {
      const diag = isObj(r.diagnostics) ? r.diagnostics : {};
      const motion = r.motion ?? diag.motion ?? j.command?.motion ?? null;
      const run = liveRun(s);
      engineEvent(s, { ...r, motion }, tw, t);
      if (j.busy !== 'deciding' && run) {
        // the running motion failed
        run.outcome = 'fail';
        run.reason = r.reason ?? null;
        pulse(s, 'engine', 'llm', `fail · ${r.reason ?? ''}`.trim(), tw);
        feed(s, 'engine', `failed · ${run.motion ?? motion ?? ''}: ${r.reason ?? '?'}${diag.why ? ` — ${short(diag.why, 100)}` : ''}`, tw, t, 'fail');
        return;
      }
      // JEV refused the command before anything moved
      j.refusal = { reason: r.reason ?? 'refused', why: diag.why ?? diag.message ?? null, motion, t_wall: tw };
      j.busy = null;
      if (j.command) j.command.refused = true;
      pulse(s, 'jev', 'llm', `refused: ${r.reason ?? ''}`, tw);
      feed(s, 'jev', `refused ${motion ?? ''}: ${r.reason ?? '?'}${diag.why ? ` — ${short(diag.why, 120)}` : ''}`, tw, t, 'fail');
      refusalStep(s, j.refusal, tw, t);
      return;
    }
    case 'stalled': {
      engineEvent(s, r, tw, t);
      feed(s, 'engine', `stalled · ${r.motion ?? ''}${num(r.phase) != null ? ` at phase ${num(r.phase).toFixed(2)}` : ''}`, tw, t);
      return;
    }
    case 'scene_changed': {
      engineEvent(s, r, tw, t);
      const run = liveRun(s);
      const disp = num(r.displacement_m);
      const diag = isObj(r.diagnostics) ? r.diagnostics : {};
      const what = `${r.object ?? 'an object'}${disp != null ? ` moved ${fmtCm(disp)}` : ' moved'}`;
      if (r.paused && run) {
        run.paused = true;
        run.pause = { object: r.object ?? null, displacement_m: disp, change: r.change ?? null,
          text: diag.reason ? short(diag.reason, 120) : what, t_wall: tw };
      }
      if (r.paused) pulse(s, 'engine', 'llm', 'scene changed', tw);
      feed(s, 'engine', `scene changed · ${what}${r.paused ? ' · paused for a decision' : ''}`, tw, t);
      return;
    }
    case 'mode_change': {
      onModeChange(s, r, tw, t);
      return;
    }
    default: {
      engineEvent(s, r, tw, t);
      feed(s, 'engine', `event ${ev}${r.motion ? ` · ${r.motion}` : ''}`, tw, t);
    }
  }
}

function onModeChange(s, r, tw, t) {
  const status = String(r.status ?? '');
  s.engine.mode_change = { from: r.from_mode ?? null, to: r.to_mode ?? null, status, motion: r.motion ?? null, t_wall: tw };
  if (status === 'done' && r.to_mode) s.engine.mode = String(r.to_mode);
  feed(s, 'engine', `mode ${r.from_mode ?? '?'} → ${r.to_mode ?? '?'} · ${status || 'change'}`, tw, t);
}

function onTrace(s, r, tw, t) {
  const k = String(r.trace_kind ?? '');
  const j = s.jev;
  switch (k) {
    case 'decision':
    case 'redecision': {
      if (r.context === 'options') {
        // one candidate of the menu being decided: folded into the menu that is being built
        const m = j.menu;
        if (m && m.building && r.motion != null && !m.candidates.some((c) => c.motion === r.motion)) {
          m.candidates.push({ motion: String(r.motion), feasible: null, reason: null, decision: null, confidence: null,
            duration_s: null, deviation_needed: null, success_rate: null, pending: true });
          s.memory.candidates.push(String(r.motion));
        }
        return;
      }
      const prev = j.decision;
      j.decision = {
        motion: r.motion ?? null, arm: r.arm ?? null, object_ref: r.object_ref ?? null, decision: trimDecision(r.decision),
        decider: deciderOf(r), context: r.context ?? null, kind: k, change: isObj(r.change) ? r.change : null,
        n_reachable: num(r.n_reachable), n_probed: num(r.n_probed), insight: r.insight ?? null, t_wall: tw,
      };
      if (k === 'redecision') j.n_redecisions += 1;
      decisionStep(s, j.decision, prev, tw, t);
      const ch = isObj(r.change) && r.change.kind ? ` · after ${r.change.kind}` : '';
      feed(s, 'jev', `${k === 'redecision' ? 're-decides' : 'decides'} ${r.motion ?? ''}${r.object_ref ? ` on ${r.object_ref}` : ''}: `
        + `${decisionWords(r.decision) || '—'}${ch} · ${deciderOf(r)}`, tw, t);
      return;
    }
    case 'plan': {
      j.plan = r;
      j.plan_seq += 1;
      if (r.reedit) {
        const run = liveRun(s, r.motion);
        if (run && num(r.duration_s) != null) run.duration_s = num(r.duration_s);
        return;
      }
      startRun(s, { motion: r.motion, channel: r.channel, arm: r.arm, object_ref: r.object_ref, t_start: t,
        duration_s: r.duration_s, entry_s: r.entry_s, source: 'plan' }, tw);
      addStep(s, 'plan', planText(r, j.command?.motion ?? null), tw, t, 'ok');
      j.busy = null;
      if (j.command) j.command.started = true;
      if (s.llm.tool && CHOOSE_TOOLS.has(s.llm.tool.id)) setPhase(s, 'executing');
      pulse(s, 'jev', 'engine', r.channel === 'hand' ? 'edited motion' : `${r.channel ?? 'motion'} plan`, tw);
      const dur = num(r.duration_s);
      const verb = r.channel === 'hand' ? 'edits' : r.channel === 'gaze' ? 'aims' : 'plans';
      feed(s, 'jev', `${verb} ${r.motion ?? ''}${r.channel === 'hand' ? ' to the scene' : ''}${dur != null ? ` · ${dur.toFixed(1)} s` : ''}`, tw, t);
      return;
    }
    case 'watch': {
      const e = isObj(r.entry) ? r.entry : {};
      let run = liveRun(s, r.motion);
      if (!run && r.motion != null) {
        run = startRun(s, { motion: r.motion, t_start: num(e.t, t), phase: num(e.phase, 0), source: 'watch' }, tw);
      }
      let n = 1;
      if (run) {
        run.n_watch += 1;
        if (e.intervene) run.n_intervene += 1;
        n = run.n_watch;
        anchor(run, e.phase, num(e.t, t), tw);
        pushMark(run.watch_marks, e.phase);
      }
      j.watch = { motion: r.motion ?? null, p: num(e.p), intervene: !!e.intervene, applied: e.applied ?? null,
        why: e.why ?? null, verdict: watchVerdict(e), n, phase: num(e.phase), t_wall: tw };
      feed(s, 'engine', `watch ${n} · p ${fmtP(e.p)} · ${j.watch.verdict}`, tw, t);
      if (e.intervene) {
        // only an intervention is a step: the checks that let the motion carry on blink on the watch line instead
        const outcome = e.applied === false ? `intervention not applied${e.refused ? ` (${e.refused})` : ''}` : 'intervened';
        addStep(s, 'watch', `watch · p ${fmtP(e.p)} → ${outcome}`, tw, t, 'warn');
      }
      return;
    }
    case 'reedit': {
      const run = liveRun(s, r.motion);
      if (r.installed) {
        j.reedits += 1;
        if (run) {
          pushMark(run.reedit_marks, r.phase);
          anchor(run, r.entry_s ?? r.phase, t, tw);
        }
        pulse(s, 'jev', 'engine', 're-edited', tw);
        const moved = num(r.object_moved_m);
        feed(s, 'jev', `re-edits ${r.motion ?? ''} at phase ${fmtP(r.phase)}${moved != null ? ` · object moved ${fmtCm(moved)}` : ''}${r.new_decision ? ' · new decision' : ''}`, tw, t);
        addStep(s, 'reedit', `${moved != null ? `object moved ${fmtCm(moved)} → ` : ''}re-edited at phase ${fmtP(r.phase)}`,
          tw, t, 'warn');
      } else {
        feed(s, 'jev', `re-edit of ${r.motion ?? ''} refused: ${r.reason ?? '?'}`, tw, t);
      }
      return;
    }
    case 'chain': {
      if (r.installed) {
        j.chain = num(r.n_runs, j.chain + 1);
        pulse(s, 'jev', 'engine', 're-decided', tw);
        feed(s, 'jev', `re-decides ${r.motion ?? ''} mid-run: run ${j.chain} from phase ${fmtP(r.entry_s)}`, tw, t);
        addStep(s, 'chain', `re-decided mid-run → run ${j.chain} from phase ${fmtP(r.entry_s)}`, tw, t, 'warn');
      } else {
        feed(s, 'jev', `mid-run re-decision of ${r.motion ?? ''} refused: ${r.reason ?? '?'}`, tw, t);
      }
      return;
    }
    case 'resume': {
      const run = liveRun(s, r.motion);
      if (run) {
        run.paused = false;
        run.pause = null;
        anchor(run, r.phase, t, tw);
      }
      feed(s, 'engine', `resumes ${r.motion ?? ''}${r.why ? ` (${short(r.why, 60)})` : ''}`, tw, t);
      return;
    }
    case 'run_end': {
      let run = s.engine.run;
      if (!run || run.ended || (r.motion != null && run.motion != null && run.motion !== r.motion)) {
        run = startRun(s, { motion: r.motion, channel: r.channel, arm: r.arm, object_ref: r.object_ref,
          t_start: r.t_start, duration_s: r.duration_s, source: 'run_end' }, tw);
      }
      if (CHANNELS.includes(r.channel)) run.channel = r.channel;
      run.arm = r.arm ?? run.arm;
      run.outcome = r.outcome != null ? String(r.outcome) : (run.outcome ?? 'ended');
      run.reason = r.reason ?? null;
      run.phase = num(r.phase, run.phase);
      run.ended = true;
      run.paused = false;
      run.ended_t_wall = tw;
      run.run_s = num(r.duration_s);
      s.memory.active = null;
      j.busy = null;
      if (run.channel === 'gaze') headMoved(s, tw);
      const dur = num(r.duration_s);
      feed(s, 'engine',
        `run end · ${r.motion ?? ''} [${run.channel}] ${run.outcome}${r.reason ? ` (${r.reason})` : ''}${dur != null ? ` in ${dur.toFixed(1)} s` : ''}`,
        tw, t, run.outcome === 'success' ? 'ok' : 'fail');
      if (r.accumulated) {
        const id = String(r.accumulated);
        run.accumulated = id;
        addLearned(s, id, r.motion ?? null, run.channel, tw);
        pulse(s, 'engine', 'memory', `kept as ${id}`, tw);
        feed(s, 'memory', `kept as ${id} — a child of ${r.motion ?? '?'}`, tw, t, 'ok');
      }
      return;
    }
    case 'mode_change': {
      onModeChange(s, r, tw, t);
      return;
    }
    default:
      feed(s, 'jev', short(`${k} ${r.motion ?? ''}`, 120), tw, t);
  }
}

function onFault(s, r, tw, t) {
  const rest = {};
  for (const [k, v] of Object.entries(r)) if (!['kind', 't', 't_wall'].includes(k)) rest[k] = v;
  const text = short(JSON.stringify(rest), 140);
  s.engine.fault = { text, t_wall: tw };
  feed(s, 'engine', `robot fault · ${text}`, tw, t, 'fail');
}

function onPlayer(s, r, tw) {
  const k = String(r.kind).slice('player/'.length);
  switch (k) {
    case 'system':
      if (s.llm.phase === 'idle') {
        s.llm.phase = 'thinking';
        openGap(s, tw);
      }
      if (r.subtype === 'init' || r.subtype == null) feed(s, 'llm', `session starts${r.model ? ` · ${r.model}` : ''}`, tw);
      return;
    case 'text': {
      const text = String(r.text ?? '').trim();
      if (!text) return;
      s.llm.text = text.slice(0, TEXT_MAX);
      s.llm.text_t_wall = tw;
      if (s.llm.phase === 'idle') {
        s.llm.phase = 'thinking';
        openGap(s, tw);
      }
      feed(s, 'llm', `“${short(text, 220)}”`, tw);
      return;
    }
    case 'thinking':
      // the content stays private; only the fact that the model is thinking shows
      if (!s.llm.calls.length && s.llm.phase !== 'done') {
        s.llm.phase = 'thinking';
        if (s.llm.gap_t_wall == null) openGap(s, tw);
      }
      return;
    case 'tool_result':
      if (r.is_error) feed(s, 'llm', `${r.tool ?? 'tool'} error at the client: ${short(r.text, 160)}`, tw, null, 'fail');
      return;
    case 'result':
      if (r.subtype !== 'turn.completed') feed(s, 'llm', `session ends · ${r.subtype ?? 'done'}${r.is_error ? ' · error' : ''}`, tw);
      return;
    case 'error':
      feed(s, 'llm', `error · ${short(r.text, 160)}`, tw, null, 'fail');
      return;
    case 'rate_limit': {
      const info = isObj(r.info) ? r.info : null;
      if (info && info.status && info.status !== 'allowed') feed(s, 'llm', `rate limit · ${info.status}`, tw);
      return;
    }
    case 'shell':
      feed(s, 'llm', `shell · ${short(r.command, 120)}`, tw);
      return;
    default:
  }
}

// ---- world rows: the scene changed under the robot (section 4.2) -------------------------------------------------------
function xyText(p) {
  return Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite)
    ? `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})` : null;
}

/** A gate (an opening that closes behind the robot) changed state; the viewport moves its geom from the same row. */
function onGate(s, r, tw, t) {
  const name = r.name ?? '?';
  if (r.state === 'closed') feed(s, 'world', `gate ${name} closed behind the robot`, tw, t);
  else feed(s, 'world', `gate ${name} ${r.state ?? 'changed'}`, tw, t);
}

/** A step of the scene's scripted mover started or finished. A row about a region marker carries the marker's geom
 * (`geom_id`; older recordings only name it, so the scene dict's region names count too); a teleport is one line (its
 * start and its end come together). */
function onObjectMotion(s, r, tw, t) {
  const region = Number.isInteger(r.geom_id) || s.episode.regions.includes(String(r.object));
  const what = region ? `the target ${r.object ?? '?'}` : String(r.object ?? 'an object');
  const mode = r.mode ? String(r.mode) : 'move';
  if (r.state === 'started') {
    if (mode !== 'teleport') feed(s, 'world', `${what} starts to move (${mode})`, tw, t);
    return;
  }
  if (r.state !== 'finished') return;
  const to = xyText(r.to);
  const why = r.reason && r.reason !== mode ? ` · ${r.reason}` : '';
  feed(s, 'world', `${what} moved (${mode})${to ? ` → ${to}` : ''}${why}`, tw, t);
}

const HANDLERS = {
  meta: onMeta,
  'task/episode_start': onEpisodeStart,
  'task/status': onTaskStatus,
  'task/episode_end': onEpisodeEnd,
  'reasoning/tool_status': onToolStatus,
  'lab/tool_result': onToolResult,
  'research/jev_event': onJevEvent,
  'research/jev_trace': onTrace,
  'motor_control/fault': onFault,
  'scene/gate': onGate,
  'scene/object_motion': onObjectMotion,
  runner: (s, r, tw, t) => {
    if (r.what !== 'task') feed(s, 'run', short(String(r.what ?? ''), 120), tw, t);
  },
  library: (s, r) => setItems(s, r.items),
  scene: (s, r) => {
    const sc = isObj(r.scene) ? r.scene : null;
    if (sc && sc.name) s.episode.scene = String(sc.name);
    if (sc && Array.isArray(sc.regions)) s.episode.regions = sc.regions.filter((r) => isObj(r) && r.name).map((r) => String(r.name));
    else if (typeof r.scene === 'string') s.episode.scene = r.scene;
    if (r.seed != null) s.episode.seed = r.seed;
  },
  robot: (s, r) => {
    if (r.mode != null) s.engine.mode = String(r.mode);
    if (r.state != null) s.engine.control = String(r.state);
  },
  viewer: (s, r, tw, t) => feed(s, 'world', short(String(r.text ?? ''), 160), tw, t),
};

/** Fold one row into the state. Returns the state (mutated in place: the HUD re-renders from it). */
export function reduce(s, row) {
  if (!isObj(row)) return s;
  const kind = String(row.kind ?? '');
  const tw = num(row.t_wall);
  const t = num(row.t);
  if (tw != null) {
    if (s.episode.t0_wall == null) s.episode.t0_wall = tw;
    if (s.episode.t_wall == null || tw > s.episode.t_wall) s.episode.t_wall = tw;
  }
  if (t != null && (s.episode.t == null || t > s.episode.t)) s.episode.t = t;
  const fn = HANDLERS[kind] || (kind.startsWith('player/') ? onPlayer : null);
  if (fn) fn(s, row, tw, t);
  return s;
}

/**
 * The time-derived fields at the playback clock `{t, t_wall}` (sim and wall seconds): the seconds of the current
 * thinking gap (and the episode's total), and the running motion's phase, extrapolated from its last known phase at
 * the run's speed until the engine says otherwise.
 */
export function tick(s, clock = {}) {
  const tw = num(clock.t_wall);
  const ts = num(clock.t);
  const llm = s.llm;
  if (tw != null && llm.gap_t_wall != null) {
    llm.thinking_s = Math.max(0, tw - llm.gap_t_wall);
    llm.thinking_total_s = llm.thinking_closed_s + llm.thinking_s;
  }
  const run = s.engine.run;
  if (run && !run.ended && run.outcome == null && !run.paused && num(run.duration_s, 0) > 0) {
    let el = null;
    if (ts != null && run.anchor_t != null) el = ts - run.anchor_t;
    else if (tw != null && run.anchor_t_wall != null) el = tw - run.anchor_t_wall;
    // the plan's duration covers the curve from the entry phase to its end
    const rate = Math.max(0, 1 - num(run.entry_s, 0)) / run.duration_s;
    if (el != null) run.phase = clamp(run.anchor_phase + Math.max(0, el) * rate, 0, Math.max(run.anchor_phase, PHASE_EXTRAPOLATION_CAP));
  }
  return s;
}

/** The actor a row belongs to on the time bar's event ticks, or null for rows that get no tick. */
export function rowActor(row) {
  if (!isObj(row)) return null;
  switch (row.kind) {
    case 'reasoning/tool_status': return row.state === 'starting' ? 'llm' : null;
    case 'player/text': return 'llm';
    case 'research/jev_event':
      if (row.event === 'options') return 'jev';
      if (row.event === 'fail') return 'fail';
      return row.event === 'success' || row.event === 'scene_changed' ? 'engine' : null;
    case 'research/jev_trace':
      if (row.trace_kind === 'run_end') return row.accumulated ? 'memory' : 'engine';
      if ((row.trace_kind === 'decision' || row.trace_kind === 'redecision') && row.context !== 'options') return 'jev';
      return ['reedit', 'chain', 'plan'].includes(row.trace_kind) ? 'jev' : null;
    case 'task/episode_end': return 'task';
    case 'scene/gate': return 'world';
    case 'scene/object_motion': return row.state === 'finished' ? 'world' : null;
    default: return null;
  }
}

/** The ids a recording learned (run ends with `accumulated`): a replay hides them until their run end. */
export function learnedIds(rows) {
  const out = new Set();
  for (const r of rows || []) {
    if (isObj(r) && r.kind === 'research/jev_trace' && r.trace_kind === 'run_end' && r.accumulated) out.add(String(r.accumulated));
  }
  return out;
}
