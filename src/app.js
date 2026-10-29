// Boot and wiring of the web HUD (docs/design/WEB_HUD.md sections 3 and 8): pick the mode from the URL, connect the
// transport to the reducer, render the HUD at up to 30 Hz and the viewport every frame, and handle the controls.
//
//   ?ws=ws://127.0.0.1:8766/ws    live: follow a running simulator (sprout-sim run --web)
//   ?episode=<id>                 replay episodes/<id>/episode.json (an id may carry its group folder: basic_tasks/<id>)
//   (nothing)                     live when the page is served by the bridge itself (its /api/scene answers), else the
//                                 first bundle of episodes/index.json, else a quiet empty state
//   ?t=<s> ?speed=0.5|1|2|4 ?autoplay=0   replay start time, speed, start paused
//   ?theme=light|dark ?debug=1        theme, the error sink
//
// The 3-D viewport is optional: if its module or the model cannot load, the page says why in the viewport's place and
// the HUD runs on the rows alone.

import { initialState, reduce, tick } from './model/pipeline.js';
import { createPanel } from './hud/panel.js';
import { createMemory } from './hud/memory.js';
import { createFeed } from './hud/feed.js';
import { loadBundle, createPlayer, initialLibrary, SPEEDS } from './transport/replay.js';
import { connectLive, createLiveMirror, fetchModel, modelUrlFor, DEFAULT_WS } from './transport/live.js';
import { boundName, num, clamp, fmtBytes, fmtClock, refName } from './util/format.js';

const HUD_FRAME_MS = 1000 / 30;     // the HUD redraws at most at 30 Hz; the viewport every animation frame
const RAF_STALL_MS = 100;           // no animation frame for this long (a hidden tab, a headless capture): a timer
                                    // keeps the clock and the HUD going
const SEEK_STEP_S = 5;
const THEME_KEY = 'sprout-hud-theme';
const DROP_SETTLE_MS = 300;
const HINT_MS = 2600;               // how long a hint raised by the viewport stays

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'),
  viewport: $('viewport'),
  canvas: $('vp-canvas'),
  note: $('vp-note'),
  hint: $('vp-hint'),
  clock: $('vp-clock'),
  cams: $('cams'),
  empty: $('empty'),
  badge: $('mode-badge'),
  epMeta: $('ep-meta'),
  picker: $('picker'),
  select: $('episode-select'),
  connect: $('connect'),
  connectForm: $('connect-form'),
  wsUrl: $('ws-url'),
  emptyConnect: $('empty-connect'),
  themeBtn: $('theme-btn'),
  memory: $('memory'),
};

const panel = createPanel($('panel'), { stage: ui.stage, viewport: ui.viewport, memory: ui.memory });
const memory = createMemory(ui.memory);
const feed = createFeed($('bar'), {
  onToggle: () => player && player.toggle(),
  onSeek: (t) => player && player.seek(t),
  onSpeed: (n) => player && player.setSpeed(n),
});

let state = initialState();
let mode = 'empty';
let player = null;
let bundle = null;
let live = null;
let mirror = null;
let t0 = null;
let clock = { t: null, t_wall: null, t_rel: 0 };
let lastHud = 0;
let lastRaf = -Infinity;

// the viewport (another module; optional)
let vp = null;
let vpReady = false;           // a model is loaded and mirrored
let vpError = null;            // why the viewport is unavailable: it stays in the viewport's place
let lastPlanSeq = -1;
let lastProgress = -1;
let lastHighlight;
const vpWarned = new Set();

// ---- theme ---------------------------------------------------------------------------------------------------------
function theme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  vpCall('setTheme', t);
}

ui.themeBtn.addEventListener('click', () => setTheme(theme() === 'dark' ? 'light' : 'dark'));

// ---- viewport ------------------------------------------------------------------------------------------------------
function note(text, kind = 'info') {
  // a missing viewport outranks passing notes (loading, connecting): its reason stays until the page reloads
  const msg = text || vpError;
  const p = ui.note.querySelector('p');
  p.textContent = msg || '';
  ui.note.hidden = !msg;
  ui.note.classList.toggle('error', kind === 'error' || (!text && !!vpError));
}

