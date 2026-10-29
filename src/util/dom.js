// Small DOM helpers. The HUD re-renders at up to 30 Hz from the reducer's state, so every setter here writes only
// when the value changed: unchanged text, attributes and classes cost nothing and never restart a CSS transition.

const SVG_NS = 'http://www.w3.org/2000/svg';

function build(el, attrs, children) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** An HTML element: h('div', {class: 'x'}, child, 'text'). */
export function h(tag, attrs = {}, ...children) {
  return build(document.createElement(tag), attrs, children);
}

/** An SVG element: s('path', {d: 'M0 0'}). */
export function s(tag, attrs = {}, ...children) {
  return build(document.createElementNS(SVG_NS, tag), attrs, children);
}

export function setText(el, text) {
  const t = text == null ? '' : String(text);
  if (el && el.textContent !== t) el.textContent = t;
}

export function setAttr(el, name, value) {
  if (!el) return;
  if (value == null || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const v = value === true ? '' : String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

export function setClass(el, name, on) {
  if (el && el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
}

export function setStyle(el, prop, value) {
  if (!el) return;
  const v = value == null ? '' : String(value);
  if (el.style.getPropertyValue(prop) !== v) el.style.setProperty(prop, v);
}

export function setHidden(el, hidden) {
  if (el && el.hidden !== !!hidden) el.hidden = !!hidden;
}

/** Restart a one-shot CSS animation class (removing it, forcing a reflow, adding it back). */
export function replay(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // eslint-disable-line no-void -- the reflow is the point
  el.classList.add(cls);
}
