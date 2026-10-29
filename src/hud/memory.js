// The motion memory as a graph (docs/design/WEB_HUD.md sections 2 and 8.1): one row per channel (hand, gaze, base,
// root), each authored motion a small node with its id, shaded by its success rate. A motion kept from a successful
// run hangs under the motion it came from (`accumulated_from`) with an edge, so the library visibly grows during an
// episode. The running motion pulses in the engine's amber; the candidates of the current menu get JEV's teal ring.
// A row that is wider than the strip wraps onto further lines instead of scrolling. The sizes come from CSS custom
// properties on the strip (`--mem-*` in styles.css), so the page's compact density shrinks the graph too.

import { h, s, setText, setClass, setHidden, replay } from '../util/dom.js';
import { CHANNELS } from '../util/colors.js';

const MONO_ADVANCE = 0.61;       // JetBrains Mono's advance is 0.6 em; a little more covers the fallback monospace fonts
const PAD_X = 7;
const GAP_X = 5;
const FAMILY_GAP = 12;           // extra room between intent families (reach, carry, ...) within a row
const LABEL_W = 62;
const RIGHT_PAD = 6;
const CHILD_DX = 12;
const MAX_CHARS = 24;
const NARROW_W = 560;            // below this width a row's label sits above its nodes instead of beside them
const ROW_LABEL_H = 15;

/** The graph's sizes from the strip's CSS custom properties (with the comfortable density as the fallback: 15 px
 * chips in 9.5 px mono and tight rows, so the strip leaves the panel above it room for its blocks). */
function metrics(root) {
  const cs = getComputedStyle(root);
  const v = (name, d) => {
    const x = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(x) ? x : d;
  };
  const font = v('--mem-font', 9.5);
  return {
    font,
    charW: MONO_ADVANCE * font,
    nodeH: v('--mem-node-h', 15),
    lineGap: v('--mem-line-gap', 3),
    rowGap: v('--mem-row-gap', 4),
    childH: v('--mem-child-h', 13),
    childGap: v('--mem-child-gap', 2),
  };
}

function labelOf(id, max = MAX_CHARS) {
  return id.length <= max ? id : `${id.slice(0, max - 1)}…`;
}

function childLabel(child, parent) {
  if (parent && child.startsWith(parent)) {
    const rest = child.slice(parent.length).replace(/^[_\-.]+/, '');
    if (rest) return labelOf(rest, 14);
  }
  return labelOf(child, 14);
}

function nodeW(M, label, child = false) {
  return Math.ceil(label.length * (child ? M.charW * 0.92 : M.charW) + 2 * (child ? PAD_X - 1 : PAD_X));
}

