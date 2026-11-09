// Node check of what the viewport draws the scene with (docs/design/WEB_HUD.md section 8.2): MuJoCo WASM loads a
// replay bundle's model.mjb, and the viewport's three.js-free modules (src/viewport/materials.js and meshes.js) resolve
// every drawn geom to its MuJoCo appearance: a colour by MuJoCo's rule, a 2-D texture with texture coordinates where the
// model gives one, a matte roughness. The bundle's scene dict (episode.json next to the model) says which colours its
// objects and target regions must show. The sign boards of the gesture-gates scene (papers/b4_gesture_gates) must show
// their pictograms: a 2-D texture with dark strokes on a light ground, and texture coordinates spanning the picture.
//
//   node web/tests/test_materials.mjs <bundle dir | model.mjb> [<bundle dir | model.mjb> ...]
//
// Prints one line per check, what the first load costs (bytes, load time, the textures the page makes and their pixels)
// and a summary; exits 1 when a check fails, 2 on a usage error.

import fs from 'node:fs';
import path from 'node:path';
import { classifyGeoms, getMujoco, meshArrays, openModel } from '../src/viewport/meshes.js';
import { geomLook, matteRoughness, projectedUVs, readLook, textureRGBA } from '../src/viewport/materials.js';

/** The matte range the viewport draws in (viewport.js PAPER.roughness). */
const ROUGHNESS = [0.75, 0.9];
/** Colours read from float32 arrays and from the JSON of the scene dict agree to this. */
const COLOR_TOL = 1e-5;
/** A pictogram: a light ground (some pixels at least this light, 0..255 luminance) and strokes at least INK_CONTRAST
 * darker, not a blank or a flat tint (the boards' styles: black on white, dark blue on pale yellow, green on white). */
const GROUND_MIN = 192;
const INK_CONTRAST = 96;

