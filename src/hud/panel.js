// The pipeline panel: three stacked blocks (LLM · Planner, JEV · Decide, Edit & Watch, Engine · Execute) and the
// connectors between them and to the world (the 3-D view) and the motion memory (docs/design/WEB_HUD.md sections 2,
// 8.1 and 11). Everything is drawn from the reducer's state; the only state kept here is what the DOM already shows
// (so unchanged parts are not touched), which pulses were already animated, and how far JEV's steps are revealed:
// a burst of steps (several decisions and a refusal inside two seconds) is shown one step at a time, and the decision
// card and the refusal pill follow the step being revealed, so the card never flips faster than the eye (section 11.2).

import { h, s, setText, setAttr, setClass, setStyle, setHidden, replay } from '../util/dom.js';
import { short, num, clamp, fmtP, bindingsText, decisionFields, decisionConfidence } from '../util/format.js';
import { actorVar } from '../util/colors.js';
import { PULSE_MS, PULSE_LINGER_MS, MORPH_MS, JEV_DWELL_MS, easeInOutCubic, easeOutCubic, prefersReducedMotion, lerp }
  from '../util/easing.js';
import { menuSummary } from '../model/pipeline.js';

const PULSE_FRESH_S = 3;       // pulses older than this at the playback clock (after a seek) are not animated
const PULSES_LIVE_MAX = 8;     // pulses animating at once (a fast-forward does not flood the wires)
const DETECT_IMAGE_S = 5;      // detections this close to the camera image are drawn on it
// chip rows the menu may take: all the room while JEV builds it, less once the LLM chose and a decision card shows
const MENU_ROWS_BUILDING = 3;
const MENU_ROWS_CHOOSING = 2;
const MENU_ROWS_DECIDED = 1;
const STEPS_VISIBLE = 5;       // JEV's steps shown at once; the older ones of the command fold into "+N earlier"
// a step stays at least JEV_DWELL_MS (at 1x, scaled by 1 / speed) before the next one appears, within these bounds
const DWELL_MIN_MS = 250;
const DWELL_MAX_MS = 1800;
// the steps that belong to deciding the command: while one of them is the last revealed, JEV still reads as deciding
const DECIDING_KINDS = new Set(['command', 'decision', 'redecision', 'fallback']);
const CARD_FIELDS_MAX = 7;     // the decision card holds one row of fields
// past seven fields the card keeps those a reader follows: a grasp's pose, or where and how a held object is set down
const CARD_KEEP_GRASP = ['face', 'pinch', 'pad_from_top_m', 'elevation_deg', 'yaw_deg', 'via_lift_m', 'speed'];
const CARD_KEEP_PLACE = ['clearance_m', 'point', 'level', 'yaw_deg', 'via_lift_m', 'speed'];
const LABEL_IN_MS = 120;       // a pulse's label fades in this fast: it is readable while its dot travels
const LABEL_OUT_MS = 300;      // and fades out over the end of its linger
// a pulse is a dot with two fainter dots trailing it: [lag behind the head as a fraction of the travel, radius, opacity]
const PULSE_TRAIL = [[0, 4.5, 1], [0.035, 3.7, 0.55], [0.07, 3, 0.3]];
// what JEV did with the motion it handed to the engine, by channel (the status after the hand-over)
const HANDED_VERB = { hand: 'Edited', gaze: 'Aimed', base: 'Planned', root: 'Planned' };

const LLM_PERCEIVE_TEXT = {
  get_camera_image: 'Looking through the head camera',
  detect_objects: 'Finding the objects in the image',
  get_depth_at: 'Measuring depth in the image',
  get_robot_state: 'Reading the robot state',
  get_contacts: 'Feeling what the hands touch',
  get_task_status: 'Checking the task',
};
const LLM_ACT_TEXT = {
  set_head: 'Turning the head',
  look_at: 'Turning the head toward a point',
  set_gripper: 'Moving the gripper',
  close_until_contact: 'Closing the hand until it touches',
  set_waist_yaw: 'Turning the waist',
  walk_velocity: 'Walking',
  jev_memory: 'Reading the motion memory',
};

function el(root, sel) {
  return root.querySelector(sel);
}

/** ?still=1: a capture without animations shows every state as it is (no pulses, no pacing). */
function isStill() {
  return document.documentElement.classList.contains('still');
}