/** Rows, lines and node positions for `items` in a strip `width` wide. */
function layoutGraph(items, width, M) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const kids = new Map();
  const roots = [];
  for (const it of items) {
    const p = it.accumulated_from;
    if (p && byId.has(p) && p !== it.id) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(it);
    } else roots.push(it);
  }
  for (const list of kids.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  // every descendant of a root, depth first, with its depth (children of children indent further)
  const descend = (id, depth, out, seen) => {
    for (const c of kids.get(id) || []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ item: c, depth, parent: id });
      descend(c.id, depth + 1, out, seen);
    }
    return out;
  };
  const nodes = [];
  const edges = [];
  const rows = [];
  const narrow = width < NARROW_W;
  const x0 = narrow ? 0 : LABEL_W;
  let y = 2;
  for (const ch of CHANNELS) {
    const list = roots.filter((it) => it.channel === ch)
      .sort((a, b) => String(a.intent ?? '').localeCompare(String(b.intent ?? '')) || a.id.localeCompare(b.id));
    const row = { channel: ch, y, n: list.length, labelY: narrow ? y + 10 : y + M.nodeH / 2 + 3.5 };
    rows.push(row);
    if (narrow) y += ROW_LABEL_H;
    if (!list.length) {
      y += (narrow ? 0 : M.nodeH) + M.rowGap;
      continue;
    }
    let line = [];
    let x = x0;
    let prevIntent = null;
    const lines = [line];
    for (const it of list) {
      const label = labelOf(it.id);
      const w = nodeW(M, label);
      let extra = prevIntent != null && it.intent !== prevIntent ? FAMILY_GAP : 0;
      if (x + extra + w > width - RIGHT_PAD && line.length) {
        line = [];
        lines.push(line);
        x = x0;
        extra = 0;
      }
      x += extra;
      line.push({ it, label, x, w });
      x += w + GAP_X;
      prevIntent = it.intent;
    }
    for (const ln of lines) {
      let depthRows = 0;
      for (const n of ln) {
        const desc = descend(n.it.id, 1, [], new Set([n.it.id]));
        nodes.push({ id: n.it.id, item: n.it, label: n.label, x: n.x, y, w: n.w, h: M.nodeH, child: false });
        desc.forEach((d, k) => {
          const cl = childLabel(d.item.id, d.parent);
          const cx = n.x + CHILD_DX * d.depth;
          const cy = y + M.nodeH + M.childGap + k * (M.childH + M.childGap);
          nodes.push({ id: d.item.id, item: d.item, label: cl, x: cx, y: cy, w: nodeW(M, cl, true), h: M.childH, child: true, parent: d.parent });
          const px = n.x + CHILD_DX * (d.depth - 1) + 7;
          const top = d.depth > 1 ? cy - M.childGap : y + M.nodeH;
          const mid = cy + M.childH / 2;
          edges.push({ id: d.item.id, d: `M${px} ${top} L${px} ${mid - 4} Q${px} ${mid} ${px + 4} ${mid} L${cx} ${mid}` });
        });
        depthRows = Math.max(depthRows, desc.length);
      }
      y += M.nodeH + (depthRows ? M.childGap + depthRows * (M.childH + M.childGap) : 0) + M.lineGap;
    }
    y += M.rowGap - M.lineGap;
  }
  return { nodes, edges, rows, height: Math.max(M.nodeH, y - M.rowGap + 2) };
}