function vpCall(name, ...args) {
  if (!vp || typeof vp[name] !== 'function') return undefined;
  try {
    return vp[name](...args);
  } catch (e) {
    if (!vpWarned.has(name)) {
      vpWarned.add(name);
      console.error(`viewport.${name}:`, e);
    }
    return undefined;
  }
}

async function initViewport() {
  try {
    const mod = await import('./viewport/viewport.js');
    vp = await mod.createViewport(ui.canvas, { theme: theme() });
    if (typeof vp.onDragObject === 'function') vp.onDragObject(onDrag);
    return true;
  } catch (e) {
    vp = null;
    vpError = `The 3-D view is unavailable here (${e && e.message ? e.message : e}). The pipeline still plays from its records.`;
    note('');
    console.error('viewport:', e && e.message ? e.message : e);
    return false;
  }
}

// ---- world rows: gates and moved region markers (docs/design/WEB_HUD.md section 4.2) ------------------------------
// The mirror follows qpos, but a gate closing or a region marker the mover teleports is a static geom the simulator
// moves through model.geom_pos: the rows that report it carry the geom's pose and the viewport applies it.
const WORLD_KINDS = new Set(['scene/gate', 'scene/object_motion']);
let liveWorld = [];            // live: the world rows since the last scene message (the dict already holds the older)

/** One row's effect on the viewport's static geoms: an episode start puts them back as the scene dict states them
 * (replay; live gets a fresh scene message instead), a world row moves its geom. */
function applyWorld(row, scene) {
  if (!vpReady || !row) return;
  if (row.kind === 'task/episode_start') {
    if (scene) vpCall('restoreWorld', scene);
  } else if (WORLD_KINDS.has(row.kind)) {
    vpCall('applyWorldRow', row);
  }
}

/** The world as it stands at the clock: the scene dict's poses, then the world rows played since it was read. */
function syncWorld() {
  if (!vpReady) return;
  if (mode === 'replay' && player && bundle) {
    vpCall('restoreWorld', bundle.scene);
    for (const r of player.playedRows()) applyWorld(r, bundle.scene);
  } else if (mode === 'live') {
    for (const r of liveWorld) applyWorld(r, null);
  }
}

async function loadModelInto(bytes, scene) {
  note(`Loading the model (${fmtBytes(bytes.byteLength)})…`);
  try {
    await vp.loadModel(bytes);
    vpReady = true;
    if (scene) vpCall('applyScene', scene);
    syncWorld();
    vpCall('frameScene');
    vpCall('setTheme', theme());
    note('');
    ui.cams.hidden = false;
    lastPlanSeq = -1;
    lastHighlight = undefined;
  } catch (e) {
    vpReady = false;
    note(`The model did not load: ${e && e.message ? e.message : e}`, 'error');
    console.error('viewport.loadModel:', e);
  }
}

function onDrag({ name, pos, live: dragging }) {
  if (mode !== 'live' || !live || dragging || !name || !Array.isArray(pos)) return;
  const sent = live.send({ type: 'move_object', name, pos: pos.map((v) => +Number(v).toFixed(4)) });
  if (sent) {
    // the viewer's own move goes into the feed, so the reaction that follows (a re-edit, a pause, a turn) reads as one
    reduce(state, { kind: 'viewer', t_wall: mirror && mirror.now() != null ? mirror.now() : null, t: clock.t,
      text: `you moved ${name} to (${pos.slice(0, 2).map((v) => Number(v).toFixed(2)).join(', ')})` });
  }
  setTimeout(() => { lastHighlight = undefined; }, DROP_SETTLE_MS);
}

// the viewport raises a hint when a drag cannot apply (a replay has no simulator to move the object)
let hintTimer = 0;
ui.viewport.addEventListener('viewport-hint', (e) => {
  const text = e.detail ? String(e.detail) : '';
  if (!text) return;
  const base = ui.hint.dataset.base ?? ui.hint.textContent;
  ui.hint.dataset.base = base;
  ui.hint.textContent = text;
  ui.hint.hidden = false;
  ui.hint.classList.add('flash');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    ui.hint.textContent = ui.hint.dataset.base;
    ui.hint.classList.remove('flash');
  }, HINT_MS);
});

ui.cams.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cam]');
  if (!b) return;
  if (b.dataset.cam === 'frame') vpCall('frameScene');
  else vpCall('cameraPreset', b.dataset.cam);
});

