// Dragging objects in the viewport (docs/design/WEB_HUD.md section 8.2), the one way a viewer changes the world: a
// press on an object picks it, the object slides with the pointer on the horizontal plane through the grab point (it
// never lifts off its surface), and the drop is reported to the page, which asks the simulator to move it. Replay has
// no simulator to ask, so there a drag attempt raises a hint instead and the camera orbits as usual.

import * as THREE from 'three';

/** A press that travels less than this (CSS pixels) is a click: it moves nothing and reports nothing. */
const CLICK_SLOP_PX = 3;

/** The hint a drag attempt raises when the viewport is not connected to a simulator. */
export const DRAG_HINT = 'Connect to a running sim to move objects';

/**
 * Pointer handling for the viewport's objects. It owns the gesture only; the viewport owns what a gesture does to
 * the mirror (holds), the surface clamp and the callbacks, through its _pickables / _beginHold / _moveHold /
 * _endHold / _emitDrag / _hint / _setHover methods.
 */
export class ObjectDrag {
  constructor(vp, { liveHz = 10 } = {}) {
    this.vp = vp;
    this.dom = vp.renderer.domElement;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.hit = new THREE.Vector3();
    this.liveMs = 1000 / liveHz;
    this.active = null;
    this.hovered = null;
    this._onDown = (e) => this._down(e);
    this._onMove = (e) => this._move(e);
    this._onUp = (e) => this._up(e);
    this._onLeave = () => {
      if (!this.active) this._setHover(null);
    };
    // Capture phase: at the canvas this runs before OrbitControls' own pointerdown listener, so a press on an object
    // claims the pointer before the camera starts to orbit.
    this.dom.addEventListener('pointerdown', this._onDown, { capture: true });
    this.dom.addEventListener('pointermove', this._onMove);
    this.dom.addEventListener('pointerup', this._onUp);
    this.dom.addEventListener('pointercancel', this._onUp);
    this.dom.addEventListener('pointerleave', this._onLeave);
  }

  /** Ends a drag without reporting a drop (the viewport turned non-interactive, a new scene arrived). */
  cancel() {
    if (this.active) this._finish(false);
  }

  clearHover() {
    this._setHover(null);
  }

  dispose() {
    this.cancel();
    this.dom.removeEventListener('pointerdown', this._onDown, { capture: true });
    this.dom.removeEventListener('pointermove', this._onMove);
    this.dom.removeEventListener('pointerup', this._onUp);
    this.dom.removeEventListener('pointercancel', this._onUp);
    this.dom.removeEventListener('pointerleave', this._onLeave);
  }

  _ray(e) {
    const rect = this.dom.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.vp.camera);
    return true;
  }

  /** The object under the pointer: a raycast among the objects' own geoms, so the robot or the table never get in
   * the way of a pick and nothing but an object can be dragged. */
  _pick(e) {
    const meshes = this.vp._pickables();
    if (!meshes.length || !this._ray(e)) return null;
    for (const mesh of meshes) mesh.updateMatrixWorld();
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.length ? { name: hits[0].object.userData.object, point: hits[0].point.clone() } : null;
  }

  _down(e) {
    if (e.button !== 0 || !e.isPrimary || this.active) return;
    const hit = this._pick(e);
    if (!hit) return;
    if (!this.vp.interactive) {
      this.vp._hint(DRAG_HINT);
      return;
    }
    const start = this.vp._beginHold(hit.name);
    if (!start) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // The plane through the grab point keeps that point under the pointer; the offset keeps the object's centre
    // where it was relative to it, so the object does not jump on the first move.
    this.plane.constant = -hit.point.z;
    this.active = {
      name: hit.name,
      pointerId: e.pointerId,
      offset: [start[0] - hit.point.x, start[1] - hit.point.y],
      pos: start,
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
      lastLive: -Infinity,
    };
    this.vp.controls.enabled = false;
    try {
      this.dom.setPointerCapture(e.pointerId);
    } catch (err) {
      // A synthetic or already-released pointer cannot be captured; the drag still works inside the canvas.
    }
    this._setHover(hit.name);
    this.dom.style.cursor = 'grabbing';
  }

  _move(e) {
    const a = this.active;
    if (a) {
      if (e.pointerId !== a.pointerId) return;
      if (!a.moved && Math.hypot(e.clientX - a.x0, e.clientY - a.y0) < CLICK_SLOP_PX) return;
      a.moved = true;
      if (!this._ray(e) || !this.raycaster.ray.intersectPlane(this.plane, this.hit)) return;
      const pos = this.vp._moveHold(a.name, this.hit.x + a.offset[0], this.hit.y + a.offset[1]);
      if (!pos) return;
      a.pos = pos;
      const now = performance.now();
      if (now - a.lastLive >= this.liveMs) {
        a.lastLive = now;
        this.vp._emitDrag({ name: a.name, pos: pos.slice(), live: true });
      }
      return;
    }
    // While a button is down the camera is orbiting or panning: hover feedback would flicker across the scene.
    if (e.buttons) return;
    if (!this.vp.interactive) {
      this._setHover(null);
      return;
    }
    const hit = this._pick(e);
    this._setHover(hit ? hit.name : null);
  }

  _up(e) {
    const a = this.active;
    if (!a || e.pointerId !== a.pointerId) return;
    this._finish(true);
  }

  _finish(report) {
    const a = this.active;
    this.active = null;
    try {
      if (this.dom.hasPointerCapture(a.pointerId)) this.dom.releasePointerCapture(a.pointerId);
    } catch (err) {
      // The pointer is gone already; there is nothing to release.
    }
    this.vp.controls.enabled = true;
    const dropped = report && a.moved;
    this.vp._endHold(a.name, dropped);
    if (dropped) this.vp._emitDrag({ name: a.name, pos: a.pos.slice(), live: false });
    this.dom.style.cursor = this.hovered && this.vp.interactive ? 'grab' : '';
  }

  _setHover(name) {
    if (name === this.hovered) return;
    this.hovered = name;
    this.vp._setHover(name);
    if (!this.active) this.dom.style.cursor = name ? 'grab' : '';
  }
}