/** A status line starts with a capital, like the other blocks' (the step wording it borrows is lower case). */
function sentence(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Show or hide an SVG element. SVG elements have no `hidden` property (only HTML elements do), so `setHidden` would
 * leave their attribute alone; the attribute itself is what the stylesheet hides. */
function setSvgHidden(node, hidden) {
  setAttr(node, 'hidden', hidden ? true : null);
}

// ---- block skeletons ------------------------------------------------------------------------------------------------------
function blockShell(actor, title, sub) {
  return h('article', { class: 'block', 'data-actor': actor },
    h('header', { class: 'bh' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('h2', { class: 'bt' }, title, h('span', { class: 'sub' }, sub)),
      h('span', { class: 'hb' }),
      h('span', { class: 'tag mono' })),
    // only the status words are announced: the thinking seconds next to them change every frame
    h('p', { class: 'status' },
      h('span', { class: 'st', 'aria-live': 'polite' }),
      h('span', { class: 'think', hidden: true },
        h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('span', { class: 'secs mono' }))));
}

function buildLlm() {
  const b = blockShell('llm', 'LLM', 'Planner');
  b.append(h('div', { class: 'llm-body' },
    h('figure', { class: 'cam', hidden: true },
      h('img', { alt: 'The head-camera image the LLM looked at last', decoding: 'async' }),
      s('svg', { class: 'boxes', preserveAspectRatio: 'none', 'aria-hidden': 'true' }),
      h('figcaption', { class: 'mono' },
        h('span', { class: 'age' }),
        h('span', { class: 'moved', hidden: true }, 'head moved since'))),
    h('div', { class: 'llm-col' },
      h('blockquote', { class: 'words' }),
      h('div', { class: 'choice', hidden: true },
        h('span', { class: 'lbl' }, 'chose'),
        h('span', { class: 'chip pick mono' }),
        h('span', { class: 'bind mono' })),
      h('p', { class: 'insight', hidden: true }))));
  return b;
}

function buildJev() {
  const b = blockShell('jev', 'JEV', 'Decide, Edit & Watch');
  // the refusal pill sits on the status line ("Refused right_reach" + the reason): the step list below says the rest,
  // and the block keeps its room for the steps and the card
  el(b, '.status').append(h('span', { class: 'pill fail mono rp', hidden: true }));
  b.append(
    h('div', { class: 'menu', hidden: true }, h('div', { class: 'chips' })),
    h('ol', { class: 'steps', hidden: true, 'aria-label': 'What JEV did for the current command' }),
    h('div', { class: 'card', hidden: true },
      h('div', { class: 'card-main' },
        h('div', { class: 'row-head' },
          h('span', { class: 'lbl' }, 'decision'),
          h('span', { class: 'card-title mono' })),
        h('p', { class: 'card-meta mono' }),
        h('div', { class: 'fields' }),
        h('p', { class: 'reason mono' })),
      s('svg', { class: 'edit', viewBox: '0 0 96 64', hidden: true, role: 'img', 'aria-label': 'The motion before (dashed) and after JEV edited it, seen from above' },
        s('path', { class: 'ghost' }), s('path', { class: 'edited' }), s('circle', { class: 'goal', r: 3.2 }),
        s('circle', { class: 'here', r: 2.4 }), s('text', { class: 'cap', x: 48, y: 62, 'text-anchor': 'middle' }, 'edit · from above'))),
    // the watch: JEV follows every tick of the running motion and asks the decider at periodic checks whether its
    // decision still stands; the three bars tick while the motion runs
    h('p', { class: 'watch', hidden: true },
      h('span', { class: 'wb', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('span', { class: 'wt mono' })));
  return b;
}

function buildEngine() {
  const b = blockShell('engine', 'Engine', 'Execute');
  b.append(h('div', { class: 'run', hidden: true },
    h('div', { class: 'run-head' },
      h('span', { class: 'motion mono' }),
      h('span', { class: 'badge channel mono' }),
      h('span', { class: 'arm' }),
      h('span', { class: 'mode mono' }),
      h('span', { class: 'pill outcome mono', hidden: true })),
    h('div', { class: 'phase' },
      h('div', { class: 'track' }, h('div', { class: 'fill' }), h('div', { class: 'marks' })),
      h('span', { class: 'pct mono' })),
    h('p', { class: 'pause', hidden: true })));
  return b;
}

// ---- status words ------------------------------------------------------------------------------------------------------------
function llmStatus(st) {
  const l = st.llm;
  const tool = l.tool ? l.tool.id : null;
  switch (l.phase) {
    case 'idle': return 'Waiting for the episode to start';
    case 'perceiving': return LLM_PERCEIVE_TEXT[tool] || 'Perceiving the scene';
    case 'thinking': return 'Thinking';
    case 'asking': {
      const q = st.jev.query || st.jev.menu || {};
      return `Asking JEV which motions fit “${q.intent ?? '…'}”${q.target ? ` on ${q.target}` : ''}`;
    }
    case 'choosing': {
      if (tool === 'jev_stop') return 'Stopping the motion';
      if (tool === 'jev_modify') return 'Changing the running motion';
      return l.choice && l.choice.motion ? `Chose ${l.choice.motion}` : 'Choosing a motion';
    }
    case 'executing': return 'Handed the motion to the engine';
    case 'waiting': return 'Waiting for the engine to report';
    case 'deciding': {
      const ev = l.turn && l.turn.events.length ? l.turn.events.join(', ') : 'a turn';
      return `Deciding what next after ${ev}`;
    }
    case 'acting': return LLM_ACT_TEXT[tool] || `Calling ${tool ?? 'a tool'}`;
    case 'done': {
      const o = st.episode.outcome;
      return o === 'success' ? 'Done: the task succeeded' : `Done: ${o ?? 'the episode ended'}`;
    }
    default: return '';
  }
}

/** The run JEV handed to the engine last, when nothing newer (a menu) came after it; null otherwise. */
function handedRun(st) {
  const run = st.engine.run;
  if (!run || run.motion == null) return null;
  const menu = st.jev.menu;
  return !menu || num(run.t_wall_start, -Infinity) >= num(menu.t_wall, -Infinity) ? run : null;
}

/** JEV's status line. `pv` is the paced view of the current command (see `pace`): while its steps are still being
 * revealed the line reads as the step shown, not as the state the burst ended in. */
function jevStatus(st, pv) {
  const j = st.jev;
  if (j.busy === 'menu') {
    const n = j.menu ? j.menu.candidates.length : 0;
    return `Deciding every candidate for this scene${n ? ` · ${n} so far` : ''}`;
  }
  if (j.busy === 'deciding' || pv.deciding) {
    const d = pv.decision;
    if (d && d.kind === 'redecision') return `Re-deciding ${d.motion}${d.change && d.change.kind ? ` after a ${d.change.kind}` : ''}`;
    const m = d ? d.motion : j.command ? j.command.motion : null;
    return m ? `Deciding how to run ${m}` : 'Deciding';
  }
  if (pv.refusal) return `Refused ${pv.refusal.motion ?? 'the motion'}`;
  // after the hand-over JEV keeps saying what it gave the engine, through the run and after it, until a new command
  const run = handedRun(st);
  if (run) return `${HANDED_VERB[run.channel] || 'Planned'} ${run.motion} · handed to the engine`;
  if (j.menu && j.menu.candidates.length) return sentence(menuSummary(j.menu));
  return 'Waiting for the LLM';
}

function jevTag(st, pv) {
  const j = st.jev;
  if (j.busy === 'menu') return 'building the menu';
  if (j.busy === 'deciding' || pv.deciding) return 'deciding';
  if (pv.refusal) return 'refused';
  // JEV follows every tick of a running motion, so it is watching for as long as one runs
  const run = st.engine.run;
  if (run && !run.ended && run.outcome == null) return 'watching';
  return handedRun(st) ? 'idle' : j.menu ? 'menu ready' : 'idle';
}

function engineStatus(st) {
  const e = st.engine;
  const r = e.run;
  if (e.mode_change && e.mode_change.status === 'started') return `Switching the robot to ${e.mode_change.to}`;
  if (!r) return 'Idle';
  if (r.paused) return 'Paused: the scene changed (JEV is deciding)';
  if (!r.ended && r.outcome == null) return `Running ${r.motion}`;
  if (r.outcome === 'success') return `${r.motion} succeeded${num(r.run_s) != null ? ` in ${num(r.run_s).toFixed(1)} s` : ''}`;
  return `${r.motion} failed${r.reason ? `: ${r.reason}` : ''}`;
}

/** The decision card's fields: at most one row of seven, keeping the ones a reader follows when a record has more. */
function cardFields(decision) {
  let fields = decisionFields(decision);
  if (fields.length > CARD_FIELDS_MAX) {
    const keep = fields.some((f) => f.key === 'face' || f.key === 'pinch') ? CARD_KEEP_GRASP : CARD_KEEP_PLACE;
    fields = fields.filter((f) => keep.includes(f.key));
  }
  return fields.slice(0, CARD_FIELDS_MAX);
}

// ---- the panel -----------------------------------------------------------------------------------------------------------------
/**
 * `root`: the panel element. `stage`: the element the connectors are drawn over (it holds the viewport, the panel
 * and the memory strip). `viewport` / `memory`: the elements the world and memory connectors end at.
 *
 * `render(state, ctx)` is called at the HUD's frame rate whether or not the state changed: the paced reveal of JEV's
 * steps advances on these calls. `ctx.speed` is the replay speed (1 when live), which scales the dwell of a step.
 */
export function createPanel(root, { stage, viewport, memory } = {}) {
  const llm = buildLlm();
  const jev = buildJev();
  const eng = buildEngine();
  root.replaceChildren(llm, jev, eng);
  const blocks = { llm, jev, engine: eng };
  const wires = createWires(stage, () => ({ llm, jev, engine: eng, memory, world: viewport }));
  const view = {
    imageB64: null, choiceKey: null, wordsKey: null, menuKey: null, menuN: 0, menuStateKey: null,
    decisionKey: null, cardPrev: null, planSeq: -1, morph: null, marksKey: null, lastPulse: 0, recvTimers: new Map(),
    // JEV's steps: the command they belong to, the id of the last step revealed and when it was revealed
    stepsCmd: undefined, revealId: 0, revealAt: -Infinity, stepsKey: null, watchKey: null,
    relayout: false,   // a resize asked for the wires to be laid out again (done at the next render, not in the observer)
    quiet: true,   // the first render (and the first after a reset) shows the state as it is, without entry animations
  };

  // ---- LLM ------------------------------------------------------------------------------------------------------------------
  function renderLlm(st, ctx) {
    const l = st.llm;
    setClass(llm, 'busy', ['perceiving', 'thinking', 'deciding', 'acting'].includes(l.phase));
    setText(el(llm, '.tag'), l.phase);
    setText(el(llm, '.st'), llmStatus(st));
    const thinking = l.phase === 'thinking' || l.phase === 'deciding';
    setHidden(el(llm, '.think'), !thinking);
    if (thinking) setText(el(llm, '.secs'), `${num(l.thinking_s, 0).toFixed(1)} s`);

    // the camera inset: the last image the LLM asked for, with the boxes it detected in it; once the head has moved
    // after it the image is greyed out and says so (the LLM may still be reasoning from it)
    const cam = el(llm, '.cam');
    if (l.image && l.image.b64 !== view.imageB64) {
      view.imageB64 = l.image.b64;
      el(cam, 'img').src = `data:image/png;base64,${l.image.b64}`;
      if (!view.quiet) replay(cam, 'fresh');
    }
    setHidden(cam, !l.image);
    if (l.image) {
      const age = ctx.t_wall != null ? Math.max(0, ctx.t_wall - l.image.t_wall) : null;
      // the age keeps together (no-break spaces): a narrow inset wraps the caption before it, not inside it
      setText(el(cam, '.age'), `LLM's last image${age != null ? ` · ${age < 1 ? 'now' : `${Math.round(age)}\u00a0s\u00a0ago`}` : ''}`);
      setClass(cam, 'stale', !!l.image.stale);
      setHidden(el(cam, '.moved'), !l.image.stale);
      renderBoxes(el(cam, '.boxes'), l.image, l.detect);
    }

    const words = el(llm, '.words');
    if (l.text_t_wall !== view.wordsKey) {
      view.wordsKey = l.text_t_wall;
      setText(words, l.text ? `“${l.text}”` : '');
      setAttr(words, 'title', l.text || null);
      if (l.text && !view.quiet) replay(words, 'fresh');
    }
    setHidden(words, !l.text);

    // the choice: "chose" while its command is current, "last" once its run ended or a new question began
    const c = l.choice;
    const choice = el(llm, '.choice');
    const insight = el(llm, '.insight');
    setHidden(choice, !c);
    if (c) {
      const run = st.engine.run;
      const asked = st.jev.menu && (st.jev.menu.t_wall ?? 0) > (c.t_wall ?? 0);
      const done = run && run.ended && run.motion === c.motion && (run.ended_t_wall ?? 0) >= (c.t_wall ?? 0);
      const refused = st.jev.refusal && (!st.jev.accepted || st.jev.refusal.t_wall >= st.jev.accepted.t_wall)
        && st.jev.refusal.t_wall >= (c.t_wall ?? 0);
      const stale = asked || done || refused;
      setText(el(choice, '.lbl'), stale ? 'last' : 'chose');
      setClass(choice, 'stale', !!stale);
      setClass(insight, 'stale', !!stale);
      setText(el(choice, '.pick'), c.motion ?? '—');
      setText(el(choice, '.bind'), bindingsText(c.bindings));
      setText(insight, c.insight ? `“${c.insight}”` : '');
      setAttr(insight, 'title', c.insight || null);
      const key = `${c.t_wall}|${c.motion}`;
      if (key !== view.choiceKey) {
        view.choiceKey = key;
        if (!view.quiet) {
          replay(choice, 'fresh');
          if (c.insight) replay(insight, 'fresh');
        }
      }
    }
    setHidden(insight, !c || !c.insight);
    setClass(llm, 'bare', !l.image && !l.text && !c);
  }

  function renderBoxes(svg, image, detect) {
    const ok = detect && detect.image_size && Math.abs((detect.t_wall ?? 0) - (image.t_wall ?? 0)) <= DETECT_IMAGE_S
      && (!detect.camera || !image.camera || detect.camera === image.camera);
    const key = ok ? `${detect.t_wall}` : '';
    if (svg.dataset.key === key) return;
    svg.dataset.key = key;
    svg.replaceChildren();
    if (!ok) return;
    const [w, hgt] = detect.image_size;
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    const scale = (svg.clientWidth || 176) / w;
    const fs = 9 / scale;
    const draw = (o, cls) => {
      if (!Array.isArray(o.bbox) || o.bbox.length < 4) return;
      const [x0, y0, x1, y1] = o.bbox;
      const name = o.id.replace(/^(obj|region):/, '');
      svg.append(s('rect', { class: cls, x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0), rx: 2 / scale },
        s('title', {}, o.id)));
      // the label sits above the box, kept inside the image (right-aligned near the right edge, below near the top)
      const right = x0 > w * 0.6;
      const above = y0 - 3 / scale > fs;
      svg.append(s('text', { class: `${cls}-label`, x: right ? x1 : x0, y: above ? y0 - 3 / scale : Math.min(hgt - 2 / scale, y1 + fs),
        'font-size': fs, 'text-anchor': right ? 'end' : 'start' }, name));
    };
    detect.regions.forEach((o) => draw(o, 'region'));
    detect.objects.forEach((o) => draw(o, 'object'));
  }

  // ---- JEV ------------------------------------------------------------------------------------------------------------------
  /**
   * How far the current command's steps are revealed, and what the block shows for them: `{shown, decision, refusal,
   * last, deciding}`. A new step appears once the one before it has been shown for the dwell; a seek, a reconnect and
   * a still capture show every step at once. The card shows the decision of the last revealed step that carries one
   * and the pill the refusal of a revealed refusal step (the reducer's own `decision` / `refusal` when no step carries
   * one, as in recordings without decision traces).
   */
  function pace(st, ctx) {
    const j = st.jev;
    const steps = j.steps;
    const lastId = steps.length ? steps[steps.length - 1].id : 0;
    if (j.steps_cmd_t_wall !== view.stepsCmd) {
      // a new command: its first step shows at once (the old command's list is gone, nothing has to stay on screen)
      view.stepsCmd = j.steps_cmd_t_wall;
      view.revealId = steps.length ? steps[0].id - 1 : lastId;
      view.revealAt = -Infinity;
    }
    if (view.quiet || isStill()) {
      view.revealId = lastId;
    } else if (view.revealId < lastId) {
      const now = performance.now();
      const speed = num(ctx.speed, 1) > 0 ? num(ctx.speed, 1) : 1;
      if (now - view.revealAt >= clamp(JEV_DWELL_MS / speed, DWELL_MIN_MS, DWELL_MAX_MS)) {
        view.revealId = steps.find((x) => x.id > view.revealId).id;
        view.revealAt = now;
      }
    }
    const shown = steps.filter((x) => x.id <= view.revealId);
    let decision = steps.some((x) => x.decision) ? null : j.decision;
    let refusal = steps.some((x) => x.refusal) ? null : j.refusal;
    for (let i = shown.length - 1; i >= 0; i--) {
      if (!decision && shown[i].decision) decision = shown[i].decision;
      if (!refusal && shown[i].refusal) refusal = shown[i].refusal;
    }
    // a refusal stands until a later acceptance
    if (refusal && j.accepted && refusal.t_wall < j.accepted.t_wall) refusal = null;
    const last = shown.length ? shown[shown.length - 1] : null;
    const deciding = view.revealId < lastId && (!last || DECIDING_KINDS.has(last.kind));
    return { shown, decision, refusal, last, deciding };
  }

  function renderJev(st, ctx) {
    const j = st.jev;
    const pv = pace(st, ctx);
    setClass(jev, 'busy', j.busy != null || pv.deciding);
    setText(el(jev, '.tag'), jevTag(st, pv));
    const status = jevStatus(st, pv);
    setText(el(jev, '.st'), status);
    setAttr(el(jev, '.st'), 'title', status);
    renderBadges(st);
    renderRefusal(pv.refusal);
    renderMenu(st, pv);
    renderSteps(st, pv);
    renderCard(st, pv);
    renderWatch(st);
  }

  function chipFor(c, i, stagger) {
    const chip = h('span', { class: 'chip mono', 'data-motion': c.motion, style: { '--i': String(i) } }, c.motion);
    if (stagger) {
      // the entry plays once; without removing the class a later animation (the LLM considering) would restart it
      chip.classList.add('enter');
      chip.addEventListener('animationend', () => chip.classList.remove('enter'), { once: true });
    }
    return chip;
  }

  function chipTitle(c) {
    if (c.pending) return 'being decided';
    if (c.feasible) {
      const conf = c.confidence != null ? ` · confidence ${c.confidence.toFixed(2)}` : '';
      const dur = c.duration_s != null ? ` · ${c.duration_s.toFixed(1)} s` : '';
      return `fits${conf}${dur}`;
    }
    if (c.reason === 'undecided') return 'undecided: an insight can settle it';
    return `does not fit: ${String(c.reason ?? 'refused').replace(/_/g, ' ')}`;
  }

  function renderMenu(st, pv) {
    const m = st.jev.menu;
    const box = el(jev, '.menu');
    const chips = el(jev, '.chips');
    setHidden(box, !m);
    if (!m) {
      view.menuKey = null;
      return;
    }
    // fit first, then the undecided ones (an insight can settle them), then the rest
    const undecided = (c) => c.feasible === false && c.reason === 'undecided';
    const list = m.building ? m.candidates : [...m.candidates.filter((c) => c.feasible), ...m.candidates.filter(undecided),
      ...m.candidates.filter((c) => !c.feasible && !undecided(c))];
    const key = `${m.t_wall}|${m.building}`;
    let changed = false;
    if (key !== view.menuKey) {
      view.menuKey = key;
      view.menuN = list.length;
      chips.replaceChildren(h('span', { class: 'lbl menu-lbl' }, 'menu'), ...list.map((c, i) => chipFor(c, i, !view.quiet)),
        h('span', { class: 'chip more mono', hidden: true }));
      changed = true;
    } else if (m.building && list.length > view.menuN) {
      const more = el(chips, '.more');
      for (let i = view.menuN; i < list.length; i++) chips.insertBefore(chipFor(list[i], 0, !view.quiet), more);
      view.menuN = list.length;
      changed = true;
    }

    // chip states: fit / undecided / no fit / pending; after the LLM chose: the chosen one rises, the rest dims
    const c = st.llm.choice;
    const chosen = c && (c.t_wall ?? 0) >= (m.t_wall ?? 0) ? c.motion : null;
    const allowed = chosen && c ? c.allowed : [];
    const considering = !chosen && !m.building && (st.llm.phase === 'thinking' || st.llm.phase === 'deciding');
    const rows = m.building ? MENU_ROWS_BUILDING : pv.decision || chosen ? MENU_ROWS_DECIDED : MENU_ROWS_CHOOSING;
    const stateKey = `${key}|${chosen}|${considering}|${list.length}|${rows}`;
    if (stateKey !== view.menuStateKey || changed) {
      view.menuStateKey = stateKey;
      const byMotion = new Map(list.map((x) => [x.motion, x]));
      let k = 0;
      for (const chip of chips.querySelectorAll('.chip:not(.more)')) {
        const cand = byMotion.get(chip.dataset.motion);
        if (!cand) continue;
        setClass(chip, 'pending', !!cand.pending);
        setClass(chip, 'fit', cand.feasible === true);
        setClass(chip, 'undecided', undecided(cand));
        setClass(chip, 'nofit', cand.feasible === false && !undecided(cand));
        setClass(chip, 'chosen', chosen === cand.motion);
        setClass(chip, 'alt', allowed.includes(cand.motion));
        setClass(chip, 'dim', !!chosen && chosen !== cand.motion && !allowed.includes(cand.motion));
        const cons = considering && cand.feasible === true;
        // the sweep replaces the entry animation: drop its class, or it would replay when the sweep ends
        if (cons) chip.classList.remove('enter');
        setClass(chip, 'considering', cons);
        if (cons) setStyle(chip, '--k', String(k++));
        setAttr(chip, 'title', chipTitle(cand));
      }
      fitChips(chips, rows, [chosen, ...allowed].filter(Boolean));
    }
  }

  /** Keep the menu within `rows` rows: the chips past the last row fold into "+N" (the chosen and allowed ones stay,
   * moved forward when they would fold). */
  function fitChips(chips, rows, keep) {
    const all = [...chips.querySelectorAll('.chip:not(.more)')];
    const more = el(chips, '.more');
    all.forEach((x) => { x.hidden = false; });
    more.hidden = true;
    if (!all.length || !chips.offsetParent) return;
    // the kept chips go first among the others, so they survive the fold
    const label = el(chips, '.menu-lbl');
    for (const id of [...keep].reverse()) {
      const chip = all.find((x) => x.dataset.motion === id);
      if (chip && label) label.after(chip);
    }
    const ordered = [...chips.querySelectorAll('.chip:not(.more)')];
    const top0 = (label || ordered[0]).offsetTop;
    const rowH = ordered[0].offsetHeight + 6;
    const limit = top0 + (rows - 1) * rowH + 4;
    if (ordered[ordered.length - 1].offsetTop <= limit) return;
    more.hidden = false;
    for (let guard = 0; guard <= ordered.length; guard++) {
      const visible = ordered.filter((x) => !x.hidden);
      const n = ordered.length - visible.length;
      setText(more, `+${n}`);
      if (more.offsetTop <= limit && !visible.some((x) => x.offsetTop > limit)) break;
      const victim = [...visible].reverse().find((x) => !keep.includes(x.dataset.motion));
      if (!victim) break;
      victim.hidden = true;
    }
    const folded = ordered.filter((x) => x.hidden);
    setText(more, `+${folded.length}`);
    setAttr(more, 'title', folded.map((x) => x.dataset.motion).join(', ') || null);
  }

  /** The step list: the revealed steps of the current command, the newest at the bottom, the last five visible. */
  function renderSteps(st, pv) {
    const j = st.jev;
    const box = el(jev, '.steps');
    const vis = pv.shown.slice(-STEPS_VISIBLE);
    // the folded ones: revealed steps above the window, and the oldest steps the reducer no longer keeps
    const folded = pv.shown.slice(0, pv.shown.length - vis.length);
    const earlier = folded.length + Math.max(0, j.steps_total - j.steps.length);
    setHidden(box, !vis.length);
    const key = `${j.steps_cmd_t_wall}|${vis.map((x) => x.id).join(',')}|${earlier}`;
    if (key === view.stepsKey) return;
    view.stepsKey = key;
    const rows = new Map([...box.querySelectorAll('li.step')].map((li) => [Number(li.dataset.id), li]));
    const keep = new Set(vis.map((x) => x.id));
    for (const [id, li] of rows) if (!keep.has(id)) li.remove();
    let more = el(box, '.earlier');
    if (!more) {
      more = h('li', { class: 'earlier mono' });
      box.prepend(more);
    }
    setHidden(more, earlier <= 0);
    setText(more, earlier > 0 ? `+${earlier} earlier` : '');
    setAttr(more, 'title', folded.length ? folded.map((x) => x.text).join('\n') : null);
    for (const x of vis) {
      if (rows.has(x.id)) continue;
      const rel = x.t_wall != null && j.steps_cmd_t_wall != null ? Math.max(0, x.t_wall - j.steps_cmd_t_wall) : null;
      const li = h('li', { class: 'step', 'data-id': String(x.id), 'data-kind': x.kind },
        h('i', { class: 'sd', 'aria-hidden': 'true' }),
        h('time', { class: 'mono' }, rel != null ? `+${rel.toFixed(1)} s` : ''),
        h('span', { class: 'tx', title: x.text }, x.text));
      if (x.tone) li.dataset.tone = x.tone;
      if (!view.quiet) {
        li.classList.add('enter');
        li.addEventListener('animationend', () => li.classList.remove('enter'), { once: true });
      }
      // in id order: a seek can bring back steps older than the rows on screen
      const after = [...box.querySelectorAll('li.step')].find((r) => Number(r.dataset.id) > x.id);
      box.insertBefore(li, after || null);
    }
  }

  function renderCard(st, pv) {
    const j = st.jev;
    const d = pv.decision;
    const card = el(jev, '.card');
    // the edit of an earlier command is history once a new command began (the 3-D view keeps drawing it)
    const plan = j.plan && j.plan.channel === 'hand'
      && !(j.steps_cmd_t_wall != null && num(j.plan.t_wall, Infinity) < j.steps_cmd_t_wall) ? j.plan : null;
    const show = !!d || !!plan;
    // the card rises when it appears; a later decision changes its values in place, never its shape
    if (show && card.hidden && !view.quiet) replay(card, 'fresh');
    setHidden(card, !show);
    if (d) {
      const key = `${d.t_wall}|${d.motion}|${d.kind}`;
      if (key !== view.decisionKey) {
        view.decisionKey = key;
        fillCard(card, d);
      }
    } else if (view.decisionKey !== null) {
      view.decisionKey = null;
      view.cardPrev = null;
      setText(el(card, '.card-title'), plan ? plan.motion : '');
      setAttr(el(card, '.card-title'), 'title', null);
      setText(el(card, '.card-meta'), '');
      const box = el(card, '.fields');
      box.replaceChildren();
      delete box.dataset.keys;
      setText(el(card, '.reason'), '');
      setAttr(el(card, '.reason'), 'title', null);
      setClass(card, 'redecided', false);
    }
    renderEdit(card, plan, st);
  }

  /** Fill the card with a decision. The fields keep their places when the next decision has the same ones; a value
   * that differs from the decision the card showed before glows amber for a moment. */
  function fillCard(card, d) {
    const title = `${d.motion ?? ''}${d.object_ref ? ` · ${d.object_ref}` : ''}`;
    setText(el(card, '.card-title'), title);
    setAttr(el(card, '.card-title'), 'title', title || null);
    const conf = decisionConfidence(d.decision);
    setText(el(card, '.card-meta'), `decider: ${d.decider === 'model' ? 'model' : 'rules'}${conf != null ? ` · conf ${conf.toFixed(2)}` : ''}`);
    setClass(card, 'redecided', d.kind === 'redecision');
    const fields = cardFields(d.decision);
    const before = view.cardPrev ? new Map(cardFields(view.cardPrev.decision).map((f) => [f.key, f.value])) : null;
    view.cardPrev = d;
    const box = el(card, '.fields');
    const keys = fields.map((f) => f.key).join(',');
    if (box.dataset.keys !== keys) {
      box.dataset.keys = keys;
      box.replaceChildren(...fields.map((f, i) => h('div', { class: 'field', 'data-key': f.key, style: { '--i': String(i) } },
        h('span', { class: 'fl' }, f.label),
        h('span', { class: 'fv mono' }),
        // the bar shows the field's confidence (it grows from zero when the field first appears)
        h('span', { class: 'fb' }, h('i')))));
    }
    fields.forEach((f, i) => {
      const fe = box.children[i];
      const fv = el(fe, '.fv');
      setText(fv, f.value);
      setClass(fe, 'exempt', f.exempt);
      setAttr(fe, 'title', `${f.label}: ${f.value}${f.conf != null ? ` · confidence ${f.conf.toFixed(2)}` : ''}${f.exempt ? ' · a free choice' : ''}`);
      setStyle(el(fe, '.fb i'), 'width', `${Math.round(100 * clamp(f.conf ?? 0, 0, 1))}%`);
      if (before && before.has(f.key) && before.get(f.key) !== f.value && !view.quiet) replay(fv, 'changed');
      else fv.classList.remove('changed');
    });
    const reason = d.decision && d.decision.reason ? String(d.decision.reason) : '';
    setText(el(card, '.reason'), reason);
    setAttr(el(card, '.reason'), 'title', reason || null);
  }

  /** The edit thumbnail: the clip as placed (dashed) morphing into the edited curve, from above, with the progress. */
  function renderEdit(card, plan, st) {
    const svg = el(card, '.edit');
    setSvgHidden(svg, !plan);
    if (!plan) {
      view.planSeq = st.jev.plan_seq;
      view.morph = null;
      return;
    }
    const ghost = Array.isArray(plan.ghost) ? plan.ghost : [];
    const edited = Array.isArray(plan.edited) ? plan.edited : [];
    if (st.jev.plan_seq !== view.planSeq) {
      view.planSeq = st.jev.plan_seq;
      view.morph = null;
      const pts = [...ghost, ...edited, ...(Array.isArray(plan.goal) ? [plan.goal] : [])].filter((p) => Array.isArray(p) && p.length >= 2);
      if (!pts.length) return;
      // from above: forward (world x) is up, left (world y) is left
      const xs = pts.map((p) => -p[1]);
      const ys = pts.map((p) => -p[0]);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.05);
      const k = 46 / span;
      const ox = 48 - ((Math.min(...xs) + Math.max(...xs)) / 2) * k;
      const oy = 28 - ((Math.min(...ys) + Math.max(...ys)) / 2) * k;
      const map = (p) => [ox - p[1] * k, oy - p[0] * k];
      const path = (list) => list.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      const g = ghost.map(map);
      const e = edited.map(map);
      el(svg, '.ghost').setAttribute('d', path(g));
      if (Array.isArray(plan.goal)) {
        const [gx, gy] = map(plan.goal);
        el(svg, '.goal').setAttribute('cx', gx.toFixed(1));
        el(svg, '.goal').setAttribute('cy', gy.toFixed(1));
      }
      setSvgHidden(el(svg, '.goal'), !Array.isArray(plan.goal));
      view.morph = { g, e, path, start: performance.now(), reduced: prefersReducedMotion() || view.quiet, done: false };
    }
    const m = view.morph;
    if (!m) return;
    if (!m.done) {
      const f = m.reduced ? 1 : clamp((performance.now() - m.start) / MORPH_MS, 0, 1);
      const ease = easeInOutCubic(f);
      const n = Math.min(m.g.length, m.e.length);
      el(svg, '.edited').setAttribute('d', m.path(m.e.map((p, i) => (i < n ? [lerp(m.g[i][0], p[0], ease), lerp(m.g[i][1], p[1], ease)] : p))));
      if (f >= 1) m.done = true;
    }
    // the progress marker: the edited curve is sampled at evenly spaced phases, so the run's phase indexes it
    const run = st.engine.run;
    const here = el(svg, '.here');
    const show = run && !run.ended && run.motion === plan.motion && m.e.length > 1;
    setSvgHidden(here, !show);
    if (show) {
      const x = clamp(num(run.phase, 0), 0, 1) * (m.e.length - 1);
      const i = Math.min(m.e.length - 2, Math.floor(x));
      const t = x - i;
      here.setAttribute('cx', lerp(m.e[i][0], m.e[i + 1][0], t).toFixed(1));
      here.setAttribute('cy', lerp(m.e[i][1], m.e[i + 1][1], t).toFixed(1));
    }
  }

  /** The refusal pill on the status line: the reason, with JEV's whole explanation as its title. */
  function renderRefusal(r) {
    const pill = el(jev, '.rp');
    setHidden(pill, !r);
    if (!r) return;
    setText(pill, r.reason);
    const who = r.motion ?? 'the motion';
    setAttr(pill, 'title', r.why ? `${who} refused: ${r.why}` : `${who} cannot run here`);
    const key = `${r.t_wall}`;
    if (pill.dataset.key !== key) {
      pill.dataset.key = key;
      if (!view.quiet) replay(pill, 'fresh');
    }
  }

  /**
   * The watch line. JEV follows every tick of a running motion (tracking it, re-anchoring it, re-editing it when the
   * object moves) and asks the decider at periodic checks whether its decision still stands, so while a motion runs
   * the line is always there, its bars ticking; the latest check gives the count, p and verdict. A check brightens the
   * line for a moment, an intervention turns it amber (and is a step of its own). After the run the line keeps the
   * run's verdict until the next command begins.
   */
  function renderWatch(st) {
    const j = st.jev;
    const run = st.engine.run;
    const row = el(jev, '.watch');
    const live = !!run && !run.ended && run.outcome == null;
    const current = !!run && (live || j.steps_cmd_t_wall == null || num(run.t_wall_start, -Infinity) >= j.steps_cmd_t_wall);
    setHidden(row, !current);
    if (!current) return;
    // the latest check, when it judged this run (a check counts on the run it judged)
    const w = run.n_watch > 0 && j.watch && j.watch.motion === run.motion ? j.watch : null;
    const n = run.n_watch;
    let text;
    if (live && w) text = `watching every tick · check ${w.n} · p ${fmtP(w.p)} · ${w.verdict}`;
    else if (live) text = 'watching every tick · no decider check yet';
    else if (n > 0) text = `watched ${n} check${n === 1 ? '' : 's'} · ${run.n_intervene ? `intervened ${run.n_intervene}×` : 'never intervened'}`;
    else text = 'watched every tick · no decider check';
    setText(el(row, '.wt'), text);
    setClass(row, 'live', live);
    setClass(row, 'intervene', live ? !!(w && w.intervene) : run.n_intervene > 0);
    setAttr(row, 'title', w && w.why ? `the decider's latest check: ${w.why}`
      : 'JEV follows the running motion at every tick and asks the decider at periodic checks whether its decision still stands');
    if (w && w.t_wall !== view.watchKey) {
      view.watchKey = w.t_wall;
      if (!view.quiet) replay(row, 'blink');
    }
  }

  /** Re-decisions, re-edits and mid-run runs of the current command, as small badges in the block's header. */
  function renderBadges(st) {
    const j = st.jev;
    const items = [];
    if (j.n_redecisions > 0) items.push(['re-decided', `×${j.n_redecisions}`, `JEV re-decided ${j.n_redecisions}×${j.decision && j.decision.change && j.decision.change.kind ? ` after a predicted ${j.decision.change.kind}` : ''}`]);
    if (j.reedits > 0) items.push(['re-edited', `×${j.reedits}`, `the engine's watch re-edited the motion ${j.reedits}×`]);
    if (j.chain > 1) items.push(['run', String(j.chain), `run ${j.chain} of the command`]);
    const box = el(jev, '.hb');
    const key = items.map((x) => x.join('')).join('|');
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.replaceChildren(...items.map(([a, b, title]) => h('span', { class: 'badge mono', title }, `${a} ${b}`)));
    }
  }

  // ---- Engine ---------------------------------------------------------------------------------------------------------------
  function renderEngine(st) {
    const e = st.engine;
    const r = e.run;
    const running = !!r && !r.ended && r.outcome == null;
    setClass(eng, 'busy', running || (e.mode_change && e.mode_change.status === 'started'));
    setClass(eng, 'paused', !!r && r.paused);
    setText(el(eng, '.tag'), !r ? 'idle' : r.paused ? 'paused' : running ? 'running' : r.outcome ?? 'ended');
    setText(el(eng, '.st'), engineStatus(st));
    const box = el(eng, '.run');
    setHidden(box, !r);
    if (!r) return;
    setText(el(box, '.motion'), r.motion ?? '—');
    const ch = el(box, '.channel');
    setText(ch, r.channel ?? '');
    setAttr(ch, 'data-channel', r.channel);
    setText(el(box, '.arm'), r.arm ? `${r.arm} arm` : '');
    const mode = e.mode ? e.mode.replace(/_control_module$/, '') : '';
    setText(el(box, '.mode'), mode);
    setAttr(el(box, '.mode'), 'title', e.mode ? `the robot's control mode: ${e.mode}` : null);
    const out = el(box, '.outcome');
    const ended = r.ended || r.outcome != null;
    setHidden(out, !ended);
    if (ended) {
      setText(out, r.outcome === 'success' ? 'success' : `${r.outcome ?? 'ended'}${r.reason ? ` · ${r.reason}` : ''}`);
      setClass(out, 'ok', r.outcome === 'success');
      setClass(out, 'fail', r.outcome !== 'success');
    }
    const ph = clamp(num(r.phase, 0), 0, 1);
    setStyle(el(box, '.fill'), 'width', `${(100 * ph).toFixed(1)}%`);
    setText(el(box, '.pct'), `${Math.round(100 * ph)}%`);
    const marksKey = `${r.t_wall_start}|${r.watch_marks.length}|${r.reedit_marks.length}`;
    if (marksKey !== view.marksKey) {
      view.marksKey = marksKey;
      el(box, '.marks').replaceChildren(
        ...r.watch_marks.map((p) => h('i', { class: 'wm', style: { left: `${(100 * p).toFixed(2)}%` } })),
        ...r.reedit_marks.map((p) => h('i', { class: 'rm', style: { left: `${(100 * p).toFixed(2)}%` } })));
    }
    const pause = el(box, '.pause');
    setHidden(pause, !r.paused);
    if (r.paused && r.pause) setText(pause, short(r.pause.text || 'an object moved', 120));
  }

  // ---- pulses ---------------------------------------------------------------------------------------------------------------
  function firePulses(st, ctx) {
    const fresh = [];
    // ?still=1 (a capture without animations) draws no pulses at all
    const still = isStill();
    for (const p of st.pulses) {
      if (p.id <= view.lastPulse) continue;
      view.lastPulse = p.id;
      if (still || (ctx.t_wall != null && p.t_wall != null && ctx.t_wall - p.t_wall > PULSE_FRESH_S)) continue;
      fresh.push(p);
    }
    for (const p of fresh.slice(-PULSES_LIVE_MAX)) wires.fire(p, () => flash(p.to, p.from));
  }

  function flash(to, from) {
    const target = to === 'memory' ? memory : blocks[to];
    if (!target) return;
    target.style.setProperty('--recv', actorVar(from));
    replay(target, 'recv');
    clearTimeout(view.recvTimers.get(to));
    view.recvTimers.set(to, setTimeout(() => target.classList.remove('recv'), 900));
  }

  return {
    render(st, ctx = {}) {
      renderLlm(st, ctx);
      renderJev(st, ctx);
      renderEngine(st, ctx);
      wires.layout(view.relayout);
      view.relayout = false;
      wires.highlight(st);
      firePulses(st, ctx);
      view.quiet = false;
    },
    /** After a seek or a reconnect: draw the new state without replaying its pulses or entry animations (every step
     * of the current command is shown at once). */
    reset(st) {
      view.lastPulse = st ? st.seq : 0;
      view.menuKey = null;
      view.menuStateKey = null;
      view.decisionKey = null;
      view.cardPrev = null;
      view.planSeq = -1;
      view.marksKey = null;
      view.choiceKey = null;
      view.wordsKey = null;
      view.stepsKey = null;
      view.watchKey = null;
      view.quiet = true;
      wires.clear();
    },
    /** The stage was resized: the wires and the menu's fold are measured again at the next render. */
    relayout() {
      view.relayout = true;
      view.menuStateKey = null;
    },
  };
}

// ---- connectors ------------------------------------------------------------------------------------------------------------------
// The wires mirror the diagram of section 2: a spine down the panel (LLM -> JEV -> Engine -> Memory), a return loop
// on the left (Engine -> LLM: success, fail, scene changed), a feed on the right (Memory -> JEV: candidates) and the
// camera image from the world into the LLM. A pulse is a dot with a short trail travelling its wire in the sender's
// colour, its label readable from the start and lingering after the arrival; the wire brightens while a pulse travels
// it, and the receiving block glows once when the pulse arrives (section 11.3).
const ROUTES = {
  'llm>jev': ['llm-jev', false],
  'jev>llm': ['llm-jev', true],
  'jev>engine': ['jev-engine', false],
  'engine>jev': ['jev-engine', true],
  'engine>memory': ['engine-memory', false],
  'memory>engine': ['engine-memory', true],
  'engine>llm': ['engine-llm', false],
  'memory>jev': ['memory-jev', false],
  'world>llm': ['world-llm', false],
};

function createWires(stage, getEls) {
  const layer = h('div', { class: 'wires', 'aria-hidden': 'true' });
  const svg = s('svg', { class: 'wires-svg' });
  layer.append(svg);
  stage.append(layer);
  const paths = {};
  for (const key of ['llm-jev', 'jev-engine', 'engine-memory', 'engine-llm', 'memory-jev', 'world-llm']) {
    paths[key] = { el: s('path', { class: `wire w-${key}` }), d: '', label: [0, 0, 'start'], lit: 0 };
    svg.append(paths[key].el);
  }
  let sig = '';
  const live = new Set();
  let raf = 0;

  function rel(r, o) {
    return { l: r.left - o.left, t: r.top - o.top, r: r.right - o.left, b: r.bottom - o.top, w: r.width, h: r.height };
  }

  /** A polyline with rounded corners. */
  function rounded(points, rad = 7) {
    let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      const l1 = Math.hypot(x1 - x0, y1 - y0) || 1;
      const l2 = Math.hypot(x2 - x1, y2 - y1) || 1;
      const r = Math.min(rad, l1 / 2, l2 / 2);
      d += ` L${(x1 + ((x0 - x1) / l1) * r).toFixed(1)} ${(y1 + ((y0 - y1) / l1) * r).toFixed(1)}`
        + ` Q${x1.toFixed(1)} ${y1.toFixed(1)} ${(x1 + ((x2 - x1) / l2) * r).toFixed(1)} ${(y1 + ((y2 - y1) / l2) * r).toFixed(1)}`;
    }
    const last = points[points.length - 1];
    return `${d} L${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
  }

  function set(key, d, label, visible = true) {
    const p = paths[key];
    p.d = d;
    p.label = label;
    setAttr(p.el, 'd', d || null);
    // a pulse-only wire stays rendered (transparent) so its length can be measured
    setClass(p.el, 'off', !d);
    setClass(p.el, 'ghostwire', !!d && !visible);
  }

  function layout(force = false) {
    const els = getEls();
    if (!els.llm || !els.llm.isConnected) return;
    const o = stage.getBoundingClientRect();
    const R = {};
    for (const [k, e] of Object.entries(els)) if (e) R[k] = rel(e.getBoundingClientRect(), o);
    const next = `${o.width | 0},${o.height | 0};${Object.values(R).map((r) => `${r.l | 0},${r.t | 0},${r.w | 0},${r.h | 0}`).join(';')}`;
    if (!force && next === sig) return;
    sig = next;
    svg.setAttribute('viewBox', `0 0 ${o.width.toFixed(0)} ${o.height.toFixed(0)}`);
    svg.setAttribute('width', o.width.toFixed(0));
    svg.setAttribute('height', o.height.toFixed(0));
    const { llm, jev, engine, memory, world } = R;
    const x = llm.l + 18;
    const side = world && world.r <= llm.l - 4;          // the panel sits beside the viewport (wide layout)
    set('llm-jev', `M${x} ${llm.b} L${x} ${jev.t}`, [x + 10, (llm.b + jev.t) / 2, 'start']);
    set('jev-engine', `M${x} ${jev.b} L${x} ${engine.t}`, [x + 10, (jev.b + engine.t) / 2, 'start']);
    if (memory && memory.t > engine.b) set('engine-memory', `M${x} ${engine.b} L${x} ${memory.t}`, [x + 10, (engine.b + memory.t) / 2, 'start']);
    else set('engine-memory', '', [0, 0, 'start'], false);
    if (side && world) {
      const gx = (world.r + llm.l) / 2;
      set('engine-llm', rounded([[engine.l, engine.t + 18], [gx, engine.t + 18], [gx, llm.t + 18], [llm.l, llm.t + 18]]),
        [gx - 7, (jev.t + jev.b) / 2, 'end']);
      const wy = llm.t + 62;
      set('world-llm', `M${world.r - 44} ${wy} L${llm.l + 10} ${wy}`, [world.r - 12, wy - 14, 'end'], false);
    } else {
      set('engine-llm', '', [0, 0, 'start'], false);
      if (world) set('world-llm', `M${x} ${world.b - 24} L${x} ${llm.t + 10}`, [x + 10, (world.b + llm.t) / 2, 'start'], false);
    }
    if (side && memory && memory.t > engine.b) {
      const gx2 = jev.r + Math.max(4, Math.min(8, (o.width - jev.r) / 2 || 8));
      const my = (engine.b + memory.t) / 2;
      set('memory-jev', rounded([[jev.r - 34, memory.t], [jev.r - 34, my], [gx2, my], [gx2, jev.t + 18], [jev.r, jev.t + 18]]),
        [gx2 - 8, (jev.t + jev.b) / 2 + 28, 'end']);
    } else {
      set('memory-jev', '', [0, 0, 'start'], false);
    }
  }

  /** Light the wires the pipeline is using right now. */
  function highlight(st) {
    const run = st.engine.run;
    setClass(paths['jev-engine'].el, 'hot', !!run && !run.ended);
    setClass(paths['llm-jev'].el, 'hot', st.jev.busy != null);
    setClass(paths['memory-jev'].el, 'hot', st.jev.busy === 'menu');
  }

  /** A pulse starts (+1) or stops (-1) travelling `wire`: the wire is lit while any pulse is on it. */
  function light(wire, d) {
    wire.lit = Math.max(0, wire.lit + d);
    setClass(wire.el, 'lit', wire.lit > 0);
  }

  function arrive(a, now) {
    a.arrived = true;
    a.arrivedAt = now;
    for (const d of a.dots) d.el.remove();
    light(a.wire, -1);
    a.onArrive?.();
  }

  function tickAnim(now) {
    raf = 0;
    for (const a of live) {
      // the label follows its wire's anchor: a block that grows while the label shows moves the wire with it
      const [lx, ly] = a.wire.label;
      a.label.style.left = `${lx}px`;
      a.label.style.top = `${ly}px`;
      const f = (now - a.start) / PULSE_MS;
      if (!a.reduced && f <= 1) {
        const len = a.path.getTotalLength();
        // the head fades in at the start and dims a little before it arrives; the trail follows at its own strength
        const strength = Math.min(1, f * 6, (1 - f) * 6 + 0.3);
        for (const d of a.dots) {
          const fd = f - d.lag;
          if (fd < 0) {
            d.el.style.opacity = '0';
            continue;
          }
          const e = easeInOutCubic(clamp(fd, 0, 1));
          const pt = a.path.getPointAtLength(len * (a.reverse ? 1 - e : e));
          d.el.setAttribute('cx', pt.x.toFixed(1));
          d.el.setAttribute('cy', pt.y.toFixed(1));
          d.el.style.opacity = String(strength * d.op);
        }
      } else if (!a.arrived) {
        arrive(a, now);
      }
      // the label: in over LABEL_IN_MS from the start, held until PULSE_LINGER_MS after the arrival, then out
      const end = (a.arrived ? a.arrivedAt : a.start + PULSE_MS) + PULSE_LINGER_MS;
      const lin = (now - a.start) / LABEL_IN_MS;
      a.label.style.opacity = String(lin < 1 ? easeOutCubic(clamp(lin, 0, 1)) : clamp((end - now) / LABEL_OUT_MS, 0, 1));
      if (now >= end) {
        a.label.remove();
        live.delete(a);
      }
    }
    if (live.size) raf = requestAnimationFrame(tickAnim);
  }

  function fire(p, onArrive) {
    const route = ROUTES[`${p.from}>${p.to}`];
    const wire = route ? paths[route[0]] : null;
    if (!wire || !wire.d) {
      onArrive?.();
      return;
    }
    const reduced = prefersReducedMotion();
    const color = actorVar(p.from);
    const dots = reduced ? [] : PULSE_TRAIL.map(([lag, r, op]) => {
      const dot = s('circle', { class: `pulse-dot${lag ? ' trail' : ''}`, r, fill: color });
      dot.style.color = color;
      dot.style.opacity = '0';
      return { el: dot, lag, op };
    });
    // the trail is drawn first, so the head travels on top of it
    for (const d of [...dots].reverse()) svg.append(d.el);
    const [lx, ly, anchor] = wire.label;
    const label = h('span', { class: `pulse-label mono${anchor === 'end' ? ' end' : ''}`, style: { left: `${lx}px`, top: `${ly}px`,
      color: `var(--${p.from}-ink, var(--muted))`, borderColor: color } }, p.label);
    layer.append(label);
    light(wire, 1);
    live.add({ wire, path: wire.el, reverse: route[1], dots, label, start: performance.now(), reduced, onArrive, arrived: false,
      arrivedAt: null });
    if (!raf) raf = requestAnimationFrame(tickAnim);
  }

  function clear() {
    for (const a of live) {
      for (const d of a.dots) d.el.remove();
      a.label.remove();
    }
    live.clear();
    for (const p of Object.values(paths)) {
      p.lit = 0;
      setClass(p.el, 'lit', false);
    }
  }

  return { layout, fire, clear, highlight };
}