// ---- the header ----------------------------------------------------------------------------------------------------
function setBadge(text, cls = '') {
  ui.badge.textContent = text;
  ui.badge.className = `mode-badge mono ${cls}`.trim();
}

function setMode(m) {
  mode = m;
  feed.setMode(m);
  ui.stage.classList.toggle('is-empty', m === 'empty');
  ui.empty.hidden = m !== 'empty';
  ui.hint.hidden = m === 'empty';
  if (m === 'replay') {
    setBadge('REPLAY');
    ui.hint.textContent = 'Replay · objects can be moved in a live run';
  } else if (m === 'live') {
    setBadge('CONNECTING', 'waiting');
    ui.hint.textContent = 'Drag an object on the table to move it';
  }
  delete ui.hint.dataset.base;
  if (m === 'empty') {
    setBadge('NO EPISODE');
  }
}

function headerMeta() {
  const e = state.episode;
  const bits = [];
  if (e.scene) bits.push(e.scene);
  if (e.seed != null) bits.push(`seed ${e.seed}`);
  if (mode === 'replay' && bundle && bundle.meta.title && ui.picker.hidden) bits.push(bundle.meta.title);
  const text = bits.join(' · ');
  if (ui.epMeta.textContent !== text) ui.epMeta.textContent = text;
}