const inputs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!inputs.length || !inputs.every((p) => fs.existsSync(p))) {
  console.error('usage: node web/tests/test_materials.mjs <bundle dir | model.mjb> [...]');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const same = (a, b, tol = COLOR_TOL) => a.length >= b.length && b.every((v, k) => Math.abs(a[k] - v) <= tol);
const fmt = (v) => `[${Array.from(v, (x) => Number(x).toFixed(3)).join(', ')}]`;

// ---- the pure helpers on their own -------------------------------------------------------------------------------

{
  // a 2 x 1 x 3 m box's +x face (normal +x, spanning y -0.5..0.5 and z -1.5..1.5): u runs with +y, the image's top row
  // (v = 0) at the top of the wall; per face the image spans it, per metre it repeats
  const pos = new Float32Array([1, -0.5, 1.5, 1, 0.5, 1.5, 1, -0.5, -1.5, 1, 0.5, -1.5]);
  const nrm = new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
  const face = projectedUVs(pos, nrm, [1, 0.5, 1.5], [1, 1], false);
  const metre = projectedUVs(pos, nrm, [1, 0.5, 1.5], [2, 2], true);
  check('projected texture coordinates stand upright on a wall and span the face (or repeat per metre)',
    same(face, [0, 0, 1, 0, 0, 1, 1, 1]) && same(metre, [-1, -3, 1, -3, -1, 3, 1, 3]), `${fmt(face)} / ${fmt(metre)}`);
  const r = [matteRoughness({ roughness: -1, specular: 0.5, shininess: 0.5 }, ROUGHNESS),
    matteRoughness({ roughness: -1, specular: 1, shininess: 1 }, ROUGHNESS),
    matteRoughness({ roughness: -1, specular: 0, shininess: 0.5 }, ROUGHNESS),
    matteRoughness({ roughness: 0.2, specular: 0.5, shininess: 0.5 }, ROUGHNESS)];
  check('MuJoCo specular and shininess map into the matte range (the default material in its middle)',
    same(r, [0.825, 0.75, 0.9, 0.75], 1e-9), fmt(r));
}

// ---- one bundle --------------------------------------------------------------------------------------------------

const mujoco = await getMujoco();

function bundleFiles(p) {
  const stat = fs.statSync(p);
  const mjb = stat.isDirectory() ? path.join(p, 'model.mjb') : p;
  const episode = path.join(path.dirname(mjb), 'episode.json');
  return { mjb, episode: fs.existsSync(episode) ? JSON.parse(fs.readFileSync(episode, 'utf8')) : null };
}

function luminanceRange(px) {
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    const y = 0.2126 * px.data[i] + 0.7152 * px.data[i + 1] + 0.0722 * px.data[i + 2];
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return [lo, hi];
}

for (const input of inputs) {
  const { mjb, episode } = bundleFiles(input);
  const label = path.basename(path.dirname(mjb));
  const sceneName = episode ? episode.scene_name : null;
  console.log(`\n# ${label}${sceneName ? ` (${sceneName})` : ''}`);
  if (!fs.existsSync(mjb)) {
    check(`${label}: the bundle has a model.mjb`, false, mjb);
    continue;
  }
  const bytes = fs.readFileSync(mjb);
  const t0 = performance.now();
  const mirror = openModel(mujoco, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const loadMs = performance.now() - t0;
  const { model } = mirror;
  check(`${label}: the model loads with its textures`, model.ntex > 0 && (!episode || !episode.model || episode.model.ntex === model.ntex),
    `${(bytes.length / 1e6).toFixed(2)} MB, ntex ${model.ntex}, nmat ${model.nmat}, loaded in ${loadMs.toFixed(0)} ms`);

  const look = readLook(mujoco, model);
  const floorMats = look.materials.filter((m) => m.name.startsWith('floor_'));
  check(`${label}: mat_texuniform is read (the builder's floor material repeats per metre)`,
    look.uniformSource !== 'default' && floorMats.every((m) => m.uniform),
    `${look.uniformSource}; ${look.materials.filter((m) => m.uniform).map((m) => m.name).join(', ') || 'none uniform'}`);

  const { geoms } = classifyGeoms(mujoco, model);
  const drawn = geoms.filter((g) => g.role !== 'floor');
  const looks = new Map(drawn.map((g) => [g.id, geomLook(model, look, g.id)]));

  // every drawn geom shows what the model says, by MuJoCo's rule, and nothing falls back to a made-up white
  const problems = [];
  for (const g of drawn) {
    const a = looks.get(g.id);
    const own = Array.from(model.geom_rgba.subarray(4 * g.id, 4 * g.id + 4));
    const mat = a.material >= 0 ? look.materials[a.material] : null;
    const expected = a.from === 'material' ? mat.rgba : own;
    if (!a.rgba.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) problems.push(`${g.name}: rgba ${fmt(a.rgba)}`);
    else if (!same(a.rgba, expected)) problems.push(`${g.name}: ${fmt(a.rgba)} is not the ${a.from}'s ${fmt(expected)}`);
    else if (!mat && same(own, [0.5, 0.5, 0.5, 1])) problems.push(`${g.name}: neither a material nor a colour of its own`);
    else if (mat && mat.texture >= 0 && a.texture !== mat.texture) problems.push(`${g.name}: its material's texture is lost`);
    const rough = matteRoughness(a, ROUGHNESS);
    if (!(rough >= ROUGHNESS[0] && rough <= ROUGHNESS[1])) problems.push(`${g.name}: roughness ${rough}`);
  }
  const world = drawn.filter((g) => g.role === 'world');
  check(`${label}: every drawn geom resolves to its MuJoCo appearance (a material or its own colour, matte)`,
    problems.length === 0 && world.length > 0,
    problems.length ? problems.slice(0, 4).join('; ') : `${world.length} world geoms, ${drawn.length - world.length} robot geoms`);

  // every 2-D texture a drawn geom shows has its pixels, and a mesh showing one has texture coordinates
  const texProblems = [];
  const used = new Map();
  for (const g of drawn) {
    const a = looks.get(g.id);
    if (a.texture < 0) continue;
    if (!used.has(a.texture)) {
      const t1 = performance.now();
      const px = textureRGBA(model, look, a.texture);
      used.set(a.texture, { px, ms: performance.now() - t1 });
      if (!px || px.data.length !== 4 * px.width * px.height) texProblems.push(`${g.name}: texture ${a.texture} has no pixels`);
    }
    if (g.kind === 'mesh') {
      const { uvs } = meshArrays(model, g.dataid);
      const fnum = model.mesh_facenum[g.dataid];
      const hasTexcoord = model.mesh_texcoordadr[g.dataid] >= 0;
      if (hasTexcoord && !(uvs && uvs.length === 6 * fnum && uvs.every(Number.isFinite))) {
        texProblems.push(`${g.name}: mesh ${g.dataid} texture coordinates unreadable`);
      }
    }
  }
  check(`${label}: every texture a drawn geom shows has its pixels, and textured meshes their texture coordinates`,
    texProblems.length === 0, texProblems.length ? texProblems.slice(0, 4).join('; ')
      : `${used.size} textures: ${[...used.keys()].map((t) => look.textures[t].name).join(', ')}`);

  // the robot takes its own colours from the model
  const robot = drawn.filter((g) => g.role === 'robot');
  const robotOwn = robot.filter((g) => looks.get(g.id).material >= 0 || !same(looks.get(g.id).rgba, [0.5, 0.5, 0.5, 1]));
  const robotTex = robot.filter((g) => looks.get(g.id).texture >= 0);
  check(`${label}: the robot's visual meshes carry their own colours`, robot.length > 0 && robotOwn.length === robot.length,
    `${robotOwn.length} of ${robot.length} (${robotTex.length} textured: ${[...new Set(robotTex.map((g) => look.textures[looks.get(g.id).texture].name))].join(', ') || 'none'})`);

  // the scene dict's colours: objects and target regions show the colour the scene gave them
  const scene = episode ? episode.scene : null;
  if (scene) {
    const colourProblems = [];
    let n = 0;
    for (const o of scene.objects || []) {
      if (!Array.isArray(o.color) || o.color.length !== 4) continue;
      for (const id of o.geom_ids || []) {
        const a = looks.get(id);
        if (!a) continue;
        n++;
        if (!same(a.rgba, o.color)) colourProblems.push(`${o.name} geom ${id}: ${fmt(a.rgba)} != ${fmt(o.color)}`);
      }
    }
    for (const r of scene.regions || []) {
      if (!Array.isArray(r.color) || r.color.length !== 4 || !looks.has(r.geom_id)) continue;
      n++;
      const a = looks.get(r.geom_id);
      if (!same(a.rgba, r.color)) colourProblems.push(`${r.name}: ${fmt(a.rgba)} != ${fmt(r.color)}`);
    }
    const named = [...(scene.objects || []).map((o) => `${o.name} ${fmt(o.color || [])}`),
      ...(scene.regions || []).map((r) => `${r.name} ${fmt(r.color || [])}`)];
    check(`${label}: objects and target regions show the scene's colours`, n > 0 && colourProblems.length === 0,
      colourProblems.length ? colourProblems.slice(0, 4).join('; ') : named.join('; '));
  } else {
    console.log(`skip  ${label}: no episode.json next to the model, so no scene colours to compare`);
  }

  // the gesture-gates scene: the sign boards show their pictograms
  const signs = drawn.filter((g) => /^sign_\d+\/face$/.test(g.name));
  if (sceneName === 'papers/b4_gesture_gates' || signs.length) {
    const signProblems = [];
    const seen = [];
    for (const g of signs) {
      const a = looks.get(g.id);
      const tex = a.texture >= 0 ? look.textures[a.texture] : null;
      const px = tex ? textureRGBA(model, look, a.texture) : null;
      const { uvs } = g.kind === 'mesh' ? meshArrays(model, g.dataid) : { uvs: null };
      if (!tex || tex.kind !== '2d' || !px) {
        signProblems.push(`${g.name}: no 2-D texture`);
        continue;
      }
      const [lo, hi] = luminanceRange(px);
      if (!(hi >= GROUND_MIN && hi - lo >= INK_CONTRAST)) {
        signProblems.push(`${g.name}: ${tex.name} is not a picture (luminance ${lo.toFixed(0)}..${hi.toFixed(0)})`);
      }
      if (!uvs) {
        signProblems.push(`${g.name}: no texture coordinates`);
        continue;
      }
      const us = Array.from(uvs).filter((_, i) => i % 2 === 0);
      const vs = Array.from(uvs).filter((_, i) => i % 2 === 1);
      const span = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
      if (!same(span, [0, 1, 0, 1], 1e-6)) signProblems.push(`${g.name}: texture coordinates span ${fmt(span)}, not the picture`);
      // upright and not mirrored, seen from the side the picture faces: the first texture row (v = 0) at the top, u
      // running to the viewer's right (MuJoCo's convention: v counts rows from the first, which is the image's top)
      const { positions } = meshArrays(model, g.dataid);
      const R = mirror.data.geom_xmat.subarray(9 * g.id, 9 * g.id + 9);
      const world = (i) => [0, 1, 2].map((r) => R[3 * r] * positions[3 * i] + R[3 * r + 1] * positions[3 * i + 1]
        + R[3 * r + 2] * positions[3 * i + 2]);
      const [p0, p1, p2] = [world(0), world(1), world(2)];
      const e1 = p1.map((x, k) => x - p0[k]);
      const e2 = p2.map((x, k) => x - p0[k]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const right = [-n[1], n[0], 0];             // (-n) x z: the viewer's right, looking at the face against its normal
      const corr = (xs, ys) => {
        const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
        const my = ys.reduce((a, b) => a + b, 0) / ys.length;
        return xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
      };
      const corners = us.map((_, i) => world(i));
      const across = corners.map((p) => p[0] * right[0] + p[1] * right[1]);
      const up = corners.map((p) => p[2]);
      if (!(corr(us, across) > 0 && corr(vs, up) < 0)) signProblems.push(`${g.name}: the picture is mirrored or upside down`);
      seen.push(`${g.name} ${tex.name} ${tex.width}x${tex.height}x${tex.nchannel}, ${uvs.length / 2} corners, luminance ${lo.toFixed(0)}..${hi.toFixed(0)}`);
    }
    check(`${label}: the sign boards resolve to a 2-D pictogram with texture coordinates spanning it`,
      signs.length >= 2 && signProblems.length === 0,
      signProblems.length ? signProblems.slice(0, 4).join('; ') : seen.join('; ') || 'no sign geoms');
  }

  // what the first load costs the page: the file, its load, the textures it makes (RGBA, plus a third for mipmaps)
  let pixels = 0;
  let expandMs = 0;
  for (const { px, ms } of used.values()) {
    if (!px) continue;
    pixels += px.width * px.height;
    expandMs += ms;
  }
  console.log(`cost  ${label}: ${bytes.length} bytes; load ${loadMs.toFixed(0)} ms; ${used.size} textures made `
    + `(${[...used.keys()].map((t) => `${look.textures[t].name} ${look.textures[t].width}x${look.textures[t].height}`).join(', ')}), `
    + `${pixels} pixels, ${(4 * pixels / 1e6).toFixed(1)} MB as RGBA (${(4 * pixels * 4 / 3 / 1e6).toFixed(1)} MB with mipmaps), `
    + `RGBA expansion ${expandMs.toFixed(0)} ms; textures in the file the page does not draw: `
    + `${look.textures.filter((t) => !used.has(t.id)).map((t) => `${t.name} (${t.kind}, ${t.width * t.height * t.nchannel} bytes)`).join(', ') || 'none'}`);
  mirror.dispose();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