/** `root`: the memory strip section (it gets a header, the graph and an empty note). */
export function createMemory(root) {
  const meta = h('span', { class: 'mmeta mono' });
  const graph = s('svg', { class: 'mgraph', role: 'img', 'aria-label': 'The motion memory by channel' });
  const edgesG = s('g', { class: 'medges' });
  const nodesG = s('g', { class: 'mnodes' });
  const labelsG = s('g', { class: 'mrows' });
  graph.append(labelsG, edgesG, nodesG);
  const empty = h('p', { class: 'mempty' }, 'The motion library appears here when an episode loads.');
  root.replaceChildren(
    h('header', { class: 'mh' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('h2', { class: 'bt' }, 'Motion memory'),
      meta,
      h('span', { class: 'legend' },
        h('span', { class: 'lg cand' }, 'on the menu'),
        h('span', { class: 'lg active' }, 'running'),
        h('span', { class: 'lg kept' }, 'kept this episode'))),
    h('div', { class: 'mscroll' }, graph),
    empty);

  const scroller = root.querySelector('.mscroll');
  const els = new Map();       // id -> {g, inner, rect, text, title}
  const edgeEls = new Map();   // child id -> path
  let layoutKey = '';
  let drawn = false;           // the first drawing never animates children in (they were there before the page)
  let stateKey = '';

  function draw(items, width, M) {
    const L = layoutGraph(items, width, M);
    graph.setAttribute('width', String(width));
    graph.setAttribute('height', String(L.height));
    graph.setAttribute('viewBox', `0 0 ${width} ${L.height}`);
    labelsG.replaceChildren(...L.rows.map((r) => s('text', { class: 'rowlabel', x: 0, y: r.labelY },
      r.channel, s('tspan', { class: 'rowcount', dx: 6 }, String(r.n)))));
    const seen = new Set();
    for (const n of L.nodes) {
      seen.add(n.id);
      let e = els.get(n.id);
      if (!e) {
        const inner = s('g', { class: 'inner' });
        const rect = s('rect', { rx: n.child ? 4 : 5, ry: n.child ? 4 : 5 });
        const text = s('text');
        const title = s('title');
        inner.append(rect, text);
        const g = s('g', { class: `mnode${n.child ? ' child' : ''}`, 'data-id': n.id }, title, inner);
        nodesG.append(g);
        e = { g, inner, rect, text, title };
        els.set(n.id, e);
        if (n.child && drawn) replay(inner, 'sprout');
      }
      e.rect.setAttribute('width', String(n.w));
      e.rect.setAttribute('height', String(n.h));
      e.text.setAttribute('x', String(n.child ? PAD_X - 1 : PAD_X));
      e.text.setAttribute('y', String(n.h / 2 + 3.4));
      setText(e.text, n.label);
      const sr = n.item.success_rate;
      setText(e.title, `${n.id}${n.item.intent ? ` · ${n.item.intent}` : ''}${sr != null ? ` · success ${Math.round(100 * sr)} %` : ''}`
        + `${n.item.accumulated_from ? ` · kept from ${n.item.accumulated_from}` : ''}${n.item.description ? `\n${n.item.description}` : ''}`);
      e.g.style.setProperty('--sr', String(sr == null ? 0.5 : Math.max(0, Math.min(1, sr))));
      e.g.style.transform = `translate(${n.x}px, ${n.y}px)`;
    }
    for (const [id, e] of els) {
      if (!seen.has(id)) {
        e.g.remove();
        els.delete(id);
      }
    }
    const eseen = new Set();
    for (const ed of L.edges) {
      eseen.add(ed.id);
      let p = edgeEls.get(ed.id);
      if (!p) {
        p = s('path', { class: 'medge' });
        edgesG.append(p);
        edgeEls.set(ed.id, p);
        if (drawn) replay(p, 'grow');
      }
      p.setAttribute('d', ed.d);
    }
    for (const [id, p] of edgeEls) {
      if (!eseen.has(id)) {
        p.remove();
        edgeEls.delete(id);
      }
    }
    drawn = true;
    stateKey = '';
  }

  return {
    render(st) {
      const items = st.memory.items;
      setHidden(empty, items.length > 0);
      setHidden(scroller, items.length === 0);
      const added = st.memory.added;
      setText(meta, items.length ? `${items.length} motions${added.length ? ` · ${added.length} kept this episode` : ''}` : '');
      const width = Math.max(200, Math.floor(scroller.clientWidth || root.clientWidth || 800));
      const M = metrics(root);
      const key = `${width}|${M.nodeH}|${M.font}|${items.map((it) => it.id).join(',')}`;
      if (key !== layoutKey) {
        layoutKey = key;
        draw(items, width, M);
      }
      const cands = new Set(st.memory.candidates);
      const active = st.memory.active;
      const kept = new Set(added);
      const sk = `${[...cands].join(',')}|${active}|${added.join(',')}`;
      if (sk === stateKey) return;
      stateKey = sk;
      for (const [id, e] of els) {
        setClass(e.g, 'cand', cands.has(id));
        setClass(e.g, 'active', active === id);
        setClass(e.g, 'kept', kept.has(id));
      }
    },
    /** The strip was resized: lay the graph out again at the next render. */
    relayout() {
      layoutKey = '';
    },
    /** A rebuilt state (a seek): children present now were there all along, so they appear without the sprout. */
    reset() {
      for (const e of els.values()) e.g.remove();
      for (const p of edgeEls.values()) p.remove();
      els.clear();
      edgeEls.clear();
      layoutKey = '';
      drawn = false;
    },
    /** Mark the next drawing as live, so children appearing in it sprout (after the initial state was drawn). */
    arm() {
      drawn = true;
    },
  };
}