function episodeUrl(id) {
  if (/^https?:\/\//.test(id) || id.endsWith('.json')) return new URL(id, location.href).href;
  return new URL(`episodes/${id}/episode.json`, location.href).href;
}

async function sameOriginBridge() {
  if (!/^https?:$/.test(location.protocol)) return null;          // file:// pages have no bridge of their own
  try {
    const res = await fetch(new URL('api/scene', location.href), { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    const scene = await res.json();
    if (!scene || typeof scene !== 'object' || scene.nq == null) return null;
  } catch {
    return null;
  }
  return new URL('ws', location.href).href.replace(/^http/, 'ws');
}

async function loadIndex() {
  try {
    const res = await fetch(new URL('episodes/index.json', location.href));
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list.filter((x) => x && x.id) : [];
  } catch {
    return [];
  }
}

// The picker: one option per bundle of episodes/index.json, in the index's order; bundles that sit in a group folder
// (`"group": "basic_tasks"`, id `basic_tasks/<id>`) go under an <optgroup> headed by the folder's name.
function fillPicker(list, current) {
  if (!list.length) return;
  const nodes = [];
  const groups = new Map();
  for (const x of list) {
    const o = document.createElement('option');
    o.value = x.id;
    const dur = num(x.duration_s);
    o.textContent = `${x.title || x.id}${dur != null ? ` · ${fmtClock(dur)}` : ''}`;   // no verdict: the episodes are not judged here
    if (x.id === current) o.selected = true;
    const g = typeof x.group === 'string' && x.group ? x.group : null;
    if (!g) {
      nodes.push(o);
      continue;
    }
    if (!groups.has(g)) {
      const og = document.createElement('optgroup');
      og.label = g.replace(/_/g, ' ');
      groups.set(g, og);
      nodes.push(og);
    }
    groups.get(g).appendChild(o);
  }
  ui.select.replaceChildren(...nodes);
  ui.picker.hidden = false;
  ui.select.addEventListener('change', () => {
    const q = new URLSearchParams(location.search);
    q.delete('ws');
    q.delete('t');
    q.set('episode', ui.select.value);
    location.search = q.toString();
  });
}

function goLive(url) {
  const q = new URLSearchParams(location.search);
  q.delete('episode');
  q.delete('t');
  q.set('ws', url || DEFAULT_WS);
  location.search = q.toString();
}

ui.connectForm.addEventListener('submit', (e) => {
  e.preventDefault();
  goLive(ui.wsUrl.value.trim());
});
ui.emptyConnect.addEventListener('submit', (e) => {
  e.preventDefault();
  goLive(ui.emptyConnect.querySelector('input').value.trim());
});

// ---- replay --------------------------------------------------------------------------------------------------------
/** The bundle's own notes (what the recording lacks, how its frames were timed) behind a small disclosure. */
function showNotes(notes) {
  const box = $('vp-info');
  const list = Array.isArray(notes) ? notes.filter(Boolean) : [];
  box.hidden = !list.length;
  box.querySelector('ul').replaceChildren(...list.map((n) => {
    const li = document.createElement('li');
    li.textContent = String(n);
    return li;
  }));
}

function seed(s, b) {
  reduce(s, { kind: 'library', items: initialLibrary(b) });
  reduce(s, { kind: 'scene', scene: b.scene || b.meta.scene, seed: b.meta.seed });
  return s;
}

function rebuild() {
  panel.reset(state);
  memory.reset();
  feed.reset(state, ctx());
}

async function startReplay(url, vpReady$) {
  setMode('replay');
  note('Loading the episode…');
  try {
    bundle = await loadBundle(url);
  } catch (e) {
    note(`The episode did not load: ${e.message}`, 'error');
    console.error('replay:', e.message);
    return;
  }
  note('');
  showNotes(bundle.meta.notes);
  state = seed(initialState(), bundle);
  player = createPlayer(bundle, {
    onRows: (rows) => {
      for (const r of rows) {
        reduce(state, r);
        applyWorld(r, bundle.scene);
      }
    },
    onSeek: (t, rows) => {
      state = seed(initialState(), bundle);
      for (const r of rows) reduce(state, r);
      tick(state, { t: player.simAt(t), t_wall: player.t0 + t });
      rebuild();
      // the gates and markers as the scene starts, then every move up to the target: a seek back undoes the later ones
      if (vpReady) {
        vpCall('restoreWorld', bundle.scene);
        for (const r of rows) applyWorld(r, bundle.scene);
      }
    },
    onState: ({ playing, speed }) => {
      feed.setPlaying(playing);
      feed.setSpeed(speed);
    },
  });
  t0 = player.t0;
  feed.setTicks(player.ticks, player.duration);
  feed.setSpeed(player.speed);
  const speed = num(params.get('speed'));
  if (speed != null && SPEEDS.includes(speed)) player.setSpeed(speed);
  const start = num(params.get('t'));
  if (start != null && start > 0) player.seek(start);
  else rebuild();
  if (params.get('autoplay') !== '0') player.play();
  else feed.setPlaying(false);
  for (const err of bundle.errors) console.warn('replay:', err);

  if (await vpReady$) {
    vpCall('setInteractive', false);
    if (bundle.modelBytes) {
      await loadModelInto(bundle.modelBytes, bundle.scene);
      vpCall('setInteractive', false);          // a replay cannot move objects: dragging shows a hint instead
    } else {
      note('This episode carries no 3-D model, so the world view is off. The pipeline replays from the recorded rows.');
    }
  }
}

// ---- live ----------------------------------------------------------------------------------------------------------
function startLive(url, vpReady$) {
  setMode('live');
  ui.wsUrl.value = url;
  mirror = createLiveMirror();
  let library = null;
  let scene = null;
  let hello = null;
  let modelUrl = null;
  let robot = '';
  note('Connecting to the simulator…');
  live = connectLive(url, {
    onHello: async (msg) => {
      hello = msg;
      if (hello.scene != null) reduce(state, { kind: 'scene', scene: hello.scene, seed: hello.seed });
      const mu = modelUrlFor(url, hello.model_url);
      if (mu === modelUrl) return;
      modelUrl = mu;
      if (!(await vpReady$)) return;
      try {
        await loadModelInto(await fetchModel(mu), scene);
        vpCall('setInteractive', true);
      } catch (e) {
        note(`The model did not load from the simulator: ${e.message}`, 'error');
        console.error('live model:', e.message);
      }
    },
    onScene: (sc) => {
      scene = sc;
      liveWorld = [];                          // the dict holds the gates and markers as they stand now
      reduce(state, { kind: 'scene', scene: sc });
      if (vpReady) vpCall('applyScene', sc);
    },
    onLibrary: (items) => {
      library = items;
      reduce(state, { kind: 'library', items });
    },
    onRows: (rows) => {
      // the bridge replays its history on every connect: the state is rebuilt from it
      state = initialState();
      if (library) reduce(state, { kind: 'library', items: library });
      if (hello) reduce(state, { kind: 'scene', scene: hello.scene, seed: hello.seed });
      if (scene) reduce(state, { kind: 'scene', scene });
      for (const r of rows) reduce(state, r);
      t0 = state.episode.t0_wall;
      rebuild();
      memory.arm();
    },
    onRow: (row) => {
      reduce(state, row);
      if (t0 == null) t0 = state.episode.t0_wall;
      if (row && WORLD_KINDS.has(row.kind)) {
        liveWorld.push(row);
        applyWorld(row, null);
      }
    },
    onState: (msg) => {
      mirror.push(msg);
      const key = `${msg.mode}|${msg.state}`;
      if (key !== robot) {
        robot = key;
        reduce(state, { kind: 'robot', mode: msg.mode, state: msg.state });
      }
    },
    onAck: (msg) => {
      if (msg.what === 'move_object' && !msg.ok) {
        reduce(state, { kind: 'viewer', t_wall: mirror.now(), t: clock.t, text: `the move was refused: ${msg.error || 'unknown reason'}` });
      }
    },
    onStatus: (st, info) => {
      if (st === 'connected') {
        setBadge('LIVE', 'live');
        if (!vpReady && !ui.note.classList.contains('error')) note('');
      } else if (st === 'reconnecting') {
        setBadge('RECONNECTING', 'waiting');
        note(`No simulator at ${url} yet. Retrying in ${Math.round((info && info.delay_ms) / 1000) || 1} s. Start it with sprout-sim run --web.`);
      } else {
        setBadge('CLOSED');
      }
    },
  });
}

// ---- the frame loop ------------------------------------------------------------------------------------------------
function ctx() {
  // `speed` paces the panel's reveal of JEV's steps (a live run plays at 1x)
  return { t: clock.t, t_wall: clock.t_wall, t0, mode, playing: player ? player.playing : mode === 'live',
    speed: mode === 'replay' && player ? player.speed : 1 };
}

function syncViewport() {
  if (!vpReady) return;
  const j = state.jev;
  if (j.plan_seq !== lastPlanSeq) {
    lastPlanSeq = j.plan_seq;
    lastProgress = -1;
    vpCall('setPlan', j.plan || null);
  }
  const run = state.engine.run;
  const plan = j.plan;
  if (plan && run && !run.ended && run.motion === plan.motion) {
    const entry = num(plan.entry_s, 0);
    const f = clamp((num(run.phase, 0) - entry) / Math.max(1e-6, 1 - entry), 0, 1);
    if (Math.abs(f - lastProgress) > 0.002) {
      lastProgress = f;
      vpCall('setProgress', f);
    }
  }
  // the object the current command is bound to, while JEV decides it or the engine runs it
  const c = state.llm.choice;
  const active = j.busy === 'deciding' || (run && !run.ended);
  const target = active && c ? boundName(c.bindings) : null;
  if (target !== lastHighlight) {
    lastHighlight = target;
    vpCall('highlightObject', target ? refName(target) : null);
  }
}

function renderHud() {
  const c = ctx();
  panel.render(state, c);
  memory.render(state, c);
  feed.render(state, c);
  if (mode === 'replay' && player) feed.setTime(clock.t_rel);
  else if (mode === 'live') {
    const start = state.episode.t_start;
    feed.setTime(clock.t != null && start != null ? clock.t - start : clock.t ?? 0);
  }
  headerMeta();
  const clockText = clock.t != null ? `sim ${clock.t.toFixed(1)} s` : '';
  if (ui.clock.textContent !== clockText) ui.clock.textContent = clockText;
  ui.memory.classList.toggle('busy', state.jev.busy === 'menu');
}

/** Advance the clock to `now` (ms): rows that became due are reduced, the time-derived fields ticked, the mirror posed. */
function pump(now) {
  if (mode === 'replay' && player) {
    const out = player.step(now);
    clock = { t: out.t_sim, t_wall: out.t_wall, t_rel: out.t_rel };
    if (out.qpos && vpReady) vpCall('setState', out.qpos);
  } else if (mode === 'live' && mirror) {
    const smp = mirror.sample(now);
    if (smp) {
      clock = { t: smp.t, t_wall: smp.t_wall, t_rel: 0 };
      if (vpReady) vpCall('setState', smp.qpos);
    }
  }
  tick(state, clock);
  syncViewport();
  if (now - lastHud >= HUD_FRAME_MS) {
    lastHud = now;
    renderHud();
  }
}

function frame() {
  requestAnimationFrame(frame);
  // one clock for both paths: an animation frame's own stamp can run ahead of performance.now() (in a headless
  // capture by far), and mixing the two would make the playback jump
  lastRaf = performance.now();
  pump(lastRaf);
}

// animation frames stop in a hidden tab and come rarely in a headless capture; the playback clock is time-based, so a
// timer can stand in for them (the replay keeps its pace, rows due in the meantime are reduced at once)
setInterval(() => {
  const now = performance.now();
  if (now - lastRaf > RAF_STALL_MS) pump(now);
}, HUD_FRAME_MS);

// ---- keyboard and resizing -----------------------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tgt = e.target;
  if (tgt && tgt.closest && tgt.closest('input, select, textarea, [contenteditable="true"]')) return;
  switch (e.key) {
    case ' ':
      if (player && !(tgt && tgt.closest && tgt.closest('button, summary'))) {
        e.preventDefault();
        player.toggle();
      }
      break;
    case 'ArrowLeft':
      if (player) {
        e.preventDefault();
        player.seek(player.time - SEEK_STEP_S);
      }
      break;
    case 'ArrowRight':
      if (player) {
        e.preventDefault();
        player.seek(player.time + SEEK_STEP_S);
      }
      break;
    case '0':
      // half speed has no key of its own: 0 stands for ½×
      if (player) player.setSpeed(0.5);
      break;
    case '1':
    case '2':
    case '4':
      if (player) player.setSpeed(Number(e.key));
      break;
    case 'f':
    case 'F':
      vpCall('frameScene');
      break;
    case 't':
    case 'T':
      setTheme(theme() === 'dark' ? 'light' : 'dark');
      break;
    default:
  }
});

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => vpCall('resize')).observe(ui.viewport);
  new ResizeObserver(() => {
    panel.relayout();
    memory.relayout();
  }).observe(ui.stage);
} else {
  window.addEventListener('resize', () => {
    vpCall('resize');
    panel.relayout();
    memory.relayout();
  });
}

