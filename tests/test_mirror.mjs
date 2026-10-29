// Node check of the viewport's MuJoCo half (docs/design/WEB_HUD.md section 9): MuJoCo WASM loads the scene's .mjb,
// the mesh arrays the page draws from are consistent, mj_kinematics moves the geoms when qpos changes, and the
// mirror's holds (dragging), region moves and the world rows (gates, moved markers; section 4.2) behave. It imports web/src/viewport/meshes.js, the three.js-free module
// the page itself runs, so no browser is needed.
//
//   node web/tests/test_mirror.mjs <model.mjb> [--nq 43]
//
// Prints one line per check and a summary; exits 1 when a check fails, 2 on a usage error.

import fs from 'node:fs';
import { classifyGeoms, deriveScene, getMujoco, GEOM_GROUP, meshArrays, openModel, robotRoot, worldGeomPose }
  from '../src/viewport/meshes.js';

const args = process.argv.slice(2);
const modelPath = args.find((a) => !a.startsWith('--'));
const nqFlag = args.indexOf('--nq');
// The default is the nq of the scenes the page ships with (tabletop scenes: the robot's floating base, its 29 joints
// and one free object).
const expectedNq = nqFlag >= 0 ? Number(args[nqFlag + 1]) : 43;
if (!modelPath || !fs.existsSync(modelPath) || !Number.isInteger(expectedNq)) {
  console.error('usage: node web/tests/test_mirror.mjs <model.mjb> [--nq N]');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function close(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

const t0 = performance.now();
const mujoco = await getMujoco();
check('WASM module loads once per page', (await getMujoco()) === mujoco, `MuJoCo ${mujoco.mj_versionString()}`);

const bytes = fs.readFileSync(modelPath);
const mirror = openModel(mujoco, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const { model } = mirror;
check('model loads from the .mjb', !!model && model.ngeom > 0,
  `nq ${model.nq}, ngeom ${model.ngeom}, nbody ${model.nbody}, nmesh ${model.nmesh}, ${(bytes.length / 1e6).toFixed(1)} MB`);
check(`nq is ${expectedNq}`, model.nq === expectedNq && mirror.nq === expectedNq, `nq ${model.nq}`);

// ---- mesh arrays -------------------------------------------------------------------------------------------------

const nvert = model.mesh_vert.length / 3;
const nface = model.mesh_face.length / 3;
const nnormal = model.mesh_normal.length / 3;
const meshProblems = [];
for (let k = 0; k < model.nmesh; k++) {
  const vadr = model.mesh_vertadr[k];
  const vnum = model.mesh_vertnum[k];
  const fadr = model.mesh_faceadr[k];
  const fnum = model.mesh_facenum[k];
  const nadr = model.mesh_normaladr[k];
  const nnum = model.mesh_normalnum[k];
  if (!(vadr >= 0 && vnum > 0 && vadr + vnum <= nvert)) meshProblems.push(`mesh ${k}: vertices ${vadr}+${vnum} > ${nvert}`);
  if (!(fadr >= 0 && fnum > 0 && fadr + fnum <= nface)) meshProblems.push(`mesh ${k}: faces ${fadr}+${fnum} > ${nface}`);
  if (!(nadr >= 0 && nadr + nnum <= nnormal)) meshProblems.push(`mesh ${k}: normals ${nadr}+${nnum} > ${nnormal}`);
  for (let i = 3 * fadr; i < 3 * (fadr + fnum); i++) {
    const v = model.mesh_face[i];
    const n = model.mesh_facenormal[i];
    if (v < 0 || v >= vnum) {
      meshProblems.push(`mesh ${k}: face index ${v} outside its ${vnum} vertices`);
      break;
    }
    if (n < 0 || n >= nnum) {
      meshProblems.push(`mesh ${k}: face normal index ${n} outside its ${nnum} normals`);
      break;
    }
  }
}
check('mesh arrays are consistent (vertadr + vertnum within mesh_vert, face and normal indices in range)', meshProblems.length === 0,
  meshProblems.length ? meshProblems.slice(0, 3).join('; ') : `${model.nmesh} meshes, ${nvert} vertices, ${nface} faces`);

// ---- geom classification -----------------------------------------------------------------------------------------

const { geoms, skipped } = classifyGeoms(mujoco, model);
const floor = geoms.filter((g) => g.role === 'floor');
check('one floor plane is found', floor.length === 1 && floor[0].kind === 'plane', floor.map((g) => g.name).join(','));
check('collision hulls are not drawn', geoms.every((g) => g.group !== GEOM_GROUP.collision));
let visual = 0;
for (let i = 0; i < model.ngeom; i++) if (model.geom_group[i] === GEOM_GROUP.visual && model.geom_rgba[4 * i + 3] > 0) visual++;
const robotGeoms = geoms.filter((g) => g.role === 'robot');
check('every visible robot visual geom is drawn', visual > 0 && robotGeoms.length === visual, `${robotGeoms.length} of ${visual}`);
check('no drawable geom is skipped', skipped.length === 0, skipped.length ? JSON.stringify(skipped) : `${geoms.length} geoms drawn`);
check('mesh geoms point at a mesh', geoms.filter((g) => g.kind === 'mesh').every((g) => g.dataid >= 0 && g.dataid < model.nmesh));

let triangles = 0;
const arrayProblems = [];
for (const meshId of new Set(geoms.filter((g) => g.kind === 'mesh').map((g) => g.dataid))) {
  const { positions, normals, index } = meshArrays(model, meshId);
  const fnum = model.mesh_facenum[meshId];
  triangles += fnum;
  if (!positions.every(Number.isFinite)) arrayProblems.push(`mesh ${meshId}: non-finite position`);
  if (normals) {
    if (positions.length !== 9 * fnum || normals.length !== positions.length) arrayProblems.push(`mesh ${meshId}: unindexed sizes`);
    for (let i = 0; i < normals.length; i += 3) {
      const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
      if (!close(len, 1, 1e-3)) {
        arrayProblems.push(`mesh ${meshId}: normal of length ${len}`);
        break;
      }
    }
  } else if (!index || index.length !== 3 * fnum || positions.length !== 3 * model.mesh_vertnum[meshId]) {
    arrayProblems.push(`mesh ${meshId}: indexed sizes`);
  }
}
check('meshArrays gives finite triangles with unit normals for every drawn mesh', arrayProblems.length === 0,
  arrayProblems.length ? arrayProblems.slice(0, 3).join('; ') : `${triangles} triangles`);

// ---- kinematics --------------------------------------------------------------------------------------------------

const robot = robotRoot(mujoco, model);
check('the robot root is the floating base', robot.body > 0 && robot.qposAdr === 0, `${robot.name} (body ${robot.body}), qpos ${robot.qposAdr}`);

const geomX = (id) => mirror.data.geom_xpos[3 * id];
const robotGeom = robotGeoms[0].id;
const worldGeom = geoms.find((g) => g.role === 'world' && g.body === 0).id;
const stream = Float64Array.from(mirror.qpos);
const x0 = geomX(robotGeom);
const w0 = geomX(worldGeom);
const moved = Float64Array.from(stream);
moved[0] += 0.25;
check('setQpos accepts a frame of length nq', mirror.setQpos(moved) === true);
check('mj_kinematics moves the robot geoms when qpos[0] changes', close(geomX(robotGeom) - x0, 0.25, 1e-9),
  `geom ${robotGeom}: dx ${(geomX(robotGeom) - x0).toFixed(6)}`);
check('world geoms stay put', geomX(worldGeom) === w0);

const warnings = [];
const warn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));
const short = mirror.setQpos(new Float64Array(model.nq - 1));
const again = mirror.setQpos([1, 2, 3]);
const nan = Float64Array.from(stream);
nan[5] = NaN;
const notFinite = mirror.setQpos(nan);
console.warn = warn;
check('a frame of the wrong length is ignored with one warning', short === false && again === false && warnings.filter((w) => /length/.test(w)).length === 1,
  warnings[0] || '');
check('a frame with a non-finite value is ignored', notFinite === false && close(geomX(robotGeom) - x0, 0.25, 1e-9));

const runs = 2000;
const tk = performance.now();
for (let i = 0; i < runs; i++) mujoco.mj_kinematics(model, mirror.data);
const perCall = (performance.now() - tk) / runs;
check('mj_kinematics is cheap enough for every frame', perCall < 1, `${(perCall * 1000).toFixed(1)} us per call`);

// ---- holds (dragging) and region markers --------------------------------------------------------------------------

const scene = deriveScene(mujoco, model);
const obj = scene.objects[0];
check('the derived scene finds a free object', !!obj && obj.qpos_adr > 0 && obj.geom_ids.length > 0,
  obj ? `${obj.name}, qpos ${obj.qpos_adr}, geoms ${obj.geom_ids}` : 'none');
check('the derived scene finds the table and a region marker', !!scene.table && scene.regions.length > 0,
  `table top ${scene.table ? scene.table.top_z.toFixed(3) : '-'}, regions ${scene.regions.map((r) => r.name)}`);
if (obj) {
  const adr = obj.qpos_adr;
  const g = obj.geom_ids[0];
  mirror.setQpos(stream);
  const ox = geomX(g);
  const pose = mirror.freePose(adr);
  pose[0] += 0.1;
  mirror.hold(adr, pose);
  mirror.setQpos(stream);
  check('a held object ignores the streamed pose', close(geomX(g), ox + 0.1, 1e-9) && close(geomX(robotGeom), x0, 1e-9));
  mirror.releaseWhenCaughtUp(adr);
  mirror.setQpos(stream);
  check('a dropped object keeps its pose while the stream lags', mirror.holds.has(adr) && close(geomX(g), ox + 0.1, 1e-9));
  const caught = Float64Array.from(stream);
  caught[adr] = pose[0];
  mirror.setQpos(caught);
  check('the hold ends once the stream shows the object where it was dropped', !mirror.holds.has(adr));
  mirror.hold(adr, pose);
  mirror.release(adr);
  mirror.setQpos(stream);
  check('after a release the object follows the stream again', close(geomX(g), ox, 1e-9));
}
const region = scene.regions[0];
if (region) {
  const target = [region.center[0] + 0.05, region.center[1] - 0.04, region.center[2]];
  mirror.setGeomPos(region.geom_id, target);
  mirror.refresh();
  const p = mirror.data.geom_xpos;
  const got = [p[3 * region.geom_id], p[3 * region.geom_id + 1], p[3 * region.geom_id + 2]];
  const placed = mirror.geomPosWritable ? got : mirror.posOverride.get(region.geom_id);
  check('a region marker moves to the scene\'s centre', placed.every((v, k) => close(v, target[k], 1e-9)),
    mirror.geomPosWritable ? 'written into model.geom_pos' : 'kept as an override');
}

// ---- world rows: gates and moved region markers (section 4.2) -----------------------------------------------------

// The shipped scenes have no gate: a static box of the world body stands in for one (a gate is such a box, gate_<name>,
// parked under the floor while open). Poses are read the way the viewport draws them: model.geom_pos through
// mj_kinematics, or the mirror's overrides when the views cannot be written.
const worldPos = (id) => {
  const o = mirror.posOverride.get(id);
  const p = mirror.data.geom_xpos;
  return o ? o.slice() : [p[3 * id], p[3 * id + 1], p[3 * id + 2]];
};
const worldMat = (id) => mirror.matOverride.get(id) || Array.from(mirror.data.geom_xmat.subarray(9 * id, 9 * id + 9));
const near = (a, b, tol = 1e-9) => a.length === b.length && a.every((v, k) => close(v, b[k], tol));
const box = mujoco.mjtGeom.mjGEOM_BOX.value;
const gateGeom = geoms.find((g) => g.role === 'world' && g.body === 0 && model.geom_type[g.id] === box
  && !scene.regions.some((r) => r.geom_id === g.id));
check('a static world box stands in for a gate', !!gateGeom, gateGeom ? `${gateGeom.name || 'geom'} ${gateGeom.id}` : 'none');
if (gateGeom && region) {
  mirror.setQpos(stream);
  const gid = gateGeom.id;
  const homePos = worldPos(gid);
  const homeMat = worldMat(gid);
  const center = [homePos[0], homePos[1], homePos[2]];
  const parked = [center[0], center[1], -10];
  const yaw90 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];             // a quarter turn about z, wxyz
  const R90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const gate = (pos, state) => ({ name: 'door', geom_id: gid, center, half_size: gateGeom.size, pos, quat: [1, 0, 0, 0], state });
  const sceneWith = (gates) => ({ ...scene, gates });

  mirror.placeScene(sceneWith([gate(parked, 'open')]));
  mirror.refresh();
  check('placeScene parks an open gate where the scene dict saw it (z -10)', near(worldPos(gid), parked));
  check('placeScene puts the region marker at its centre', near(worldPos(region.geom_id), region.center));

  const gateRow = { kind: 'scene/gate', t: 41.2, t_wall: 1792916000.5, name: 'door', state: 'closed', from_side: '-x',
    geom_id: gid, pos: center, quat: yaw90 };
  const before = worldPos(robotGeom);
  const moved1 = mirror.applyWorldRow(gateRow);
  mirror.refresh();
  check('a scene/gate row with geom_id and pos closes the gate (pose and rotation)', moved1 === gid
    && near(worldPos(gid), center) && near(worldMat(gid), R90, 1e-9) && near(worldPos(robotGeom), before),
  mirror.geomPosWritable && mirror.geomQuatWritable ? 'written into model.geom_pos / geom_quat' : 'kept as overrides');

  const to = [region.center[0] - 0.12, region.center[1] + 0.2, region.center[2]];
  const markerRow = { kind: 'scene/object_motion', t: 42, t_wall: 1792916001, step: 0, mode: 'teleport', object: region.name,
    state: 'finished', reason: 'teleport', from: region.center, to, geom_id: region.geom_id, pos: to, quat: [1, 0, 0, 0] };
  const moved2 = mirror.applyWorldRow(markerRow);
  mirror.refresh();
  check('a scene/object_motion row with geom fields moves the region marker', moved2 === region.geom_id
    && near(worldPos(region.geom_id), to));

  const snapshot = Array.from(mirror.data.geom_xpos);
  const objRow = { kind: 'scene/object_motion', t: 43, t_wall: 1792916002, step: 1, mode: 'drift', object: obj ? obj.name : 'cylinder_0',
    state: 'finished', reason: 'distance', from: [0.4, 0, 0.8], to: [0.5, 0, 0.8] };
  const moved3 = mirror.applyWorldRow(objRow);
  mirror.refresh();
  check('a scene/object_motion row without geom fields (a free object) moves nothing', moved3 === -1
    && near(Array.from(mirror.data.geom_xpos), snapshot) && worldGeomPose(objRow) === null);
  const oldRow = { ...markerRow, to: [region.center[0] + 0.3, region.center[1], region.center[2] + 0.01] };
  for (const k of ['geom_id', 'pos', 'quat']) delete oldRow[k];
  const moved4 = mirror.applyWorldRow(oldRow, scene.regions);
  mirror.refresh();
  check('a region row recorded without geom fields moves the marker to its `to` when the scene\'s regions are given',
    moved4 === region.geom_id && near(worldPos(region.geom_id), oldRow.to)
    && worldGeomPose({ ...oldRow, state: 'started' }, scene.regions) === null && worldGeomPose(oldRow) === null);
  check('other rows and malformed poses are no world rows', worldGeomPose({ kind: 'task/status', geom_id: gid, pos: center }) === null
    && worldGeomPose({ ...gateRow, pos: [1, 2] }) === null && worldGeomPose({ ...gateRow, geom_id: '3' }) === null
    && mirror.applyWorldRow({ ...gateRow, geom_id: model.ngeom }) === -1);

  // a seek backwards: the scene dict again (gate parked, marker at its centre), the rotation the row gave undone
  mirror.placeScene(sceneWith([gate(parked, 'open')]));
  mirror.refresh();
  check('placeScene undoes the world rows (seeking back): gate parked, marker home, rotation restored',
    near(worldPos(gid), parked) && near(worldPos(region.geom_id), region.center) && near(worldMat(gid), homeMat, 1e-9));

  // a page that connects after the gate closed (or a replay seeking past it): the scene dict holds it closed
  mirror.placeScene(sceneWith([gate(center, 'closed')]));
  mirror.refresh();
  check('placeScene places a gate the scene dict holds closed', near(worldPos(gid), center));

  // a binding whose views cannot be written: the pose is kept as overrides the viewport draws after kinematics
  const writable = [mirror.geomPosWritable, mirror.geomQuatWritable];
  mirror.geomPosWritable = false;
  mirror.geomQuatWritable = false;
  mirror.applyWorldRow(gateRow);
  mirror.refresh();
  check('without writable views a gate row is kept as a pose and rotation override', near(mirror.posOverride.get(gid), center)
    && near(mirror.matOverride.get(gid), R90, 1e-9) && near(Array.from(mirror.data.geom_xpos.subarray(3 * gid, 3 * gid + 3)), center));
  mirror.placeScene(sceneWith([gate(parked, 'open')]));
  check('placeScene replaces the overrides with the scene dict\'s pose', near(mirror.posOverride.get(gid), parked)
    && near(mirror.matOverride.get(gid), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12)
    && near(mirror.posOverride.get(region.geom_id), region.center));
  [mirror.geomPosWritable, mirror.geomQuatWritable] = writable;

  mirror.placeScene(scene);       // no gates in the dict: everything moved goes back to the loaded model
  mirror.refresh();
  check('a scene dict without gates puts every moved geom back as loaded', near(worldPos(gid), homePos)
    && near(worldMat(gid), homeMat, 1e-9) && mirror.geomHome.size === 1 && mirror.geomHome.has(region.geom_id));
}

// ---- errors and cleanup ------------------------------------------------------------------------------------------

let loadError = null;
try {
  openModel(mujoco, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
} catch (err) {
  loadError = err;
}
check('a file that is not an .mjb raises a readable error', loadError instanceof Error && /MuJoCo/.test(loadError.message),
  loadError ? loadError.message : 'no error');

mirror.dispose();
let deleted = false;
try {
  model.nq; // eslint-disable-line no-unused-expressions
} catch (err) {
  deleted = /deleted/.test(String(err));
}
let twice = true;
try {
  mirror.dispose();
} catch (err) {
  twice = false;
}
check('dispose deletes the WASM handles and is safe to repeat', deleted && twice && mirror.model === null && mirror.data === null);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
process.exit(failed.length ? 1 : 0);