// ?debug=1 also reports a page wider than the window (the layout must never scroll sideways), naming the widest parts
function checkOverflow() {
  const doc = document.documentElement;
  if (doc.scrollWidth <= doc.clientWidth + 1) return;
  const wide = [...document.querySelectorAll('body *')]
    .filter((x) => x.getBoundingClientRect().right > doc.clientWidth + 1 && !x.closest('.mscroll, .feed, svg'))
    .slice(0, 4)
    .map((x) => `${x.tagName.toLowerCase()}${x.id ? `#${x.id}` : ''}${x.className && typeof x.className === 'string' ? `.${x.className.split(' ')[0]}` : ''}`);
  console.error(`horizontal overflow: the page is ${doc.scrollWidth}px wide in a ${doc.clientWidth}px window (${wide.join(', ')})`);
}
if (params.get('debug') === '1') {
  setTimeout(checkOverflow, 1500);
  window.addEventListener('resize', () => setTimeout(checkOverflow, 300));
}

// ---- boot ----------------------------------------------------------------------------------------------------------
async function boot() {
  requestAnimationFrame(frame);
  const vpReady$ = initViewport();
  const ws = params.get('ws');
  const ep = params.get('episode');
  if (ws) {
    startLive(ws, vpReady$);
    return;
  }
  if (!ep) {
    // served by the bridge itself (sprout-sim run --web): its /api/scene answers, so the page follows that simulator
    // without any parameter; a static copy (GitHub Pages, python -m http.server) has no such route and replays
    const own = await sameOriginBridge();
    if (own) {
      startLive(own, vpReady$);
      return;
    }
  }
  const index = ep ? null : await loadIndex();
  if (ep) {
    loadIndex().then((list) => fillPicker(list, ep));
    await startReplay(episodeUrl(ep), vpReady$);
    return;
  }
  if (index.length) {
    fillPicker(index, index[0].id);
    await startReplay(episodeUrl(index[0].id), vpReady$);
    return;
  }
  setMode('empty');
  note('');
}

boot().catch((e) => console.error('boot:', e && e.stack ? e.stack : e));
