import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ============================================================
   DIGI DEFENSE — camp media lab FPS
   Room recreated from the floor plan of 70 Clark Rd, Union Dale PA:
   ~12m x 18m open hall, two glass garage doors on the west wall,
   entry double doors between them, green screen on the north wall,
   iMac desks along the NE and SE walls, chesterfield couches + rugs.
   ============================================================ */

// ============================================================
// PERFORMANCE TIERS
// ============================================================
// The lab is lit by a dozen real point lights, casts soft shadows and runs a
// bloom + grade chain on top — gorgeous on a desktop GPU, a slideshow on an
// 8 GB laptop with integrated graphics. Everything expensive sits behind a
// tier, the tier is guessed from the machine on first run, and the renderer
// keeps re-tuning its own resolution while you play so the frame rate holds.
const TIERS = {
  low: {
    label: 'LOW', maxPR: 1, minScale: 0.5,
    bloom: false, shadows: false, shadowSize: 512, softShadows: false, shadowEvery: 6,
    warmCans: 0, lightBoost: 1.5, dust: 0, fall: 600, aniso: 1, texMax: 512,
    video: false, grain: 0.022, envRes: 0.1, fogFarMul: 0.75,
  },
  medium: {
    label: 'MEDIUM', maxPR: 1.25, minScale: 0.6,
    bloom: true, shadows: true, shadowSize: 1024, softShadows: false, shadowEvery: 3,
    warmCans: 4, lightBoost: 1.2, dust: 260, fall: 1200, aniso: 4, texMax: 1024,
    video: true, grain: 0.034, envRes: 0.04, fogFarMul: 1,
  },
  high: {
    label: 'HIGH', maxPR: 2, minScale: 0.75,
    bloom: true, shadows: true, shadowSize: 2048, softShadows: true, shadowEvery: 1,
    warmCans: 10, lightBoost: 1, dust: 700, fall: 2200, aniso: 8, texMax: 4096,
    video: true, grain: 0.042, envRes: 0.04, fogFarMul: 1,
  },
};
const TIER_ORDER = ['low', 'medium', 'high'];

// A first guess from whatever the browser is willing to tell us. deviceMemory
// is rounded down and capped at 8 by Chrome, so 8 means "8 or more" — that
// still lands on MEDIUM, and the adaptive scaler takes it from there.
function guessTier() {
  let gpu = '';
  try {
    const g = document.createElement('canvas').getContext('webgl');
    const ext = g && g.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = g.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
  } catch (e) { /* fingerprint blockers hide this; fall through to the counts */ }
  if (/swiftshader|llvmpipe|basic render|software/i.test(gpu)) return 'low';
  const weak = /intel.*(hd|uhd) graphics|iris\D*[56]\d\d|mali|adreno [1-5]|powervr/i.test(gpu);
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 4;
  if (weak || mem <= 4 || cores <= 2) return 'low';
  if (mem <= 8 || cores <= 4) return 'medium';
  return 'high';
}

let savedTier = null;
try { savedTier = localStorage.getItem('dd_quality'); } catch (e) { /* private mode */ }
if (!TIERS[savedTier]) savedTier = null;
const perf = {
  name: savedTier || guessTier(),
  pinned: !!savedTier,   // player picked it by hand, so the menu says so
  scale: 1,        // adaptive resolution, multiplied onto the tier's pixel-ratio cap
  fps: 60, ms: 16.7,
  frame: 0,
  acc: 0, accFrames: 0, cooldown: 0, starved: 0,
  showStats: false,
};
let TIER = TIERS[perf.name];

// ---------- basics ----------
const canvas = document.getElementById('c');
// antialias is deliberately off: every frame goes through EffectComposer render
// targets, so MSAA on the default framebuffer would only smooth the final
// full-screen quad — pure cost, zero benefit.
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: false, stencil: false, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, TIER.maxPR));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = TIER.shadows;
renderer.shadowMap.type = TIER.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
// shadows are re-rendered on a schedule (see tick), not every single frame
renderer.shadowMap.autoUpdate = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.7;
// the composer renders several passes per frame; keep the counters accumulating
// across all of them instead of resetting on every internal render call
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb9cdd8);          // overcast PA sky
scene.fog = new THREE.Fog(0xc3d6e0, 45, 110);

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 250);
const BASE_FOV = 72;

// image-based lighting so metal/glass/leather pick up real room reflections
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), TIER.envRes).texture;
  pmrem.dispose();   // the generator's scratch targets are dead weight after this
}

// ---------- post-processing: bloom + cinematic grade ----------
const FinalGrade = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.0011 },
    uGrain: { value: 0.042 },
    uFlash: { value: 0 },
    uDamage: { value: 0 },
    uSprint: { value: 0 },
    uPsy: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uAberration, uGrain, uFlash, uDamage, uSprint, uPsy;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    vec3 hueShift(vec3 col, float a) {
      const vec3 k = vec3(0.57735);
      float c = cos(a), s = sin(a);
      return col * c + cross(k, col) * s + k * dot(k, col) * (1.0 - c);
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // barrel distortion, punchier while sprinting
      uv = 0.5 + c * (1.0 + (0.045 + uSprint * 0.05) * r2);

      // psychedelic: rippling warp of the whole frame
      if (uPsy > 0.001) {
        uv += vec2(
          sin(uv.y * 18.0 + uTime * 3.4) * 0.016,
          cos(uv.x * 15.0 + uTime * 2.7) * 0.016) * uPsy;
      }

      // radial chromatic aberration (stronger at frame edges + on hits)
      float ab = uAberration * (1.0 + uDamage * 1.5 + uPsy * 3.0) * (1.0 + r2 * 3.0);
      vec2 dir = normalize(c + 1e-6);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir * ab).b;

      // filmic contrast + slight teal shadows / warm highlights
      col = pow(max(col, 0.0), vec3(0.95));
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, 1.18);
      col *= mix(vec3(0.93, 0.97, 1.06), vec3(1.07, 1.01, 0.93), smoothstep(0.15, 0.85, lum));

      // psychedelic: cycling hue banded by luminance + screen position
      if (uPsy > 0.001) {
        float a = uTime * 2.6 + lum * 6.0 + (uv.x + uv.y) * 5.0;
        vec3 trip = hueShift(col, a);
        trip = mix(vec3(dot(trip, vec3(0.33))), trip, 2.4);       // super-saturate
        trip += 0.18 * vec3(sin(a), sin(a + 2.09), sin(a + 4.19));
        col = mix(col, trip, uPsy);
      }

      // vignette
      col *= smoothstep(1.05, 0.24, r2 * 1.9);

      // flash bleach + damage pulse
      col += uFlash * vec3(1.0, 0.98, 0.92);
      col = mix(col, vec3(col.r * 1.2, col.g * 0.42, col.b * 0.4),
                uDamage * 0.6 * smoothstep(0.015, 0.2, r2));

      // animated film grain
      float g = hash(vUv * vec2(1024.0, 768.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (1.2 - lum * 0.7);

      gl_FragColor = vec4(col, 1.0);
    }`,
};

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const BLOOM_BASE = 0.34;
// UnrealBloomPass is five downsample + five upsample full-screen passes. It is
// by far the most expensive thing on the frame, so it only exists above LOW.
let bloomPass = null;
function setBloom(on) {
  if (on && !bloomPass) {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight), BLOOM_BASE, 0.5, 0.85);
    composer.insertPass(bloomPass, 1);
  } else if (!on && bloomPass) {
    composer.removePass(bloomPass);
    bloomPass.dispose();
    bloomPass = null;
  }
}
setBloom(TIER.bloom);
const gradePass = new ShaderPass(FinalGrade);
gradePass.uniforms.uGrain.value = TIER.grain;
composer.addPass(gradePass);
composer.addPass(new OutputPass());

// ---------- resolution ----------
// One knob drives every render target: the tier's pixel-ratio ceiling times
// the adaptive scale. Dropping this is the cheapest frame rate you can buy,
// because the whole pipeline is fragment-bound.
function applyResolution() {
  const pr = Math.max(0.4, Math.min(devicePixelRatio, TIER.maxPR) * perf.scale);
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);   // resizes every pass, bloom's mip chain included
}

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  applyResolution();
}
addEventListener('resize', resize);

// ---------- texture budget ----------
// The downloaded models ship 2K PBR sets. Decoded, a single 2048² map is 16 MB
// of RAM before mipmaps — the bear alone is 20 MB, the DSLR another 110 MB
// across seven maps. That is what actually kills an 8 GB laptop, so on the
// lower tiers every loaded map gets resampled down to the tier's ceiling and
// the original decoded bitmap is released.
const ANISO = Math.min(TIER.aniso, renderer.capabilities.getMaxAnisotropy());
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
  'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'lightMap'];
const tunedTextures = new WeakSet();

function tuneTexture(tex) {
  if (!tex || !tex.isTexture || tex.isCompressedTexture || tunedTextures.has(tex)) return;
  tunedTextures.add(tex);
  tex.anisotropy = ANISO;
  const img = tex.image;
  const ok = img && (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement ||
    (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap));
  if (!ok) { tex.needsUpdate = true; return; }
  const w = img.width, h = img.height;
  if (!w || !h || Math.max(w, h) <= TIER.texMax) { tex.needsUpdate = true; return; }
  const k = TIER.texMax / Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  tex.image = c;
  tex.needsUpdate = true;
  if (img.close) img.close();          // hand the decoded bitmap back to the GC
}

// Run over anything that just came out of GLTFLoader: shrink its maps, and drop
// shadow casting entirely when the tier has shadows off (it doubles draw calls).
function tuneModel(root) {
  const seen = new Set();
  root.traverse(o => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (!TIER.shadows) { o.castShadow = false; o.receiveShadow = false; }
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      for (const slot of TEX_SLOTS) tuneTexture(m[slot]);
    }
  });
  return root;
}

// One loader for the whole game, and every model goes through here so nothing
// slips past the texture budget.
const modelLoader = new GLTFLoader();
function loadModel(url, onLoad, onError) {
  modelLoader.load(url, g => { tuneModel(g.scene); onLoad(g); },
    undefined, onError || (e => console.warn('model failed:', url, e)));
}

// Free a mesh we are never going to draw, along with the maps only it referenced.
function discardMesh(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    if (!m) continue;
    for (const slot of TEX_SLOTS) if (m[slot] && m[slot].isTexture) m[slot].dispose();
    m.dispose();
  }
  if (mesh.geometry) mesh.geometry.dispose();
  mesh.removeFromParent();
}

// ---------- room dimensions (meters, from floor plan 1m scale bar) ----------
const ROOM = { minX: -6, maxX: 6, minZ: -9, maxZ: 9, wallH: 3.05, ridgeH: 4.7 };
const DOOR_A = { z0: -7.5, z1: -3.5, h: 2.62 };   // north garage door (west wall)
const DOOR_B = { z0:  1.5, z1:  5.5, h: 2.62 };   // south garage door (west wall)

// ============================================================
// Procedural textures (knotty pine, floor, rug, etc.)
// ============================================================
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function rnd(a, b) { return a + Math.random() * (b - a); }

function drawKnot(ctx, x, y, r) {
  const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
  g.addColorStop(0, 'rgba(66,40,18,0.95)');
  g.addColorStop(0.45, 'rgba(112,74,38,0.75)');
  g.addColorStop(0.8, 'rgba(150,105,60,0.35)');
  g.addColorStop(1, 'rgba(150,105,60,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.5, r, rnd(-0.3, 0.3), 0, Math.PI * 2);
  ctx.fill();
  // rings
  ctx.strokeStyle = 'rgba(90,58,28,0.35)';
  for (let i = 1; i <= 3; i++) {
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.5 * (i / 3 + 0.15), r * (i / 3 + 0.15), 0, 0, Math.PI * 2);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

// knotty pine: horizontal tongue-and-groove boards
function pineTexture(light = 1.0, boards = 10, size = 1024) {
  const [c, ctx] = makeCanvas(size, size);
  const bh = size / boards;
  for (let i = 0; i < boards; i++) {
    const base = 205 * light + rnd(-14, 14);
    ctx.fillStyle = `rgb(${base | 0},${(base * 0.78) | 0},${(base * 0.52) | 0})`;
    ctx.fillRect(0, i * bh, size, bh);
    // wood grain: long wavy strokes
    for (let gLine = 0; gLine < 22; gLine++) {
      ctx.strokeStyle = `rgba(${120 + rnd(-30, 30) | 0},80,40,${rnd(0.04, 0.14)})`;
      ctx.lineWidth = rnd(0.6, 2.2);
      ctx.beginPath();
      let y = i * bh + rnd(2, bh - 2);
      ctx.moveTo(0, y);
      for (let x = 0; x <= size; x += 64) {
        ctx.quadraticCurveTo(x + 32, y + rnd(-3, 3), x + 64, y + rnd(-2, 2));
      }
      ctx.stroke();
    }
    // board seams
    ctx.fillStyle = 'rgba(70,45,20,0.55)';
    ctx.fillRect(0, i * bh, size, 1.6);
    ctx.fillStyle = 'rgba(255,235,200,0.25)';
    ctx.fillRect(0, i * bh + 1.6, size, 1.2);
    // butt joints
    for (let j = 0; j < 2; j++) {
      const jx = rnd(0, size);
      ctx.fillStyle = 'rgba(70,45,20,0.4)';
      ctx.fillRect(jx, i * bh, 1.4, bh);
    }
  }
  // knots
  const n = 14 + Math.random() * 8;
  for (let i = 0; i < n; i++) drawKnot(ctx, rnd(0, size), rnd(0, size), rnd(6, 17));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  return t;
}

// dark mixed-tone floor planks (vertical = along z)
function floorTexture(size = 1024) {
  const [c, ctx] = makeCanvas(size, size);
  const cols = 12;
  const pw = size / cols;
  const tones = [[124, 82, 48], [96, 60, 34], [140, 96, 58], [86, 56, 34], [110, 72, 42]];
  for (let i = 0; i < cols; i++) {
    let y = 0;
    while (y < size) {
      const ph = rnd(200, 420);
      const t0 = tones[(Math.random() * tones.length) | 0];
      const v = rnd(-12, 12);
      ctx.fillStyle = `rgb(${t0[0] + v | 0},${t0[1] + v | 0},${t0[2] + v | 0})`;
      ctx.fillRect(i * pw, y, pw, ph);
      for (let gLine = 0; gLine < 26; gLine++) {
        ctx.strokeStyle = `rgba(40,24,12,${rnd(0.05, 0.16)})`;
        ctx.lineWidth = rnd(0.5, 1.8);
        ctx.beginPath();
        const x = i * pw + rnd(2, pw - 2);
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x + rnd(-4, 4), y + ph * 0.3, x + rnd(-4, 4), y + ph * 0.6, x + rnd(-3, 3), y + ph);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(30,18,8,0.6)';
      ctx.fillRect(i * pw, y, pw, 2);
      y += ph;
    }
    ctx.fillStyle = 'rgba(30,18,8,0.7)';
    ctx.fillRect(i * pw, 0, 2, size);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  return t;
}
// (floor planks ~0.33m wide when repeated 3x over the 12m width)

// distressed sage-green oriental rug with big cream floral medallion (matched to photo)
function rugTexture() {
  const W = 640, H = 900;
  const [c, ctx] = makeCanvas(W, H);
  const SAGE = '#7d8a5f', CREAM = '#d3c49c', CREAM2 = '#c4b58c', OLIVE = '#4c4a2f', RED = '#a34434';

  // field
  ctx.fillStyle = SAGE; ctx.fillRect(0, 0, W, H);

  // cream petal blob helper (irregular floral shapes)
  function blob(x, y, r, col, lobes = 7, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let i = 0; i <= lobes * 2; i++) {
      const a = (i / (lobes * 2)) * Math.PI * 2;
      const rr = r * (i % 2 ? 0.72 : 1) * rnd(0.9, 1.1);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ornate border: outer guard, patterned band, inner guard
  ctx.strokeStyle = CREAM2; ctx.lineWidth = 6; ctx.strokeRect(10, 10, W - 20, H - 20);
  ctx.strokeStyle = CREAM; ctx.lineWidth = 30; ctx.strokeRect(36, 36, W - 72, H - 72);
  ctx.strokeStyle = CREAM2; ctx.lineWidth = 4; ctx.strokeRect(62, 62, W - 124, H - 124);
  // border motifs: alternating olive/red diamonds on the cream band
  function borderDiamond(x, y) {
    ctx.fillStyle = Math.random() > 0.6 ? RED : OLIVE;
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
    ctx.fillRect(-5, -5, 10, 10); ctx.restore();
  }
  for (let x = 60; x < W - 40; x += 42) { borderDiamond(x, 36); borderDiamond(x, H - 36); }
  for (let y = 60; y < H - 40; y += 42) { borderDiamond(36, y); borderDiamond(W - 36, y); }

  // scattered field flourishes
  for (let i = 0; i < 14; i++) {
    const x = rnd(110, W - 110), y = rnd(120, H - 120);
    if (Math.hypot(x - W / 2, y - H / 2) < 240) continue;
    blob(x, y, rnd(12, 26), Math.random() > 0.75 ? RED : CREAM2, 5, 0.55);
  }
  // corner quarter-florals
  for (const [x, y] of [[85, 85], [W - 85, 85], [85, H - 85], [W - 85, H - 85]]) {
    blob(x, y, 40, CREAM2, 6, 0.7);
    blob(x, y, 18, OLIVE, 5, 0.6);
  }

  // grand central medallion — layered irregular florals like the photo
  const cx = W / 2, cy = H / 2;
  blob(cx, cy, 250, CREAM2, 9, 0.5);          // halo
  blob(cx, cy, 215, CREAM, 9, 0.92);          // main cream mass
  // satellite petals around it
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4;
    blob(cx + Math.cos(a) * 235, cy + Math.sin(a) * 250, rnd(26, 40), CREAM, 6, 0.8);
  }
  blob(cx, cy, 150, SAGE, 8, 0.85);           // sage ring inside
  blob(cx, cy, 108, CREAM, 8, 0.95);          // inner cream
  blob(cx, cy, 62, OLIVE, 6, 0.9);            // dark olive core
  // center square knot
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 4);
  ctx.fillStyle = CREAM; ctx.fillRect(-26, -26, 52, 52);
  ctx.strokeStyle = OLIVE; ctx.lineWidth = 5; ctx.strokeRect(-26, -26, 52, 52);
  ctx.fillStyle = OLIVE; ctx.fillRect(-8, -8, 16, 16);
  ctx.restore();
  // red accents sprinkled on the medallion edge + field
  for (let i = 0; i < 26; i++) {
    const a = rnd(0, Math.PI * 2), r = rnd(180, 300);
    const x = cx + Math.cos(a) * r * 0.9, y = cy + Math.sin(a) * r;
    if (x < 70 || x > W - 70 || y < 70 || y > H - 70) continue;
    blob(x, y, rnd(5, 11), RED, 5, 0.75);
  }

  // heavy distressing: worn streaks along the pile + speckle
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${rnd(190, 225) | 0},${rnd(180, 210) | 0},${rnd(150, 175) | 0},${rnd(0.03, 0.09)})`;
    ctx.fillRect(rnd(0, W), rnd(0, H), rnd(6, 26), 2);
  }
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = `rgba(40,42,28,${rnd(0.02, 0.07)})`;
    ctx.fillRect(rnd(0, W), rnd(0, H), 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  return t;
}

// bright green screen cloth with vertical folds
function greenScreenTexture() {
  const [c, ctx] = makeCanvas(512, 512);
  for (let x = 0; x < 512; x++) {
    const fold = Math.sin(x * 0.045) * 0.5 + Math.sin(x * 0.013 + 2) * 0.5;
    const v = 165 + fold * 38;
    ctx.fillStyle = `rgb(${(v * 0.25) | 0},${v | 0},${(v * 0.3) | 0})`;
    ctx.fillRect(x, 0, 1, 512);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// fake window view (grass, trees, sky) for windows on solid walls
function windowViewTexture() {
  const [c, ctx] = makeCanvas(256, 256);
  const sky = ctx.createLinearGradient(0, 0, 0, 150);
  sky.addColorStop(0, '#b8cdd9'); sky.addColorStop(1, '#dbe6ea');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 256, 160);
  ctx.fillStyle = '#5d7a4a'; ctx.fillRect(0, 150, 256, 106);
  for (let i = 0; i < 7; i++) {
    const x = rnd(0, 256), h = rnd(40, 90);
    ctx.fillStyle = `rgb(${rnd(40, 70) | 0},${rnd(85, 115) | 0},${rnd(45, 65) | 0})`;
    ctx.beginPath();
    ctx.moveTo(x, 160 - h); ctx.lineTo(x - h * 0.35, 165); ctx.lineTo(x + h * 0.35, 165);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ransom-note style colorful letters (like the camp's signs)
function lettersTexture(text) {
  const [c, ctx] = makeCanvas(64 * text.length, 96);
  const cols = ['#e05a7a', '#4aa3d8', '#e8b23a', '#6dbb6d', '#b07ad0', '#e07a3a'];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ') continue;
    ctx.save();
    ctx.translate(32 + i * 60, 48 + rnd(-6, 6));
    ctx.rotate(rnd(-0.16, 0.16));
    ctx.fillStyle = cols[(Math.random() * cols.length) | 0];
    ctx.fillRect(-24, -32, 48, 64);
    ctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#222';
    ctx.font = `bold ${rnd(40, 52) | 0}px Georgia`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ch, 0, 2);
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function grassTexture() {
  const [c, ctx] = makeCanvas(256, 256);
  ctx.fillStyle = '#5b7a45'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3500; i++) {
    ctx.fillStyle = `rgba(${rnd(60, 110) | 0},${rnd(105, 150) | 0},${rnd(50, 80) | 0},0.5)`;
    ctx.fillRect(rnd(0, 256), rnd(0, 256), 2, rnd(2, 5));
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function gravelTexture() {
  const [c, ctx] = makeCanvas(256, 256);
  ctx.fillStyle = '#8d8a84'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = rnd(105, 175) | 0;
    ctx.fillStyle = `rgb(${v},${v - 4},${v - 8})`;
    ctx.beginPath(); ctx.arc(rnd(0, 256), rnd(0, 256), rnd(1, 3.2), 0, 7); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// macOS desktop with Photoshop open (recreated from the user's screenshot),
// shown on every iMac; the cropped face photo is drawn in once it loads
let desktopCtx = null, desktopTex = null;
function desktopTexture() {
  const [c, ctx] = makeCanvas(512, 320);
  desktopCtx = ctx;
  // wallpaper: aerial forest fading to lake water
  const grad = ctx.createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, '#33502f'); grad.addColorStop(0.5, '#3d6242');
  grad.addColorStop(0.6, '#2f7089'); grad.addColorStop(1, '#0e3f60');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 512, 320);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${rnd(40, 90) | 0},${rnd(90, 140) | 0},${rnd(45, 80) | 0},0.35)`;
    ctx.beginPath(); ctx.arc(rnd(0, 512), rnd(0, 165), rnd(1.5, 4), 0, 7); ctx.fill();
  }
  for (let i = 0; i < 240; i++) {
    ctx.fillStyle = `rgba(150,210,235,${rnd(0.04, 0.14)})`;
    ctx.fillRect(rnd(0, 512), rnd(180, 320), rnd(4, 14), 1.5);
  }
  // menu bar
  ctx.fillStyle = 'rgba(22,24,28,0.85)'; ctx.fillRect(0, 0, 512, 15);
  ctx.fillStyle = '#e8e8e8'; ctx.font = 'bold 8px Helvetica';
  ctx.fillText('  Photoshop 2026   File   Edit   Image   Layer   Select   Filter', 6, 10);
  // Photoshop window
  ctx.fillStyle = '#1c1c20'; ctx.fillRect(56, 30, 400, 244);
  ctx.fillStyle = '#2a2a2e'; ctx.fillRect(56, 30, 400, 16);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(66 + i * 12, 38, 3.5, 0, 7); ctx.fill();
  });
  ctx.fillStyle = '#aaa'; ctx.font = '7px Helvetica';
  ctx.fillText('IMG_5020.JPG @ 12.5% (Crop Preview, RGB/8*)', 110, 41);
  ctx.fillStyle = '#252529'; ctx.fillRect(56, 46, 18, 228);      // tool strip
  for (let i = 0; i < 12; i++) { ctx.fillStyle = '#3a3a3e'; ctx.fillRect(61, 52 + i * 17, 8, 8); }
  ctx.fillStyle = '#252529'; ctx.fillRect(390, 46, 66, 228);     // panels
  ctx.fillStyle = '#39a845'; ctx.fillRect(396, 52, 26, 26);      // green color picker
  for (let i = 0; i < 6; i++) { ctx.fillStyle = '#333338'; ctx.fillRect(396, 90 + i * 26, 54, 18); }
  // canvas area: transparency checkerboard where the face preview sits
  for (let y = 0; y < 20; y++) for (let x = 0; x < 22; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#3f3f43' : '#4b4b4f';
    ctx.fillRect(140 + x * 8, 60 + y * 8, 8, 8);
  }
  // dock
  ctx.fillStyle = 'rgba(200,205,215,0.32)';
  ctx.beginPath(); ctx.roundRect(146, 296, 220, 20, 6); ctx.fill();
  const dockCols = ['#4aa3d8', '#e8e5da', '#e05a3a', '#7a4ad8', '#3ad86e', '#25c4f0', '#28c840', '#3478f6', '#001e36', '#e8b23a'];
  dockCols.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.roundRect(151 + i * 21, 299, 15, 15, 4); ctx.fill();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  desktopTex = t;
  return t;
}

// full roster of cartoon face stickers for the face enemies
const faceTexes = [];
for (const name of ['face_maddy.png', 'face_asa.png', 'face_guy.png', 'face_jared.png']) {
  const [c, ctx] = makeCanvas(512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const img = new Image();
  img.onload = () => {
    const s = Math.min(512 / img.width, 512 / img.height);
    const w = img.width * s, h = img.height * s;
    const x = (512 - w) / 2, y = (512 - h) / 2;
    // black silhouette halo = sticker outline
    ctx.save();
    ctx.filter = 'brightness(0)';
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8)
      ctx.drawImage(img, x + Math.cos(a) * 7, y + Math.sin(a) * 7, w, h);
    ctx.restore();
    ctx.filter = 'saturate(1.35) contrast(1.08)';
    ctx.drawImage(img, x, y, w, h);
    ctx.filter = 'none';
    t.needsUpdate = true;
    // the first face also goes on the Photoshop canvas of every iMac
    if (name === 'face_maddy.png' && desktopCtx) {
      desktopCtx.drawImage(img, 196, 76, 120, 128);
      if (desktopTex) desktopTex.needsUpdate = true;
    }
  };
  img.src = './models/' + name;
  faceTexes.push(t);
}
const faceTex = faceTexes[0];

// the caterpillar wears its own face
const wormFaceTex = (() => {
  const [c, ctx] = makeCanvas(512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const img = new Image();
  img.onload = () => {
    const s = Math.min(512 / img.width, 512 / img.height);
    const w = img.width * s, h = img.height * s;
    const x = (512 - w) / 2, y = (512 - h) / 2;
    ctx.save();
    ctx.filter = 'brightness(0)';
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8)
      ctx.drawImage(img, x + Math.cos(a) * 7, y + Math.sin(a) * 7, w, h);
    ctx.restore();
    ctx.filter = 'saturate(1.35) contrast(1.08)';
    ctx.drawImage(img, x, y, w, h);
    ctx.filter = 'none';
    t.needsUpdate = true;
  };
  img.src = './models/face_tylah.png';
  return t;
})();


// ---------- shared materials ----------
const pineWallTex = pineTexture(1.0, 12);
const pineCeilTex = pineTexture(1.08, 14);
const floorTex = floorTexture();
const matBlackMetal = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.55, metalness: 0.7 });
const matGlass = new THREE.MeshStandardMaterial({ color: 0xa8c4cc, transparent: true, opacity: 0.18, roughness: 0.08, metalness: 0.4, side: THREE.DoubleSide });
const matLeather = new THREE.MeshStandardMaterial({ color: 0x4a2c1a, roughness: 0.42, metalness: 0.05 });
const matLeatherDark = new THREE.MeshStandardMaterial({ color: 0x3a2213, roughness: 0.5 });
const matDarkWood = new THREE.MeshStandardMaterial({ color: 0x4c3320, roughness: 0.6 });
const matWhite = new THREE.MeshStandardMaterial({ color: 0xf0efe9, roughness: 0.5 });
const matScreenOff = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.15, metalness: 0.4 });
const matScreenDesktop = new THREE.MeshBasicMaterial({ map: desktopTexture() });

function pineMat(repX, repY, tex = pineWallTex) {
  const t = tex.clone();
  t.needsUpdate = true;
  t.repeat.set(repX, repY);
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.82 });
}

// ---------- collision ----------
const colliders = [];   // {minX,maxX,minZ,maxZ,h} — h lets you jump over low furniture
// returns the box so callers can flip `off` later (a door that gets smashed open)
function addCollider(minX, maxX, minZ, maxZ, h = 0.95) {
  const b = { minX, maxX, minZ, maxZ, h, off: false };
  colliders.push(b);
  return b;
}
// y = feet height of the mover; anything above a box's height passes over it
function resolveCircle(pos, r, y = 0) {
  for (const b of colliders) {
    if (b.off || y >= b.h) continue;
    const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
    const dx = pos.x - cx, dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      const d = Math.sqrt(d2) || 0.001;
      pos.x = cx + (dx / d) * r;
      pos.z = cz + (dz / d) * r;
    }
  }
}
// height of the tallest box under a point — lets you stand on couches
function supportHeight(x, z, r = 0.3) {
  let best = 0;
  for (const b of colliders) {
    if (b.off) continue;
    if (x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r) best = Math.max(best, b.h);
  }
  return best;
}

// ============================================================
// ROOM BUILD
// ============================================================
const world = new THREE.Group();
scene.add(world);

function box(w, h, d, mat, x, y, z, ry = 0, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  m.castShadow = shadow; m.receiveShadow = true;
  world.add(m);
  return m;
}

// floor
{
  const t = floorTex.clone(); t.needsUpdate = true; t.repeat.set(3, 4);
  const f = new THREE.Mesh(new THREE.PlaneGeometry(12, 18), new THREE.MeshStandardMaterial({ map: t, roughness: 0.55 }));
  f.rotation.x = -Math.PI / 2;
  f.receiveShadow = true;
  world.add(f);
}

// ---- west wall (x=-6) with garage + entry openings ----
function westSegment(z0, z1) {
  const len = z1 - z0;
  box(0.24, ROOM.wallH, len, pineMat(len / 3, 1), -6, ROOM.wallH / 2, (z0 + z1) / 2);
}
westSegment(-9, DOOR_A.z0);
westSegment(DOOR_A.z1, -2.1);
westSegment(-0.1, DOOR_B.z0);
westSegment(DOOR_B.z1, 9);
// lintels above openings
box(0.24, ROOM.wallH - DOOR_A.h, DOOR_A.z1 - DOOR_A.z0, pineMat(1.5, 0.3), -6, DOOR_A.h + (ROOM.wallH - DOOR_A.h) / 2, (DOOR_A.z0 + DOOR_A.z1) / 2);
box(0.24, ROOM.wallH - DOOR_B.h, DOOR_B.z1 - DOOR_B.z0, pineMat(1.5, 0.3), -6, DOOR_B.h + (ROOM.wallH - DOOR_B.h) / 2, (DOOR_B.z0 + DOOR_B.z1) / 2);
box(0.24, ROOM.wallH - 2.15, 2.0, pineMat(0.8, 0.3), -6, 2.15 + (ROOM.wallH - 2.15) / 2, -1.1);   // above entry

// wall colliders (west segments; door gaps handled in movement code)
addCollider(-6.35, -5.85, -9.2, DOOR_A.z0, 9);
addCollider(-6.35, -5.85, DOOR_A.z1, DOOR_B.z0, 9);   // includes entry doors (closed)
addCollider(-6.35, -5.85, DOOR_B.z1, 9.2, 9);

// ---- east wall (x=6): real window + door openings, forest visible through glass ----
const EAST_WINS = [-7.2, -5.4, -3.6, 2.6, 4.4, 6.2, 8.0]
  .map(z => ({ z0: z - 0.475, z1: z + 0.475, y0: 1.35, y1: 2.4 }));
const EAST_DOOR = { z0: -0.8, z1: 1.1, y0: 0, y1: 2.1 };
// the rear (east) French doors swing open to let bosses in
const rearDoors = [];
let rearOpen = 0, rearTarget = 0;
// the staff-room door SpongeBob bursts out of on round 4
let staffDoor = null, staffTarget = 0;
// both back-room doors: three hits to smash open, then the room is yours
const sideDoors = [];
const SIDE_DOOR_HP = 3;
let crackStage = null;      // [light, heavy] damage decals, built with the doors
{
  const opens = [...EAST_WINS, EAST_DOOR].sort((a, b) => a.z0 - b.z0);
  let cur = -9;
  for (const o of opens) {
    if (o.z0 > cur + 0.01)
      box(0.24, ROOM.wallH, o.z0 - cur, pineMat((o.z0 - cur) / 3, 1), 6, ROOM.wallH / 2, (cur + o.z0) / 2);
    const mid = (o.z0 + o.z1) / 2, w = o.z1 - o.z0;
    if (o.y0 > 0) box(0.24, o.y0, w, pineMat(w / 3, 0.45), 6, o.y0 / 2, mid);
    if (o.y1 < ROOM.wallH)
      box(0.24, ROOM.wallH - o.y1, w, pineMat(w / 3, 0.3), 6, o.y1 + (ROOM.wallH - o.y1) / 2, mid);
    cur = o.z1;
  }
  if (cur < 9) box(0.24, ROOM.wallH, 9 - cur, pineMat((9 - cur) / 3, 1), 6, ROOM.wallH / 2, (cur + 9) / 2);
  // glass + white trim in each window opening
  for (const o of EAST_WINS) {
    const mid = (o.z0 + o.z1) / 2, w = o.z1 - o.z0, h = o.y1 - o.y0, yc = (o.y0 + o.y1) / 2;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), matGlass);
    glass.rotation.y = -Math.PI / 2;
    glass.position.set(6, yc, mid);
    world.add(glass);
    box(0.1, 0.08, w + 0.16, matWhite, 5.94, o.y1 + 0.04, mid, 0, false);
    box(0.1, 0.08, w + 0.16, matWhite, 5.94, o.y0 - 0.04, mid, 0, false);
    for (const dz of [-w / 2 - 0.04, w / 2 + 0.04])
      box(0.1, h + 0.16, 0.08, matWhite, 5.94, yc, mid + dz, 0, false);
  }
  // white French doors — hinged so they can swing open for the boss
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(5.95, 0, 0.15 + s * 0.92);      // hinge on the outer jamb
    const dz = -s * 0.45;                              // leaf hangs inward from the hinge
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.05, 0.9), matWhite);
    door.position.set(0, 1.025, dz);
    door.castShadow = true; pivot.add(door);
    const glz = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.55, 0.6), matGlass);
    glz.position.set(0, 1.25, dz); pivot.add(glz);
    const push = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.06), matBlackMetal);
    push.position.set(-0.06, 1.05, dz + s * 0.33); pivot.add(push);
    world.add(pivot);
    rearDoors.push({ pivot, s });
  }
  const doormat = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.1),
    new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 1 }));
  doormat.rotation.x = -Math.PI / 2; doormat.rotation.z = Math.PI / 2;
  doormat.position.set(5.25, 0.013, 0.15);
  world.add(doormat);
}
box(12, ROOM.wallH, 0.24, pineMat(4, 1), 0, ROOM.wallH / 2, -9);

// ---- south wall (z=9) with two real openings into the back rooms ----
const SOUTH_WINS = [
  { x0: -4.2, x1: -1.6, y0: 1.045, y1: 2.395 },
  { x0: -1.35, x1: -0.35, y0: 0, y1: 2.16 },     // staff room doorway
  { x0: 0.05, x1: 1.05, y0: 0, y1: 2.16 },       // gear room doorway
  { x0: 1.6, x1: 4.2, y0: 1.045, y1: 2.395 },
];
{
  let cur = -6;
  for (const o of SOUTH_WINS) {
    if (o.x0 > cur + 0.01)
      box(o.x0 - cur, ROOM.wallH, 0.24, pineMat((o.x0 - cur) / 3, 1), (cur + o.x0) / 2, ROOM.wallH / 2, 9);
    const w = o.x1 - o.x0, mid = (o.x0 + o.x1) / 2;
    if (o.y0 > 0.01) box(w, o.y0, 0.24, pineMat(w / 3, 0.4), mid, o.y0 / 2, 9);
    box(w, ROOM.wallH - o.y1, 0.24, pineMat(w / 3, 0.25), mid, o.y1 + (ROOM.wallH - o.y1) / 2, 9);
    cur = o.x1;
  }
  box(6 - cur, ROOM.wallH, 0.24, pineMat((6 - cur) / 3, 1), (cur + 6) / 2, ROOM.wallH / 2, 9);
}
// east wall, split around the French doors so you can step out onto the porch
addCollider(5.85, 6.35, -9.2, EAST_DOOR.z0, 9);
addCollider(5.85, 6.35, EAST_DOOR.z1, 9.2, 9);
addCollider(-6.2, 6.2, -9.35, -8.85, 9);
// South wall, split around both back-room doorways. The staff gap stays clear
// so SpongeBob can charge through it; the gear gap is plugged until you smash
// that door open (see SIDE_ROOMS).
addCollider(-6.2, -1.35, 8.85, 9.35, 9);
addCollider(-0.35, 0.05, 8.85, 9.35, 9);
const gearGapCollider = addCollider(0.05, 1.05, 8.85, 9.35, 9);
addCollider(1.05, 6.2, 8.85, 9.35, 9);

// ---- the two back rooms you can break into ----
// Doorway x-ranges match the SOUTH_WINS openings; the room bounds match what
// backRoom() builds behind the wall. `open` gates the player's z clamp.
const SIDE_ROOMS = {
  // x0/x1 sit slightly OUTSIDE the wall colliders on purpose: the clamp runs
  // before resolveCircle, so if the two disagreed a fast frame could get
  // yanked back through the wall instead of pushed off it.
  staff: { label: 'STAFF ROOM', cx: -2.9, gap0: -1.35, gap1: -0.35,
           x0: -5.95, x1: 0.06, zFar: 12.35, open: false, gapCollider: null },
  gear:  { label: 'GEAR ROOM',  cx:  2.9, gap0:  0.05, gap1:  1.05,
           x0: -0.06, x1: 5.95, zFar: 12.35, open: false, gapCollider: gearGapCollider },
};
function anySideRoomOpen() {
  return SIDE_ROOMS.staff.open || SIDE_ROOMS.gear.open;
}
// which room, if any, the player is allowed to be standing in at this x/z
function openSideRoomAt(x, z) {
  for (const r of [SIDE_ROOMS.staff, SIDE_ROOMS.gear]) {
    if (!r.open) continue;
    if (z < 9.4) { if (x > r.gap0 && x < r.gap1) return r; }
    else if (x > r.x0 && x < r.x1) return r;
  }
  return null;
}

// ---- flat pine ceiling, boards running along the long (z) axis ----
{
  const t = pineCeilTex.clone(); t.needsUpdate = true;
  t.center.set(0.5, 0.5);
  t.rotation = Math.PI / 2;
  t.repeat.set(7, 3);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(12.2, 18.2),
    new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = ROOM.wallH;
  ceil.receiveShadow = true;
  world.add(ceil);
}

// ---- entry double doors (west wall, between garage doors) ----
{
  const g = new THREE.Group();
  for (const s of [-1, 1]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.1, 0.86), matWhite);
    door.position.set(0, 1.05, s * 0.45);
    door.castShadow = true;
    g.add(door);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.3, 0.5), matGlass);
    glass.position.set(0, 1.25, s * 0.45);
    g.add(glass);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.06), matBlackMetal);
    handle.position.set(0.05, 1.0, s * 0.12);
    g.add(handle);
  }
  g.position.set(-5.95, 0, -1.1);
  world.add(g);
  // small windows flanking entry
  const wv = windowViewTexture();
  for (const z of [-2.65, 0.55]) {
    const frame = box(0.1, 1.0, 1.0, matWhite, -5.9, 1.6, z);
    const view = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.84),
      new THREE.MeshBasicMaterial({ map: wv }));
    view.rotation.y = Math.PI / 2;
    view.position.set(-5.83, 1.6, z);
    world.add(view);
  }
}

// ---- fake windows on E/N/S walls (bright view planes with pine trim) ----
const winView = windowViewTexture();
function fakeWindow(x, y, z, w, h, ry) {
  const grp = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.08), pineMat(0.5, 0.3));
  const view = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: winView }));
  view.position.z = 0.05;
  grp.add(frame, view);
  grp.position.set(x, y, z);
  grp.rotation.y = ry;
  world.add(grp);
}
// north wall windows (either side of green screen)
for (const x of [3.1, 4.6]) fakeWindow(x, 1.95, -8.86, 0.95, 0.9, Math.PI);

// ---- south wall: STAFF ROOM + GEAR ROOM (two giant interior windows, two pine doors) ----
{
  // clear interior windows looking into two small knotty-pine back rooms
  function interiorWindow(x, w, h) {
    const yc = 1.72;
    // border bars only, so the opening stays see-through
    for (const dy of [-h / 2 - 0.05, h / 2 + 0.05]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.1, 0.16), matBlackMetal);
      bar.position.set(x, yc + dy, 8.98);
      world.add(bar);
    }
    for (const dx of [-w / 2 - 0.05, w / 2 + 0.05]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, h + 0.2, 0.16), matBlackMetal);
      bar.position.set(x + dx, yc, 8.98);
      world.add(bar);
    }
    // faint glass pane
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({
        color: 0xdfeaf0, transparent: true, opacity: 0.07,
        roughness: 0.05, metalness: 0.2, side: THREE.DoubleSide,
      }));
    glass.position.set(x, yc, 8.97);
    world.add(glass);
    // mullions splitting it into panes
    for (const f of [-1, 1]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.1), matBlackMetal);
      bar.position.set(x + f * w / 6, yc, 8.97);
      world.add(bar);
    }
  }
  interiorWindow(-2.9, 2.6, 1.35);
  interiorWindow(2.9, 2.6, 1.35);


  // knotty pine 6-panel doors
  const doorMat = new THREE.MeshStandardMaterial({ color: 0xc99e5f, roughness: 0.7 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0xb98c4e, roughness: 0.75 });

  // Splintering damage decal: jagged branches out of an impact point, drawn
  // dark with a pale highlight so it reads as broken wood at any distance.
  function crackTexture(stage) {
    const [c, x] = makeCanvas(256, 512);
    x.clearRect(0, 0, 256, 512);
    x.lineCap = 'round';
    const hits = stage === 1 ? 1 : 3;
    for (let h = 0; h < hits; h++) {
      const ox = 128 + rnd(-52, 52), oy = 250 + rnd(-90, 90);
      const arms = stage === 1 ? 5 : 8;
      for (let a = 0; a < arms; a++) {
        let px = ox, py = oy;
        let ang = (a / arms) * Math.PI * 2 + rnd(-0.4, 0.4);
        let w = stage === 1 ? 2.6 : 4.4;
        const segs = stage === 1 ? 4 : 7;
        x.beginPath();
        x.moveTo(px, py);
        for (let s = 0; s < segs; s++) {
          ang += rnd(-0.5, 0.5);
          const len = rnd(14, 34) * (stage === 1 ? 0.8 : 1.15);
          px += Math.cos(ang) * len; py += Math.sin(ang) * len;
          x.lineTo(px, py);
        }
        x.strokeStyle = 'rgba(24,14,6,0.92)'; x.lineWidth = w; x.stroke();
        x.strokeStyle = 'rgba(232,206,164,0.5)'; x.lineWidth = w * 0.35; x.stroke();
      }
      // a blown-out hole once it's really taken a beating
      if (stage === 2) {
        x.beginPath();
        for (let a = 0; a < 12; a++) {
          const r = rnd(9, 20), t = (a / 12) * Math.PI * 2;
          const fx = ox + Math.cos(t) * r, fy = oy + Math.sin(t) * r;
          a ? x.lineTo(fx, fy) : x.moveTo(fx, fy);
        }
        x.closePath();
        x.fillStyle = 'rgba(12,8,4,0.85)'; x.fill();
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = ANISO;
    return t;
  }
  crackStage = [crackTexture(1), crackTexture(2)];

  function pineDoor(x, hingeSide) {
    // casing only — jambs and a head, so the opening stays see-through
    for (const dx of [-0.53, 0.53]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.16, 0.16), doorMat);
      jamb.position.set(x + dx, 1.08, 8.865);
      world.add(jamb);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.1, 0.16), doorMat);
    head.position.set(x, 2.16, 8.865);
    world.add(head);

    const pivot = new THREE.Group();
    pivot.position.set(x + hingeSide * 0.475, 0, 8.82);
    const g = new THREE.Group();
    g.position.x = -hingeSide * 0.475;          // leaf hangs off the hinge
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.05, 0.07), doorMat);
    slab.position.y = 1.025; slab.castShadow = true; g.add(slab);
    for (const py of [0.45, 1.05, 1.65]) {
      for (const px of [-0.22, 0.22]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.48, 0.03), panelMat);
        panel.position.set(px, py, -0.035);
        g.add(panel);
      }
    }
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 10), matBlackMetal);
    knob.position.set(-hingeSide * 0.36, 1.02, -0.07); g.add(knob);

    // Damage decals sit a hair proud of each face of the slab, hidden until
    // the door starts taking hits.
    const cracks = [];
    for (const face of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 2.05),
        new THREE.MeshBasicMaterial({ map: crackStage[0], transparent: true,
                                      opacity: 0, depthWrite: false }));
      m.position.set(0, 1.025, face * 0.038);
      if (face < 0) m.rotation.y = Math.PI;
      m.visible = false;
      g.add(m);
      cracks.push(m);
    }

    pivot.add(g);
    world.add(pivot);
    const d = {
      pivot, s: hingeSide, leaf: g, slab, cracks,
      hit: new THREE.Vector3(x, 1.05, 8.82),   // what the weapons aim at
      hp: SIDE_DOOR_HP, broken: false, open: 0, room: null,
    };
    sideDoors.push(d);
    return d;
  }
  staffDoor = pineDoor(-0.85, -1);    // the one nearest the staff room
  staffDoor.room = SIDE_ROOMS.staff;
  pineDoor(0.55, 1).room = SIDE_ROOMS.gear;

  sign('STAFF ROOM', -2.9, 2.62, 8.84, Math.PI, 0.85);
  sign('GEAR ROOM', 2.9, 2.62, 8.84, Math.PI, 0.85);
}

// ---- ransom-note letter signs ----
function sign(text, x, y, z, ry, scale = 1) {
  const t = lettersTexture(text);
  const w = text.length * 0.22 * scale;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.34 * scale),
    new THREE.MeshBasicMaterial({ map: t, transparent: true }));
  m.position.set(x, y, z);
  m.rotation.y = ry;
  world.add(m);
}
sign('WELCOME TO DIGI!', -5.86, 2.5, -1.1, Math.PI / 2, 1.1);
sign('VIEWING LOUNGE', 5.86, 2.65, -5.2, -Math.PI / 2);
sign('COMPUTER LAB', 5.86, 2.65, 5.0, -Math.PI / 2);
sign('THE GREEN SCREEN', -2.0, 2.72, -8.85, 0, 0.9);

// exit signs (red glow)
function exitSign(x, y, z, ry) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.07),
    new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2211, emissiveIntensity: 1.6 }));
  m.position.set(x, y, z); m.rotation.y = ry;
  world.add(m);
}
exitSign(-5.8, 2.85, -1.1, Math.PI / 2);
exitSign(5.8, 2.45, 0.15, -Math.PI / 2);

// acoustic foam squares high on east wall
for (const z of [-6.6, -5.8, -2.8, -2.0]) {
  box(0.06, 0.5, 0.5, new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.95 }), 5.9, 2.72, z);
}

// bulletin board (east wall, right of the doors like the photo)
{
  box(0.05, 0.9, 1.3, new THREE.MeshStandardMaterial({ color: 0xb08a56, roughness: 0.9 }), 5.9, 1.75, 1.75);
  const [pc, pctx] = makeCanvas(128, 96);
  pctx.fillStyle = '#c9a165'; pctx.fillRect(0, 0, 128, 96);
  for (let i = 0; i < 6; i++) {
    pctx.fillStyle = ['#fff', '#cfe3f7', '#f7e9cf'][i % 3];
    pctx.fillRect(rnd(6, 90), rnd(6, 60), rnd(18, 30), rnd(20, 30));
  }
  const t = new THREE.CanvasTexture(pc); t.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.24, 0.84), new THREE.MeshBasicMaterial({ map: t }));
  face.rotation.y = -Math.PI / 2; face.position.set(5.87, 1.75, 1.75);
  world.add(face);
}

// ============================================================
// GARAGE DOORS (glass-paneled, slide up & tilt like sectionals)
// ============================================================
const garageDoors = [];
function buildGarageDoor(def) {
  const width = def.z1 - def.z0, height = def.h;
  const zc = (def.z0 + def.z1) / 2;
  const grp = new THREE.Group();
  grp.position.set(-6, 0, zc);
  world.add(grp);
  // 4 hinged sections that ride the track up and onto the ceiling like a real sectional door
  const rows = 4, secH = height / rows;
  const hingeMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.9, roughness: 0.3 });
  const sections = [];
  for (let r = 0; r < rows; r++) {
    const sec = new THREE.Group();
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.03, secH - 0.05, width - 0.06), matGlass);
    sec.add(glass);
    for (const sy of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, width), matBlackMetal);
      rail.position.y = sy * (secH / 2 - 0.035);
      sec.add(rail);
    }
    for (let cIdx = 0; cIdx <= 4; cIdx++) {
      const stile = new THREE.Mesh(new THREE.BoxGeometry(0.08, secH, 0.07), matBlackMetal);
      stile.position.z = -width / 2 + (cIdx / 4) * width;
      sec.add(stile);
      if (r > 0) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.12), hingeMat);
        h.position.set(0.03, secH / 2 - 0.02, -width / 2 + (cIdx / 4) * width);
        sec.add(h);
      }
    }
    sec.position.y = (r + 0.5) * secH;
    grp.add(sec);
    sections.push({ sec, s0: (r + 0.5) * secH });
  }

  // fixed curved track rails + spring bar (visual, like the photos)
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.85, roughness: 0.35 });
  for (const s of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.05, 0.08), railMat);
    rail.position.set(-4.4, height + 0.25, zc + s * (width / 2 + 0.06));
    world.add(rail);
    const curve = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.03, 6, 10, Math.PI / 2), railMat);
    curve.position.set(-5.75, height - 0.1, zc + s * (width / 2 + 0.06));
    curve.rotation.z = Math.PI / 2;
    world.add(curve);
  }
  const spring = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, width * 0.8, 8), railMat);
  spring.rotation.x = Math.PI / 2;
  spring.position.set(-5.8, height + 0.32, zc);
  world.add(spring);

  const d = { def, grp, sections, height, open: 0, target: 0, zc, width };
  garageDoors.push(d);
  return d;
}
const doorA = buildGarageDoor(DOOR_A);
const doorB = buildGarageDoor(DOOR_B);

function doorBlocks(z) {   // is west wall passable at this z?
  for (const d of garageDoors) {
    if (z > d.def.z0 + 0.3 && z < d.def.z1 - 0.3 && d.open > 0.75) return false;
  }
  return true;
}

// ============================================================
// GREEN SCREEN + studio gear (north wall)
// ============================================================
let greenScreenMesh = null;
{
  // mounting bar + chain
  box(3.6, 0.06, 0.06, matBlackMetal, -2, 2.72, -8.7);
  const gs = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 2.45),
    new THREE.MeshStandardMaterial({ map: greenScreenTexture(), roughness: 0.9, side: THREE.DoubleSide }));
  gs.position.set(-2, 1.48, -8.66);
  gs.receiveShadow = true;
  world.add(gs);
  greenScreenMesh = gs;
  addCollider(-3.7, -0.3, -8.9, -8.55, 9);

  // softbox lights on tripods
  function studioLight(x, z, ry) {
    const g = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.25, 6), matBlackMetal);
      const a = (i / 3) * Math.PI * 2;
      leg.position.set(Math.cos(a) * 0.22, 0.6, Math.sin(a) * 0.22);
      leg.rotation.z = Math.cos(a) * 0.3;
      leg.rotation.x = -Math.sin(a) * 0.3;
      g.add(leg);
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.7, 6), matBlackMetal);
    pole.position.y = 0.85; g.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.12), matBlackMetal);
    head.position.set(0, 1.72, 0.05); g.add(head);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6e0, emissiveIntensity: 0.9 }));
    panel.position.set(0, 1.72, 0.115); g.add(panel);
    g.position.set(x, 0, z); g.rotation.y = ry;
    world.add(g);
    addCollider(x - 0.3, x + 0.3, z - 0.3, z + 0.3);
  }
  studioLight(-4.1, -7.4, 0.7);
  studioLight(0.2, -7.4, -0.7);

  // RGB pole light (glowing gradient stick from the photos)
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 8),
    new THREE.MeshStandardMaterial({ color: 0x222233, emissive: 0x22ddcc, emissiveIntensity: 1.4 }));
  pole.position.set(-0.6, 0.95, -6.6);
  world.add(pole);
  const poleBase = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.06, 10), matBlackMetal);
  poleBase.position.set(-0.6, 0.03, -6.6);
  world.add(poleBase);

  // folding table + chairs near green screen
  box(2.0, 0.06, 0.8, matDarkWood, 1.6, 0.74, -7.7);
  for (const dx of [-0.7, 0.7]) box(0.05, 0.72, 0.05, matBlackMetal, 1.6 + dx, 0.37, -7.7);
  addCollider(0.5, 2.7, -8.2, -7.2);
}

// ============================================================
// FURNITURE — desks, iMacs, chairs, couches, rugs, TVs, tables
// ============================================================
const macSpots = [];   // world positions of every iMac, for the mystery-box prompt
const macs = [];       // every iMac, so they can be shot to bits
function iMac(x, y, z, ry, register = true) {
  if (register) macSpots.push({ x, z });
  const g = new THREE.Group();
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.02), matWhite);
  screen.position.y = 0.34; g.add(screen);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.26), matScreenDesktop);
  face.position.set(0, 0.36, 0.012); g.add(face);
  const chin = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xe8e8ea, roughness: 0.4, metalness: 0.6 }));
  chin.position.set(0, 0.2, 0.012); g.add(chin);
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.02), matWhite);
  stand.position.set(0, 0.08, -0.03); stand.rotation.x = 0.15; g.add(stand);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.015, 0.16), matWhite);
  foot.position.set(0, 0.008, -0.02); g.add(foot);
  const kb = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.012, 0.11), matWhite);
  kb.position.set(0, 0.006, 0.18); g.add(kb);
  const mouse = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.015, 0.09), matWhite);
  mouse.position.set(0.2, 0.008, 0.18); g.add(mouse);
  g.position.set(x, y, z); g.rotation.y = ry;
  world.add(g);
  // shootable: the screen is the hitbox, roughly eye height on the desk
  macs.push({
    g, face, screen, chin,
    hit: new THREE.Vector3(x, y + 0.35, z),
    hp: 1, broken: false, potion: false, smokeT: 0,   // one hit and the screen goes
  });
}
function chair(x, z, ry) {
  const g = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.4), matLeatherDark);
  seat.position.y = 0.45; seat.castShadow = true; g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.05), matLeatherDark);
  back.position.set(0, 0.72, -0.19); back.rotation.x = -0.12; back.castShadow = true; g.add(back);
  for (const [dx, dz] of [[-0.17, -0.16], [0.17, -0.16], [-0.17, 0.16], [0.17, 0.16]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.45, 6), matBlackMetal);
    leg.position.set(dx, 0.22, dz); g.add(leg);
  }
  g.position.set(x, 0, z); g.rotation.y = ry;
  world.add(g);
}
function deskRun(x, z, len, ry, nMacs) {
  // dark wood desk with black legs against a wall; ry = facing
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.66), matDarkWood);
  top.position.y = 0.75; top.castShadow = top.receiveShadow = true; g.add(top);
  for (const dx of [-len / 2 + 0.1, len / 2 - 0.1]) {
    for (const dz of [-0.28, 0.28]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.75, 0.05), matBlackMetal);
      leg.position.set(dx, 0.375, dz); g.add(leg);
    }
  }
  g.position.set(x, 0, z); g.rotation.y = ry;
  world.add(g);
  // macs on top + chairs in front
  for (let i = 0; i < nMacs; i++) {
    const t = (i + 0.5) / nMacs - 0.5;
    const lx = t * len;
    const wx = x + Math.cos(ry) * lx, wz = z - Math.sin(ry) * lx;
    const mx = wx + Math.sin(ry) * -0.1, mz = wz + Math.cos(ry) * -0.1;
    iMac(mx, 0.775, mz, ry + Math.PI);
    chair(wx + Math.sin(ry) * 0.55, wz + Math.cos(ry) * 0.55, ry + Math.PI);
  }
  // collider
  const hw = len / 2, hd = 0.4;
  const cs = Math.abs(Math.cos(ry)) > 0.5;
  if (cs) addCollider(x - hw, x + hw, z - hd, z + hd);
  else addCollider(x - hd, x + hd, z - hw, z + hw);
}

// NE computer lab (floor plan: "Dining Room 2" desks along east wall + north)
deskRun(5.5, -5.0, 6.4, Math.PI / 2, 5);        // along east wall, facing west
deskRun(3.9, -8.5, 3.4, Math.PI, 3);            // along north wall east end, facing south
// SE computer lab desks
deskRun(5.5, 5.6, 5.2, Math.PI / 2, 4);         // east wall south, facing west
deskRun(2.9, 8.35, 2.6, 0, 3);                  // under the gear room window, like the photo

// chesterfield couch
function couch(x, z, ry, seats = 2) {
  const g = new THREE.Group();
  const w = seats === 2 ? 1.9 : 2.5;
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, 0.95), matLeather);
  base.position.y = 0.3; base.castShadow = true; g.add(base);
  const back = new THREE.Mesh(new THREE.BoxGeometry(w, 0.55, 0.24), matLeather);
  back.position.set(0, 0.72, -0.37); back.castShadow = true; g.add(back);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.9, 10), matLeather);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(s * (w / 2 - 0.02), 0.62, 0.02);
    arm.castShadow = true; g.add(arm);
  }
  for (let i = 0; i < seats; i++) {
    const cush = new THREE.Mesh(new THREE.BoxGeometry(w / seats - 0.12, 0.14, 0.72), matLeatherDark);
    cush.position.set((i + 0.5) / seats * w - w / 2, 0.56, 0.06);
    g.add(cush);
  }
  // pillow
  const pil = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.36, 0.14),
    new THREE.MeshStandardMaterial({ color: 0xd9cbb2, roughness: 0.9 }));
  pil.position.set(-w / 2 + 0.34, 0.72, -0.22); pil.rotation.z = 0.1; g.add(pil);
  g.position.set(x, 0, z); g.rotation.y = ry;
  world.add(g);
  const r = Math.max(w, 1.0) / 2 + 0.1;
  addCollider(x - r, x + r, z - 0.65, z + 0.65);
}
function armchair(x, z, ry) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.42, 0.9), matLeather);
  base.position.y = 0.3; base.castShadow = true; g.add(base);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 0.22), matLeather);
  back.position.set(0, 0.7, -0.34); g.add(back);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.85, 10), matLeather);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(s * 0.47, 0.6, 0.0);
    g.add(arm);
  }
  g.position.set(x, 0, z); g.rotation.y = ry;
  world.add(g);
  addCollider(x - 0.55, x + 0.55, z - 0.55, z + 0.55);
}
function coffeeTable(x, z, ry = 0) {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.05, 0.6), matDarkWood);
  top.position.y = 0.42; top.castShadow = true; g.add(top);
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.5), matDarkWood);
  shelf.position.y = 0.12; g.add(shelf);
  for (const [dx, dz] of [[-0.5, -0.25], [0.5, -0.25], [-0.5, 0.25], [0.5, 0.25]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.05), matDarkWood);
    leg.position.set(dx, 0.21, dz); g.add(leg);
  }
  g.position.set(x, 0, z); g.rotation.y = ry;
  world.add(g);
  addCollider(x - 0.6, x + 0.6, z - 0.35, z + 0.35);
}
function rug(x, z, w, l, ry = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l),
    new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 0.95 }));
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = ry;
  m.position.set(x, 0.012, z);
  m.receiveShadow = true;
  world.add(m);
}

// central viewing cluster (facing green screen / north TV) — like the photos
rug(0.2, -2.2, 3.4, 4.6);
couch(-0.6, -0.9, Math.PI, 3);        // facing north
couch(1.0, -3.4, 0, 3);               // facing south (pair facing each other)
couch(-2.2, -2.2, Math.PI / 2, 2);    // facing east
coffeeTable(0.2, -2.15);

// east viewing lounge (facing east wall TV)
rug(3.4, 1.0, 2.6, 3.4, Math.PI / 2);
couch(2.4, 1.0, -Math.PI / 2, 2);     // facing east TV? face west->no, face east
armchair(3.6, 2.6, -0.5);

// SW lounge (floor plan bottom-left couches + armchairs)
rug(-3.2, 6.0, 3.0, 3.8);
couch(-3.6, 7.3, Math.PI, 2);
armchair(-4.5, 5.0, 0.6);
armchair(-2.2, 4.8, -0.6);
coffeeTable(-3.3, 6.0);

// ---- the east TV plays a looping clip ----
// Autoplay only works muted, and on some browsers only after the first user
// gesture, so the start click gives it a nudge too. On LOW the clip is skipped
// altogether: decoding it and re-uploading a fresh frame to the GPU every tick
// costs more than a small screen in the corner is worth.
let tvVideo = null, tvTexture = null;
let matScreenVideo = matScreenOff;
if (TIER.video) {
  tvVideo = document.createElement('video');
  tvVideo.src = './video/loopvideo.mp4';
  tvVideo.loop = true;
  tvVideo.muted = true;
  tvVideo.playsInline = true;
  tvVideo.autoplay = true;
  tvVideo.crossOrigin = 'anonymous';
  tvVideo.play().catch(() => {});
  tvTexture = new THREE.VideoTexture(tvVideo);
  tvTexture.colorSpace = THREE.SRGBColorSpace;
  tvTexture.minFilter = THREE.LinearFilter;
  tvTexture.magFilter = THREE.LinearFilter;
  matScreenVideo = new THREE.MeshBasicMaterial({ map: tvTexture, toneMapped: false });
}

// wall TVs
function wallTV(x, y, z, ry, w = 1.7, h = 0.95, mat = matScreenOff) {
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, h + 0.06, 0.06), matBlackMetal);
  frame.position.set(x, y, z); frame.rotation.y = ry;
  world.add(frame);
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  scr.position.set(x + Math.sin(ry) * 0.045, y, z + Math.cos(ry) * 0.045);
  scr.rotation.y = ry;
  world.add(scr);
  return scr;
}
wallTV(1.6, 1.85, -8.82, 0);            // north wall, east of green screen
// east wall, left of the French doors — this is the one running the loop
const eastTV = wallTV(5.9, 1.75, -1.9, -Math.PI / 2, 1.7, 0.95, matScreenVideo);
// a soft glow off the screen so it actually lights the lounge
const tvGlow = new THREE.PointLight(0x9fc4ff, 2.2, 5.5, 1.8);
tvGlow.position.set(5.5, 1.75, -1.9);
world.add(tvGlow);
// media console + speaker under the TV (like the photo)
box(0.55, 0.35, 0.9, matDarkWood, 5.55, 0.2, -1.9);
box(0.3, 0.34, 0.35, new THREE.MeshStandardMaterial({ color: 0x101014, roughness: 0.7 }), 5.55, 0.56, -1.9);

// ceiling fans
const fans = [];
function fan(x, z) {
  const g = new THREE.Group();
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), matBlackMetal);
  rod.position.y = 0.25; g.add(rod);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.12, 12), matBlackMetal);
  hub.position.y = 0; g.add(hub);
  const blades = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.015, 0.14), matBlackMetal);
    b.position.x = 0.45;
    const holder = new THREE.Group();
    holder.rotation.y = (i / 3) * Math.PI * 2;
    b.rotation.z = 0.08;
    holder.add(b);
    blades.add(holder);
  }
  blades.position.y = -0.04;
  g.add(blades);
  g.position.set(x, 2.78, z);
  world.add(g);
  fans.push(blades);
}
fan(0, -4.2);
fan(0, 0.6);
fan(0, 5.0);

// recessed can lights (emissive discs) + warm point lights
const canMat = new THREE.MeshStandardMaterial({ color: 0xffe9c4, emissive: 0xffd9a0, emissiveIntensity: 4.5 });
for (const x of [-3.6, 3.6]) {
  for (const z of [-7, -3.5, 0, 3.5, 7]) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.11, 12), canMat);
    disc.position.set(x, ROOM.wallH - 0.02, z);
    disc.rotation.x = Math.PI / 2;
    world.add(disc);
  }
}

// ---- the two knotty-pine back rooms visible through the south windows ----
function backRoom(cx, label) {
  const z0 = 9.12, z1 = 12.6, hw = 2.9, H = 2.75;
  const ft = floorTex.clone(); ft.needsUpdate = true; ft.repeat.set(1.4, 1.4);
  const fl = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, z1 - z0),
    new THREE.MeshStandardMaterial({ map: ft, roughness: 0.6 }));
  fl.rotation.x = -Math.PI / 2;
  fl.position.set(cx, 0.01, (z0 + z1) / 2);
  fl.receiveShadow = true; world.add(fl);

  const ceilT = pineCeilTex.clone(); ceilT.needsUpdate = true; ceilT.repeat.set(2, 2);
  const ce = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, z1 - z0),
    new THREE.MeshStandardMaterial({ map: ceilT, roughness: 0.85 }));
  ce.rotation.x = Math.PI / 2;
  ce.position.set(cx, H, (z0 + z1) / 2);
  world.add(ce);

  const mkWall = (w, d, x, z) => {
    const t = pineWallTex.clone(); t.needsUpdate = true;
    t.repeat.set(Math.max(w, d) / 2.5, 0.9);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, H, d),
      new THREE.MeshStandardMaterial({ map: t, roughness: 0.82 }));
    m.position.set(x, H / 2, z);
    m.receiveShadow = true; world.add(m);
  };
  mkWall(hw * 2 + 0.3, 0.15, cx, z1);
  mkWall(0.15, z1 - z0, cx - hw, (z0 + z1) / 2);
  mkWall(0.15, z1 - z0, cx + hw, (z0 + z1) / 2);
  // Now that you can walk in here, the walls need to be solid. They start a
  // little past the doorway so they never register as something to stand on
  // while you're still in the opening.
  addCollider(cx - hw - 0.12, cx - hw + 0.12, 9.25, z1 + 0.2, 9);
  addCollider(cx + hw - 0.12, cx + hw + 0.12, 9.25, z1 + 0.2, 9);
  addCollider(cx - hw, cx + hw, z1 - 0.12, z1 + 0.2, 9);
  // the iMac desk along the back wall
  addCollider(cx - 1.85, cx + 1.85, z1 - 0.9, z1 - 0.2, 0.78);

  // desk of iMacs facing the window so you see the screens from the main room
  const top = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.05, 0.62), matDarkWood);
  top.position.set(cx, 0.75, z1 - 0.55);
  top.castShadow = true; world.add(top);
  for (const dx of [-1.7, 1.7]) for (const dz of [-0.25, 0.25]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.75, 0.05), matBlackMetal);
    leg.position.set(cx + dx, 0.375, z1 - 0.55 + dz);
    world.add(leg);
  }
  for (let i = -1; i <= 1; i++) {
    iMac(cx + i * 1.15, 0.775, z1 - 0.68, Math.PI, false);
    chair(cx + i * 1.15, z1 - 1.3, Math.PI);
  }

  const lamp = new THREE.PointLight(0xffd9a8, 5.5, 9, 1.5);
  lamp.position.set(cx, H - 0.3, (z0 + z1) / 2 + 0.4);
  scene.add(lamp);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.13, 12), canMat);
  disc.rotation.x = Math.PI / 2;
  disc.position.set(cx, H - 0.03, (z0 + z1) / 2 + 0.4);
  world.add(disc);
  sign(label, cx, 2.4, z1 - 0.12, Math.PI, 0.8);
}
backRoom(-2.9, 'STAFF ROOM');
backRoom(2.9, 'GEAR ROOM');

// ============================================================
// TREASURE CHEST — the payoff for breaking into the gear room
// ============================================================
// Sits in the room on your left as you face the back-room doors. Walk up to it
// and the lid swings open and a shield potion pops out onto the floor, which
// you still have to step on. It re-arms at the top of every round, so the trip
// stays worth making — but it is a trip away from the fight to make it.
const chest = (() => {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4326, roughness: 0.72 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.34, metalness: 0.85 });

  const W = 0.72, D = 0.46, H = 0.34;
  const base = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), wood);
  base.position.y = H / 2; base.castShadow = true; base.receiveShadow = true; g.add(base);
  for (const dx of [-W / 2 + 0.05, 0, W / 2 - 0.05]) {          // iron straps
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, H + 0.01, D + 0.012), trim);
    s.position.set(dx, H / 2, 0); g.add(s);
  }

  // lid on a hinge along the back edge
  const lid = new THREE.Group();
  lid.position.set(0, H, -D / 2);
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(D / 2, D / 2, W, 14, 1, false, 0, Math.PI), wood);
  dome.rotation.z = Math.PI / 2;
  dome.position.set(0, 0, D / 2);
  dome.castShadow = true;
  lid.add(dome);
  for (const dx of [-W / 2 + 0.05, 0, W / 2 - 0.05]) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(D / 2 + 0.008, D / 2 + 0.008, 0.05, 14, 1, false, 0, Math.PI), trim);
    s.rotation.z = Math.PI / 2;
    s.position.set(dx, 0, D / 2);
    lid.add(s);
  }
  g.add(lid);

  const latch = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.13, 0.04), trim);
  latch.position.set(0, H - 0.03, D / 2 + 0.005); g.add(latch);

  // the glow that spills out once it's open
  const glow = new THREE.PointLight(0x8fe4ff, 0, 2.6, 1.8);
  glow.position.set(0, H + 0.15, 0);
  g.add(glow);

  const R = SIDE_ROOMS.gear;
  g.position.set(R.cx + 0.1, 0, 10.35);
  g.rotation.y = Math.PI;                    // faces the doorway you came in by
  world.add(g);
  addCollider(g.position.x - W / 2 - 0.06, g.position.x + W / 2 + 0.06,
              g.position.z - D / 2 - 0.06, g.position.z + D / 2 + 0.06, H + 0.02);
  return { g, lid, latch, glow, armed: true, lidT: 0, opening: false };
})();

// re-stocked at the top of each round, so the room stays worth the detour
function armChest() {
  chest.armed = true;
  chest.opening = false;
  chest.latch.visible = true;
}

function updateChest(dt) {
  // pop open when you get close enough to reach it
  if (chest.armed && !chest.opening && SIDE_ROOMS.gear.open) {
    const d = Math.hypot(player.pos.x - chest.g.position.x, player.pos.z - chest.g.position.z);
    if (d < 1.35) {
      chest.opening = true;
      chest.armed = false;
      chest.latch.visible = false;
      sfxRound();
      spawnSparks(chest.g.position.clone().setY(0.5), 0x8fe4ff, 20, 1.2);
      // out of the mouth toward the doorway, so it lands on open floor in here
      const out = chest.g.position.clone();
      out.z -= 0.5;
      out.y = 0.55;
      spawnDrop('shield', out);
    }
  }
  if (chest.opening && chest.lidT < 1) {
    chest.lidT = Math.min(1, chest.lidT + dt * 2.6);
    // ease out so it flops open and settles
    const k = 1 - Math.pow(1 - chest.lidT, 3);
    chest.lid.rotation.x = -k * 1.95;
    chest.glow.intensity = 5 * k;
  } else if (!chest.opening && chest.lidT > 0) {
    chest.lidT = Math.max(0, chest.lidT - dt * 3);
    chest.lid.rotation.x = -chest.lidT * 1.95;
    chest.glow.intensity = 5 * chest.lidT;
  }
}

// ---- animated sponge guy pacing around the staff room ----
function spongeTexture() {
  const [c, ctx] = makeCanvas(256, 256);
  ctx.fillStyle = '#f5e04a'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 90; i++) {
    const x = rnd(8, 248), y = rnd(8, 248), r = rnd(5, 17);
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, 'rgba(150,120,20,0.85)');
    g.addColorStop(0.7, 'rgba(196,166,40,0.45)');
    g.addColorStop(1, 'rgba(245,224,74,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * rnd(0.7, 1.2), rnd(0, 3), 0, 7); ctx.fill();
  }
  for (let i = 0; i < 1200; i++) {
    ctx.fillStyle = `rgba(${rnd(200, 250) | 0},${rnd(180, 220) | 0},60,0.25)`;
    ctx.fillRect(rnd(0, 256), rnd(0, 256), 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let sponge = null, spongeGltf = null;
function buildSponge(x, z) {
  const g = new THREE.Group();
  const rig = new THREE.Group();
  g.add(rig);
  const skin = new THREE.MeshStandardMaterial({ map: spongeTexture(), roughness: 0.95 });
  const white = new THREE.MeshStandardMaterial({ color: 0xfbfbf5, roughness: 0.7 });
  const brown = new THREE.MeshStandardMaterial({ color: 0x9a6b2f, roughness: 0.85 });
  const red = new THREE.MeshStandardMaterial({ color: 0xd0342c, roughness: 0.6 });
  const black = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.6 });

  // porous body with wavy scalloped edges
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.66, 0.26, 4, 5, 1), skin);
  const pos = body.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i);
    if (Math.abs(px) > 0.25) pos.setX(i, px + Math.sin(py * 22) * 0.035);
    if (Math.abs(py) > 0.32) pos.setY(i, py + Math.sin(px * 22) * 0.03);
  }
  body.geometry.computeVertexNormals();
  body.position.y = 0.72; body.castShadow = true; rig.add(body);

  // shirt + collar + tie
  const shirt = new THREE.Mesh(new THREE.BoxGeometry(0.53, 0.1, 0.27), white);
  shirt.position.y = 0.44; rig.add(shirt);
  const shorts = new THREE.Mesh(new THREE.BoxGeometry(0.53, 0.16, 0.28), brown);
  shorts.position.y = 0.34; rig.add(shorts);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.04, 0.29), black);
  belt.position.y = 0.42; rig.add(belt);
  for (const s of [-1, 1]) {
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.03), white);
    collar.position.set(s * 0.09, 0.5, 0.14);
    collar.rotation.z = s * 0.5; rig.add(collar);
  }
  const knot = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.03), red);
  knot.position.set(0, 0.48, 0.15); rig.add(knot);
  const tie = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.02), red);
  tie.position.set(0, 0.38, 0.15); rig.add(tie);

  // big googly eyes with blue irises
  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 14), white);
    eye.position.set(s * 0.12, 0.86, 0.11);
    rig.add(eye); eyes.push(eye);
    const iris = new THREE.Mesh(new THREE.CircleGeometry(0.055, 14),
      new THREE.MeshStandardMaterial({ color: 0x2f7ec4, roughness: 0.3 }));
    iris.position.set(s * 0.12, 0.86, 0.215); rig.add(iris);
    const pup = new THREE.Mesh(new THREE.CircleGeometry(0.026, 12), black);
    pup.position.set(s * 0.12, 0.86, 0.222); rig.add(pup);
    // lashes
    for (let i = 0; i < 3; i++) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.008, 0.008), black);
      l.position.set(s * (0.07 + i * 0.04), 0.955, 0.13);
      l.rotation.z = s * (0.5 - i * 0.25); rig.add(l);
    }
  }
  // buck teeth + smile
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, 0.01), black);
  mouth.position.set(0, 0.7, 0.135); rig.add(mouth);
  for (const s of [-1, 1]) {
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.07, 0.02), white);
    tooth.position.set(s * 0.032, 0.665, 0.135); rig.add(tooth);
  }
  // freckles
  for (const [fx, fy] of [[-0.19, 0.75], [-0.16, 0.71], [0.19, 0.75], [0.16, 0.71]]) {
    const f = new THREE.Mesh(new THREE.CircleGeometry(0.012, 8), black);
    f.position.set(fx, fy, 0.132); rig.add(f);
  }

  // noodle arms + legs with shoes
  function noodle(sx, y, len, mat) {
    const piv = new THREE.Group();
    piv.position.set(sx, y, 0);
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.02, len, 7), mat);
    seg.position.y = -len / 2; piv.add(seg);
    rig.add(piv);
    return piv;
  }
  const armL = noodle(-0.27, 0.72, 0.3, skin);
  const armR = noodle(0.27, 0.72, 0.3, skin);
  const legL = noodle(-0.11, 0.3, 0.22, skin);
  const legR = noodle(0.11, 0.3, 0.22, skin);
  for (const [limb, s] of [[armL, -1], [armR, 1]]) {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.038, 10, 8), skin);
    hand.position.y = -0.3; limb.add(hand);
  }
  for (const limb of [legL, legR]) {
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.06, 8), white);
    sock.position.y = -0.2; limb.add(sock);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.12), black);
    shoe.position.set(0, -0.245, 0.025); limb.add(shoe);
  }

  g.position.set(x, 0, z);
  world.add(g);
  sponge = { g, rig, armL, armR, legL, legR, eyes, t: 0, dir: 1, blink: 2 };
}
buildSponge(-2.9, 10.9);

// If the downloaded "Sponge Neighbor" asset (CC BY, AndruBanana) is present,
// swap it in and play its baked animation instead of the placeholder.
{
  const CANDIDATES = [
    './models/sponge/scene.gltf',
    './models/sponge/sponge.glb',
    './models/sponge.glb',
  ];
  const tryLoad = i => {
    if (i >= CANDIDATES.length) return;
    loadModel(CANDIDATES[i], gltf => {
      const m = gltf.scene;
      const bb = new THREE.Box3().setFromObject(m);
      const size = bb.getSize(new THREE.Vector3());
      const s = 1.15 / Math.max(size.y, 0.001);          // scale to ~1.15m tall
      m.scale.setScalar(s);
      const bb2 = new THREE.Box3().setFromObject(m);
      m.position.y -= bb2.min.y;                          // feet on the floor
      m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      const holder = new THREE.Group();
      holder.add(m);
      holder.position.set(-2.9, 0, 11.5);
      world.add(holder);
      // retire the placeholder
      if (sponge) { world.remove(sponge.g); }
      let mixer = null;
      if (gltf.animations && gltf.animations.length) {
        mixer = new THREE.AnimationMixer(m);
        mixer.clipAction(gltf.animations[0]).play();
      }
      sponge = { g: holder, mixer, real: true, dir: 1, t: 0 };
      spongeGltf = gltf;                       // kept so he can be cloned as an enemy
      console.log('Sponge Neighbor loaded from', CANDIDATES[i]);
    }, undefined, () => tryLoad(i + 1));
  };
  tryLoad(0);
}

// ============================================================
// OUTSIDE — gravel drive, grass, sheds, trees, and the east-side porch
// ============================================================
const DROP_Y = -3.66;          // 12 ft down to the forest floor on the east side
// the rainbow annex across the ravine + its bridge
const MIRROR = { bridge: null, room: null, lights: [], x0: 0, x1: 0, z0: 0, z1: 0,
                 bx0: 0, bx1: 0, bz: 0, bw: 0 };
let mirrorActive = false;
function onBridge(x, z) {
  return MIRROR.bridge && MIRROR.bridge.visible &&
         x >= MIRROR.bx0 - 0.2 && x <= MIRROR.bx1 + 0.2 &&
         Math.abs(z - MIRROR.bz) <= MIRROR.bw / 2 + 0.15;
}
function inMirror(x, z) {
  return x > MIRROR.x0 - 0.3 && x < MIRROR.x1 && z > MIRROR.z0 && z < MIRROR.z1;
}
// the annex and its bridge both stay hidden until the round that unlocks them
function openBridge() {
  if (!MIRROR.bridge) return;
  MIRROR.bridge.visible = true;
  revealMirror();
  addShake(0.8);
  showToast('THE BRIDGE IS OUT — SOMETHING LIVES IN THE RAINBOW ANNEX', 3600);
}
function revealMirror() {
  if (MIRROR.room) MIRROR.room.visible = true;
}
{
  // The building sits on a slope: level ground on the west/north/south, and the
  // east side falls away ~12 ft to the forest floor.
  const g1 = grassTexture(); g1.repeat.set(30, 30);
  const groundMat = new THREE.MeshStandardMaterial({ map: g1, roughness: 1 });

  // upper bench — everything west of the east wall
  const upper = new THREE.Mesh(new THREE.PlaneGeometry(120, 160), groundMat);
  upper.rotation.x = -Math.PI / 2;
  upper.position.set(6 - 60, -0.02, 0);
  upper.receiveShadow = true;
  scene.add(upper);

  // lower bench — the forest floor, 12 ft (3.66 m) down
  const g2 = grassTexture(); g2.repeat.set(24, 30);
  const lower = new THREE.Mesh(new THREE.PlaneGeometry(90, 160),
    new THREE.MeshStandardMaterial({ map: g2, roughness: 1 }));
  lower.rotation.x = -Math.PI / 2;
  lower.position.set(8.6 + 45, DROP_Y, 0);
  lower.receiveShadow = true;
  scene.add(lower);

  // the embankment between them
  const dirtTex = gravelTexture(); dirtTex.repeat.set(8, 3);
  const bankMat = new THREE.MeshStandardMaterial({
    map: dirtTex, color: 0x8a6a48, roughness: 1, side: THREE.DoubleSide });
  const bank = new THREE.Mesh(new THREE.PlaneGeometry(160, 4.6), bankMat);
  bank.rotation.y = -Math.PI / 2;
  bank.rotation.x = 0;
  bank.position.set(8.6, DROP_Y / 2, 0);
  bank.rotation.z = 0;
  bank.receiveShadow = true;
  scene.add(bank);
  // slope the ground down into the bank so there's no floating edge
  const ramp = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 160), groundMat);
  ramp.rotation.x = -Math.PI / 2;
  ramp.position.set(7.3, -0.02, 0);
  ramp.receiveShadow = true;
  scene.add(ramp);

  const gr = gravelTexture(); gr.repeat.set(4, 14);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(7, 60),
    new THREE.MeshStandardMaterial({ map: gr, roughness: 1 }));
  road.rotation.x = -Math.PI / 2;
  road.position.set(-10.5, -0.01, 0);
  road.receiveShadow = true;
  scene.add(road);

  // building outer shell (so outside looks right through the glass)
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5e, roughness: 0.9 });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.02, 18.6), shellMat);

  // ---- the small porch outside the rear doors, out over the drop ----
  {
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x8d6a44, roughness: 0.9 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.75 });
    const PX0 = 6.0, PX1 = 8.5, PZ0 = -2.3, PZ1 = 2.6;      // porch footprint
    const deckY = -0.06;

    // plank decking running north–south
    for (let x = PX0; x < PX1 - 0.01; x += 0.28) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.09, PZ1 - PZ0), deckMat);
      p.position.set(x + 0.14, deckY, (PZ0 + PZ1) / 2);
      p.castShadow = p.receiveShadow = true;
      scene.add(p);
    }
    // rim joists
    for (const z of [PZ0, PZ1]) {
      const j = new THREE.Mesh(new THREE.BoxGeometry(PX1 - PX0, 0.22, 0.1), deckMat);
      j.position.set((PX0 + PX1) / 2, deckY - 0.1, z);
      scene.add(j);
    }
    const jx = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, PZ1 - PZ0), deckMat);
    jx.position.set(PX1, deckY - 0.1, (PZ0 + PZ1) / 2);
    scene.add(jx);

    // support posts dropping all the way to the forest floor
    for (const px of [PX1 - 0.2, PX0 + 0.9]) {
      for (const pz of [PZ0 + 0.3, PZ1 - 0.3]) {
        const h = deckY - DROP_Y;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, h, 0.16), deckMat);
        post.position.set(px, deckY - h / 2, pz);
        post.castShadow = true;
        scene.add(post);
      }
    }
    // diagonal bracing
    for (const pz of [PZ0 + 0.3, PZ1 - 0.3]) {
      const br = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.1, 0.1), deckMat);
      br.position.set(PX0 + 1.5, DROP_Y + 1.4, pz);
      br.rotation.z = 0.55;
      scene.add(br);
    }

    // railing around the three open sides
    function railRun(x0, z0, x1, z1) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const mid = [(x0 + x1) / 2, (z0 + z1) / 2];
      const ang = Math.atan2(x1 - x0, z1 - z0);
      for (const y of [0.98, 0.52]) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, len), railMat);
        r.position.set(mid[0], y, mid[1]);
        r.rotation.y = ang;
        r.castShadow = true;
        scene.add(r);
      }
      const n = Math.max(2, Math.round(len / 0.34));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.02, 0.05), railMat);
        b.position.set(x0 + (x1 - x0) * t, 0.5, z0 + (z1 - z0) * t);
        scene.add(b);
      }
      // newel posts
      for (const [px, pz] of [[x0, z0], [x1, z1]]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.14, 0.12), railMat);
        p.position.set(px, 0.56, pz);
        p.castShadow = true;
        scene.add(p);
      }
    }
    // outer edge, over the drop — with a gap where the bridge meets it
    railRun(PX1, PZ0, PX1, -1.35);
    railRun(PX1, 1.55, PX1, PZ1);
    railRun(PX0, PZ0, PX1, PZ0);          // north side
    railRun(PX0, PZ1, PX1, PZ1);          // south side

    // stairs hugging the south side, down to the forest floor
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / steps;
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 1.1), deckMat);
      s.position.set(PX1 + 0.2 + i * 0.34, deckY - t * (deckY - DROP_Y), PZ1 + 0.9);
      s.castShadow = s.receiveShadow = true;
      scene.add(s);
    }

    // keep the player from walking off the porch edge
    addCollider(PX1 - 0.06, PX1 + 0.4, PZ0 - 0.4, -1.35, 9);
    addCollider(PX1 - 0.06, PX1 + 0.4, 1.55, PZ1 + 0.4, 9);
    addCollider(PX0 - 0.4, PX1 + 0.4, PZ0 - 0.35, PZ0 + 0.06, 9);
    addCollider(PX0 - 0.4, PX1 + 0.4, PZ1 - 0.06, PZ1 + 0.35, 9);
  }

  // ---- the rainbow annex across the ravine, and the bridge to it ----
  // A mirror of the main hall in candy colours. Both stay hidden until round 6,
  // when the bridge extends and the annex appears across the ravine.
  function rainbowPine(light = 1.0, boards = 12, size = 512) {
    const [c, ctx] = makeCanvas(size, size);
    const bh = size / boards;
    for (let i = 0; i < boards; i++) {
      const hue = (i / boards) * 360;
      ctx.fillStyle = `hsl(${hue}, 78%, ${58 * light}%)`;
      ctx.fillRect(0, i * bh, size, bh);
      for (let g = 0; g < 14; g++) {
        ctx.strokeStyle = `hsla(${hue}, 85%, ${38 + rnd(-8, 18)}%, ${rnd(0.10, 0.26)})`;
        ctx.lineWidth = rnd(0.7, 2.4);
        ctx.beginPath();
        let y = i * bh + rnd(2, bh - 2);
        ctx.moveTo(0, y);
        for (let x = 0; x <= size; x += 64) ctx.quadraticCurveTo(x + 32, y + rnd(-3, 3), x + 64, y + rnd(-2, 2));
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(0, i * bh, size, 1.4);
      ctx.fillStyle = 'rgba(40,0,60,0.25)';    ctx.fillRect(0, i * bh + bh - 1.4, size, 1.4);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = ANISO;
    return t;
  }
  const rbTex = rainbowPine();
  function rbMat(rx, ry, light = 1) {
    const t = rbTex.clone(); t.needsUpdate = true; t.repeat.set(rx, ry);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, emissive: 0x140820,
      emissiveIntensity: 0.35 * light });
  }

  const MX0 = 14, MX1 = 26, MZ0 = -9, MZ1 = 9, MH = 3.05;
  MIRROR.x0 = MX0; MIRROR.x1 = MX1; MIRROR.z0 = MZ0; MIRROR.z1 = MZ1;
  {
    // Everything in here hangs off one group so the whole annex — geometry and
    // disco lights alike — stays hidden until the round that unlocks it.
    // three.js skips invisible subtrees entirely, so the lights don't leak out.
    const room = new THREE.Group();
    room.visible = false;
    scene.add(room);
    MIRROR.room = room;

    // floor — glossy candy checker
    const [fc, fctx] = makeCanvas(256, 256);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      fctx.fillStyle = (x + y) % 2 ? `hsl(${(x * 40 + y * 25) % 360},70%,62%)`
                                   : `hsl(${(x * 40 + y * 25 + 180) % 360},65%,48%)`;
      fctx.fillRect(x * 32, y * 32, 32, 32);
    }
    const ft = new THREE.CanvasTexture(fc);
    ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.repeat.set(3, 4);
    ft.colorSpace = THREE.SRGBColorSpace;
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(MX1 - MX0, MZ1 - MZ0),
      new THREE.MeshStandardMaterial({ map: ft, roughness: 0.3, metalness: 0.15 }));
    fl.rotation.x = -Math.PI / 2;
    fl.position.set((MX0 + MX1) / 2, 0.01, (MZ0 + MZ1) / 2);
    fl.receiveShadow = true;
    room.add(fl);

    // ceiling
    const ce = new THREE.Mesh(new THREE.PlaneGeometry(MX1 - MX0, MZ1 - MZ0), rbMat(4, 6, 1.4));
    ce.rotation.x = Math.PI / 2;
    ce.position.set((MX0 + MX1) / 2, MH, (MZ0 + MZ1) / 2);
    room.add(ce);

    // walls — west wall has a doorway facing the bridge
    const mk = (w, h, d, x, y, z, mat) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; room.add(m); return m;
    };
    mk(MX1 - MX0, MH, 0.25, (MX0 + MX1) / 2, MH / 2, MZ0, rbMat(4, 1));      // north
    mk(MX1 - MX0, MH, 0.25, (MX0 + MX1) / 2, MH / 2, MZ1, rbMat(4, 1));      // south
    mk(0.25, MH, MZ1 - MZ0, MX1, MH / 2, (MZ0 + MZ1) / 2, rbMat(6, 1));      // east
    // west wall in two pieces around a 3m doorway
    const DZ0 = -1.5, DZ1 = 1.5;
    mk(0.25, MH, DZ0 - MZ0, MX0, MH / 2, (MZ0 + DZ0) / 2, rbMat(3, 1));
    mk(0.25, MH, MZ1 - DZ1, MX0, MH / 2, (DZ1 + MZ1) / 2, rbMat(3, 1));
    mk(0.25, MH - 2.4, DZ1 - DZ0, MX0, 2.4 + (MH - 2.4) / 2, 0, rbMat(1, 0.3));

    // colliders
    addCollider(MX0 - 0.2, MX0 + 0.2, MZ0, DZ0, 9);
    addCollider(MX0 - 0.2, MX0 + 0.2, DZ1, MZ1, 9);
    addCollider(MX1 - 0.2, MX1 + 0.2, MZ0, MZ1, 9);
    addCollider(MX0, MX1, MZ0 - 0.2, MZ0 + 0.2, 9);
    addCollider(MX0, MX1, MZ1 - 0.2, MZ1 + 0.2, 9);

    // disco lighting
    for (const [lx, lz, col] of [[17, -5, 0xff3ba7], [23, -5, 0x3bd7ff],
                                 [17, 5, 0xffe23b], [23, 5, 0x7cff3b], [20, 0, 0xc46bff]]) {
      const p = new THREE.PointLight(col, 8, 12, 1.5);
      p.position.set(lx, 2.7, lz);
      room.add(p);
      MIRROR.lights.push(p);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.16, 14),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 5 }));
      disc.rotation.x = Math.PI / 2;
      disc.position.set(lx, MH - 0.03, lz);
      room.add(disc);
    }
    // a mirrored "green screen" in rainbow
    const gsGeo = new THREE.PlaneGeometry(3.3, 2.45);
    const [gc, gctx] = makeCanvas(128, 128);
    for (let i = 0; i < 128; i++) {
      gctx.fillStyle = `hsl(${(i / 128) * 360}, 90%, 60%)`;
      gctx.fillRect(i, 0, 1, 128);
    }
    const gt = new THREE.CanvasTexture(gc); gt.colorSpace = THREE.SRGBColorSpace;
    const gs = new THREE.Mesh(gsGeo, new THREE.MeshStandardMaterial({
      map: gt, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.8, side: THREE.DoubleSide }));
    gs.position.set(22, 1.48, MZ0 + 0.35);
    room.add(gs);
  }

  // the bridge — planks + rails, hidden until round 6
  {
    const g = new THREE.Group();
    const BX0 = 8.4, BX1 = MX0, BZ = 0.15, BW = 2.2;
    const plankMat = new THREE.MeshStandardMaterial({ color: 0x9a6f45, roughness: 0.9 });
    for (let x = BX0; x < BX1; x += 0.34) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.09, BW), plankMat);
      p.position.set(x + 0.15, -0.05, BZ);
      p.castShadow = p.receiveShadow = true;
      g.add(p);
    }
    // stringers
    for (const dz of [-BW / 2, BW / 2]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(BX1 - BX0, 0.16, 0.12), plankMat);
      s.position.set((BX0 + BX1) / 2, -0.14, BZ + dz);
      g.add(s);
    }
    // rainbow rope railings
    for (const dz of [-BW / 2 - 0.05, BW / 2 + 0.05]) {
      for (let i = 0; i <= 14; i++) {
        const x = BX0 + (BX1 - BX0) * (i / 14);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.0, 0.07),
          new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 14, 0.85, 0.55),
            emissive: new THREE.Color().setHSL(i / 14, 0.9, 0.35), emissiveIntensity: 1.2 }));
        post.position.set(x, 0.45, BZ + dz);
        g.add(post);
      }
      const rail = new THREE.Mesh(new THREE.BoxGeometry(BX1 - BX0, 0.07, 0.07),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.7 }));
      rail.position.set((BX0 + BX1) / 2, 0.95, BZ + dz);
      g.add(rail);
    }
    g.visible = false;
    scene.add(g);
    MIRROR.bridge = g;
    MIRROR.bz = BZ; MIRROR.bw = BW; MIRROR.bx0 = BX0; MIRROR.bx1 = BX1;
  }

  // sheds across the road (from photos)
  function shed(x, z, w, d, h, color) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    b.position.set(x, h / 2, z);
    b.castShadow = true;
    scene.add(b);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.72, h * 0.5, 4),
      new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.8 }));
    roof.position.set(x, h + h * 0.24, z);
    roof.rotation.y = Math.PI / 4;
    scene.add(roof);
  }
  shed(-20, -8, 4, 3, 2.6, 0xc9c2b4);
  shed(-19, 3, 3.4, 2.8, 2.4, 0x6d7f68);
  shed(-22, 12, 4.4, 3.2, 2.7, 0xb8a88e);

  // trees
  function tree(x, z, s = 1) {
    const base = x > 8.6 ? DROP_Y : 0;          // east of the bank the ground is 12 ft lower
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * s, 0.2 * s, 1.6 * s, 7),
      new THREE.MeshStandardMaterial({ color: 0x5a4630, roughness: 1 }));
    trunk.position.set(x, base + 0.8 * s, z);
    scene.add(trunk);
    const fol = new THREE.Mesh(new THREE.ConeGeometry(1.5 * s, 3.4 * s, 8),
      new THREE.MeshStandardMaterial({ color: 0x3e5e38, roughness: 1 }));
    fol.position.set(x, base + 1.6 * s + 1.6 * s, z);
    fol.castShadow = true;
    scene.add(fol);
  }
  for (let i = 0; i < 14; i++) tree(rnd(-35, -16), rnd(-30, 30), rnd(0.8, 1.6));
  for (let i = 0; i < 8; i++) tree(rnd(16, 40), rnd(-35, 35), rnd(0.9, 1.5));
  // dense forest below the east bank — but keep the bridge corridor and the
  // annex footprint clear
  for (let i = 0; i < 26; i++) {
    const tx = rnd(9.0, 30), tz = rnd(-16, 16);
    const inCorridor = tx < MIRROR.x0 + 0.5 && Math.abs(tz) < 3.0;
    const inAnnex = tx > MIRROR.x0 - 1.2 && tx < MIRROR.x1 + 1.2 &&
                    tz > MIRROR.z0 - 1.2 && tz < MIRROR.z1 + 1.2;
    if (inCorridor || inAnnex) continue;
    tree(tx, tz, rnd(1.1, 1.9));
  }

  // real golf cart parked by the road ("area 9 golf cart" by maxdragonn, CC-BY)
  loadModel('./models/golfcart/scene.gltf', g => {
    const cart = g.scene;
    cart.updateMatrixWorld(true);
    const bb = new THREE.Box3();
    cart.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.geometry.computeBoundingBox();
        bb.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
      }
    });
    const size = bb.getSize(new THREE.Vector3());
    const s = 2.4 / Math.max(size.z, size.x, 0.001);      // ~2.4m long
    cart.scale.setScalar(s);
    cart.position.y = -bb.min.y * s;
    const holder = new THREE.Group();
    holder.add(cart);
    holder.position.set(-9.6, 0, -10.5);
    holder.rotation.y = 0.5;
    scene.add(holder);
    // a second one further down the drive
    const two = holder.clone();
    two.position.set(-11.2, 0, 6.5);
    two.rotation.y = -0.35;
    scene.add(two);
  });
}

// ============================================================
// LIGHTING
// ============================================================
const hemi = new THREE.HemisphereLight(0xd6ecf7, 0x4a3a26, 0.4);
scene.add(hemi);

// key sun through the west garage doors — long warm rake across the floor
const sun = new THREE.DirectionalLight(0xfff0d4, 2.0);
sun.position.set(-22, 16, 6);
sun.castShadow = TIER.shadows;
sun.shadow.mapSize.set(TIER.shadowSize, TIER.shadowSize);
sun.shadow.camera.left = -16; sun.shadow.camera.right = 16;
sun.shadow.camera.top = 16; sun.shadow.camera.bottom = -16;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 60;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 3;
scene.add(sun);

// cool bounce from the east window wall, opposing the warm key
const coolFill = new THREE.DirectionalLight(0xb8d8f0, 0.5);
coolFill.position.set(18, 8, -4);
scene.add(coolFill);

// Warm pools directly under each recessed can. Every one of these is evaluated
// per fragment for every lit surface on screen, so the count is the single
// biggest shading cost in the room — the tier decides how many actually burn,
// and the ones that stay get brighter and reach further to cover the gaps.
const CAN_SPOTS = [];
for (const x of [-3.6, 3.6]) for (const z of [-7, -3.5, 0, 3.5, 7]) CAN_SPOTS.push([x, z]);
// picked so a reduced set still spreads across the whole hall instead of
// clustering at one end
const CAN_ORDER = [2, 7, 0, 9, 4, 5, 1, 6, 3, 8];
const warm = [];
for (let i = 0; i < TIER.warmCans; i++) {
  const [x, z] = CAN_SPOTS[CAN_ORDER[i]];
  const spread = 10 / Math.max(1, TIER.warmCans);
  const p = new THREE.PointLight(0xffcf96, 3.4 * Math.min(2, 0.55 + spread * 0.45),
    6.5 * Math.min(1.8, 0.75 + spread * 0.25), 2.0);
  p.position.set(x, 2.72, z);
  scene.add(p);
  warm.push(p);
}
// soft ambient lift so the room never crushes to black — carries more of the
// load when the cans have been thinned out
const roomFill = new THREE.PointLight(0xffe3c0, 3.2 * TIER.lightBoost,
  24 * (TIER.warmCans ? 1 : 1.3), 1.2);
roomFill.position.set(0, 2.5, 0);
scene.add(roomFill);

// keep IBL as a subtle sheen, not a second sun
scene.traverse(o => {
  if (o.isMesh && o.material) {
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (m.isMeshStandardMaterial) m.envMapIntensity = 0.28;
    }
  }
});

// ---------- atmosphere: dust motes + light shafts through the doors ----------
let dust = null;
if (TIER.dust > 0) {
  const [dc, dctx] = makeCanvas(64, 64);
  const dg = dctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  dg.addColorStop(0, 'rgba(255,245,225,1)');
  dg.addColorStop(0.35, 'rgba(255,240,215,0.45)');
  dg.addColorStop(1, 'rgba(255,235,205,0)');
  dctx.fillStyle = dg; dctx.fillRect(0, 0, 64, 64);
  const dustTex = new THREE.CanvasTexture(dc);

  const N = TIER.dust;   // every mote is repositioned in JS every frame
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = rnd(-6, 6);
    pos[i * 3 + 1] = rnd(0.15, 2.95);
    pos[i * 3 + 2] = rnd(-9, 9);
    seed[i] = rnd(0, Math.PI * 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  dust = new THREE.Points(geo, new THREE.PointsMaterial({
    map: dustTex, size: 0.018, transparent: true, opacity: 0.3,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  dust.userData = { seed, base: pos.slice() };
  scene.add(dust);
}

// volumetric-ish shafts spilling in through each garage door opening
const shafts = [];
for (const def of [DOOR_A, DOOR_B]) {
  const w = def.z1 - def.z0;
  const geo = new THREE.PlaneGeometry(w * 0.92, 5.5);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffe6bd, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = Math.PI / 2;
  m.position.set(-3.1, 0.06, (def.z0 + def.z1) / 2);
  scene.add(m);
  shafts.push(m);
}

// ============================================================
// WEATHER — the sky turns over every round
// ============================================================
// Each round pulls the next preset off this list and eases into it over a
// couple of seconds. Precipitation only falls OUTSIDE the buildings, so you see
// it through the garage doors and windows without it raining on the couches.
const WEATHER = [
  { id: 'clear', name: 'CLEAR SKIES', icon: '☀️',
    sky: 0x8fc4e8, fog: 0xbcd9ee, fogNear: 45, fogFar: 130, exposure: 0.78,
    hemiSky: 0xd6ecf7, hemiGnd: 0x4a3a26, hemiInt: 0.5,
    sunCol: 0xfff0d4, sunInt: 2.4, fillCol: 0xb8d8f0, fillInt: 0.5, fall: null },

  { id: 'storm', name: 'THUNDERSTORM', icon: '⛈️',
    sky: 0x2b323c, fog: 0x39434f, fogNear: 16, fogFar: 72, exposure: 0.5,
    hemiSky: 0x6b7684, hemiGnd: 0x1d1a16, hemiInt: 0.34,
    sunCol: 0x9fb0c4, sunInt: 0.45, fillCol: 0x7f93ad, fillInt: 0.32,
    fall: 'rain', lightning: true },

  { id: 'snow', name: 'SNOWFALL', icon: '❄️',
    sky: 0xd8e4ee, fog: 0xe4edf5, fogNear: 12, fogFar: 62, exposure: 0.84,
    hemiSky: 0xffffff, hemiGnd: 0x9aa8b4, hemiInt: 0.78,
    sunCol: 0xeaf2ff, sunInt: 1.15, fillCol: 0xcfe0f2, fillInt: 0.62, fall: 'snow' },

  { id: 'wildfire', name: 'WILDFIRE HAZE', icon: '🔥',
    sky: 0xb8481a, fog: 0xa8471d, fogNear: 12, fogFar: 62, exposure: 0.6,
    hemiSky: 0xff9a4a, hemiGnd: 0x3a1608, hemiInt: 0.55,
    sunCol: 0xff7326, sunInt: 2.0, fillCol: 0xff6a3a, fillInt: 0.5, fall: 'ember' },

  { id: 'fog', name: 'DEAD FOG', icon: '🌫️',
    sky: 0xa6aeb2, fog: 0xafb7bb, fogNear: 4, fogFar: 30, exposure: 0.68,
    hemiSky: 0xc8d2d6, hemiGnd: 0x62666a, hemiInt: 0.52,
    sunCol: 0xd8dee2, sunInt: 0.65, fillCol: 0xaab4ba, fillInt: 0.4, fall: null },

  { id: 'aurora', name: 'AURORA NIGHT', icon: '🌌',
    sky: 0x081029, fog: 0x0c1733, fogNear: 22, fogFar: 95, exposure: 0.6,
    hemiSky: 0x2e6f7a, hemiGnd: 0x080d1a, hemiInt: 0.42,
    sunCol: 0x6fd7c2, sunInt: 0.5, fillCol: 0x7a5cff, fillInt: 0.6,
    fall: 'mote', aurora: true },
];
function weatherForRound(r) { return WEATHER[Math.max(0, r - 1) % WEATHER.length]; }

// live, eased values — the presets are targets, these are what actually render
const wx = {
  preset: WEATHER[0], from: WEATHER[0], blend: 1,
  sky: new THREE.Color(0xb9cdd8), fog: new THREE.Color(0xc3d6e0),
  hemiSky: new THREE.Color(0xd6ecf7), hemiGnd: new THREE.Color(0x4a3a26),
  sunCol: new THREE.Color(0xfff0d4), fillCol: new THREE.Color(0xb8d8f0),
  flash: 0, boltT: 0, strikeIn: 6, thunderQ: [],
};
const _cA = new THREE.Color(), _cB = new THREE.Color();

// ---------- precipitation: one buffer, re-skinned per weather ----------
const FALL_N = TIER.fall;   // precipitation is integrated on the CPU every frame
const FALL_R = 24;                               // the field follows the player
const fallP = new Float32Array(FALL_N * 3);      // head position
const fallV = new Float32Array(FALL_N * 3);      // velocity
const fallS = new Float32Array(FALL_N);          // per-particle phase
// the field re-centres on the player each frame (set in updateWeather — `player`
// isn't declared yet at module-eval time, so it can't be read from here)
let fallCX = 0, fallCZ = 0;
// nothing falls through a roof — reroll until the point is outside both buildings
function openSpot(out) {
  for (let i = 0; i < 24; i++) {
    const x = fallCX + rnd(-FALL_R, FALL_R), z = fallCZ + rnd(-FALL_R, FALL_R);
    const inHall = x > -7 && x < 7 && z > -10 && z < 10;
    const inAnnex = x > 13 && x < 27 && z > -10 && z < 10;
    if (!inHall && !inAnnex) { out.x = x; out.z = z; return; }
  }
  out.x = fallCX + 30; out.z = fallCZ + 30;
}
const _spot = { x: 0, z: 0 };
function seedFall(i, high) {
  openSpot(_spot);
  fallP[i * 3] = _spot.x;
  fallP[i * 3 + 1] = high ? rnd(6, 24) : rnd(-3.5, 24);
  fallP[i * 3 + 2] = _spot.z;
  fallS[i] = rnd(0, Math.PI * 2);
}
for (let i = 0; i < FALL_N; i++) seedFall(i, false);

// snow / embers / motes draw as sprites
const fallDotGeo = new THREE.BufferGeometry();
fallDotGeo.setAttribute('position', new THREE.BufferAttribute(fallP, 3));
const dotTex = (() => {
  const [c, x] = makeCanvas(64, 64);
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const fallDots = new THREE.Points(fallDotGeo, new THREE.PointsMaterial({
  map: dotTex, size: 0.16, transparent: true, opacity: 0.9,
  depthWrite: false, sizeAttenuation: true,
}));
fallDots.frustumCulled = false;
fallDots.visible = false;
scene.add(fallDots);

// rain draws as streaks — two verts per drop, stretched along its velocity
const rainSeg = new Float32Array(FALL_N * 6);
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainSeg, 3));
const rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
  color: 0xaecbe4, transparent: true, opacity: 0.5, depthWrite: false,
}));
rainLines.frustumCulled = false;
rainLines.visible = false;
scene.add(rainLines);

// ---------- the aurora curtain, only up on aurora nights ----------
const aurora = (() => {
  const [c, x] = makeCanvas(256, 256);
  for (let i = 0; i < 256; i++) {
    const g = x.createLinearGradient(0, 0, 0, 256);
    const hue = 120 + Math.sin(i / 34) * 60;
    g.addColorStop(0, `hsla(${hue},90%,60%,0)`);
    g.addColorStop(0.45, `hsla(${hue},95%,62%,${0.55 + Math.sin(i / 12) * 0.25})`);
    g.addColorStop(1, `hsla(${hue + 40},90%,55%,0)`);
    x.fillStyle = g; x.fillRect(i, 0, 1, 256);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(90, 26, 24, 1),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.position.set(0, 20 + i * 4, -60 - i * 12);
    m.userData.phase = i * 1.7;
    g.add(m);
  }
  g.visible = false;
  scene.add(g);
  return g;
})();

// ---------- the lightning bolt itself ----------
const bolt = (() => {
  const pts = new Float32Array(24 * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({
    color: 0xdcecff, transparent: true, opacity: 0, depthWrite: false }));
  l.frustumCulled = false;
  scene.add(l);
  return l;
})();
function strikeBolt() {
  const p = bolt.geometry.attributes.position.array;
  const side = Math.random() < 0.5 ? -1 : 1;
  let x = side * rnd(16, 40), y = 34, z = rnd(-40, 40);
  for (let i = 0; i < 24; i++) {
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    x += rnd(-2.4, 2.4); y -= 34 / 23; z += rnd(-1.6, 1.6);
  }
  bolt.geometry.attributes.position.needsUpdate = true;
  bolt.material.opacity = 1;
  wx.boltT = 0.22;
  wx.flash = 1;
  wx.thunderQ.push(rnd(0.4, 2.2));     // sound lags the flash, like real distance
}

function sfxThunder() {
  const ctx = audio(); const t = ctx.currentTime;
  const dur = 2.4;
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const k = i / d.length;
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, 1.7) * (0.6 + Math.sin(k * 40) * 0.4);
  }
  const src = ctx.createBufferSource(); src.buffer = buf;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.setValueAtTime(340, t);
  lp.frequency.exponentialRampToValueAtTime(70, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.32, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(lp).connect(g).connect(ctx.destination);
  src.start(t); src.stop(t + dur);
}

function setWeather(preset, instant = false) {
  wx.from = {
    sky: wx.sky.getHex(), fog: wx.fog.getHex(),
    fogNear: scene.fog.near, fogFar: scene.fog.far,
    exposure: renderer.toneMappingExposure,
    hemiSky: wx.hemiSky.getHex(), hemiGnd: wx.hemiGnd.getHex(), hemiInt: hemi.intensity,
    sunCol: wx.sunCol.getHex(), sunInt: sun.intensity,
    fillCol: wx.fillCol.getHex(), fillInt: coolFill.intensity,
  };
  wx.preset = preset;
  wx.blend = instant ? 1 : 0;
  wx.strikeIn = preset.lightning ? rnd(1.5, 5) : 1e9;

  // swap the precipitation look over immediately; the lighting is what eases
  const f = preset.fall;
  rainLines.visible = f === 'rain';
  fallDots.visible = f === 'snow' || f === 'ember' || f === 'mote';
  aurora.visible = !!preset.aurora;
  if (f === 'snow') {
    fallDots.material.color.setHex(0xffffff);
    fallDots.material.size = 0.17;
    fallDots.material.opacity = 0.95;
    fallDots.material.blending = THREE.NormalBlending;
  } else if (f === 'ember') {
    fallDots.material.color.setHex(0xff7a2a);
    fallDots.material.size = 0.13;
    fallDots.material.opacity = 0.95;
    fallDots.material.blending = THREE.AdditiveBlending;
  } else if (f === 'mote') {
    fallDots.material.color.setHex(0x9fe8ff);
    fallDots.material.size = 0.1;
    fallDots.material.opacity = 0.8;
    fallDots.material.blending = THREE.AdditiveBlending;
  }
  fallDots.material.needsUpdate = true;

  // give every particle the velocity its weather calls for
  for (let i = 0; i < FALL_N; i++) {
    if (f === 'rain') {
      fallV[i * 3] = rnd(-7, -4); fallV[i * 3 + 1] = rnd(-34, -26); fallV[i * 3 + 2] = rnd(-1, 1);
    } else if (f === 'snow') {
      fallV[i * 3] = rnd(-0.5, 0.5); fallV[i * 3 + 1] = rnd(-1.9, -1.1); fallV[i * 3 + 2] = rnd(-0.5, 0.5);
    } else if (f === 'ember') {
      fallV[i * 3] = rnd(-1.2, 1.2); fallV[i * 3 + 1] = rnd(0.5, 1.7); fallV[i * 3 + 2] = rnd(-1.2, 1.2);
    } else if (f === 'mote') {
      fallV[i * 3] = rnd(-0.3, 0.3); fallV[i * 3 + 1] = rnd(-0.25, 0.25); fallV[i * 3 + 2] = rnd(-0.3, 0.3);
    }
  }
  if (instant) applyWeather();
}

// write the eased values into the scene
function applyWeather() {
  const p = wx.preset, f = wx.from, k = wx.blend;
  const mix = (a, b) => a + (b - a) * k;
  wx.sky.setHex(f.sky).lerp(_cA.setHex(p.sky), k);
  wx.fog.setHex(f.fog).lerp(_cA.setHex(p.fog), k);
  wx.hemiSky.setHex(f.hemiSky).lerp(_cA.setHex(p.hemiSky), k);
  wx.hemiGnd.setHex(f.hemiGnd).lerp(_cA.setHex(p.hemiGnd), k);
  wx.sunCol.setHex(f.sunCol).lerp(_cA.setHex(p.sunCol), k);
  wx.fillCol.setHex(f.fillCol).lerp(_cA.setHex(p.fillCol), k);

  const fl = wx.flash;                       // lightning lifts the whole sky
  scene.background = _cB.copy(wx.sky).lerp(_cA.setHex(0x9fb6d4), fl * 0.7);
  scene.fog.color.copy(wx.fog).lerp(_cA.setHex(0xbcccdf), fl * 0.55);
  scene.fog.near = mix(f.fogNear, p.fogNear);
  // a nearer fog wall on LOW quietly hides more of the outdoor scenery
  scene.fog.far = mix(f.fogFar, p.fogFar) * TIER.fogFarMul;
  renderer.toneMappingExposure = mix(f.exposure, p.exposure) * (1 + fl * 0.3);

  hemi.color.copy(wx.hemiSky); hemi.groundColor.copy(wx.hemiGnd);
  // the hemisphere picks up the slack for the recessed cans we turned off
  hemi.intensity = (mix(f.hemiInt, p.hemiInt) + fl * 1.9) * TIER.lightBoost;
  sun.color.copy(wx.sunCol);
  sun.intensity = mix(f.sunInt, p.sunInt) + fl * 3.2;
  coolFill.color.copy(wx.fillCol);
  coolFill.intensity = mix(f.fillInt, p.fillInt) + fl * 1.2;
}

function updateWeather(dt, now) {
  if (wx.blend < 1) wx.blend = Math.min(1, wx.blend + dt / 2.2);

  // lightning: a flash, a bolt, then thunder rolls in a beat later
  if (wx.flash > 0) wx.flash = Math.max(0, wx.flash - dt * 5.5);
  if (wx.boltT > 0) {
    wx.boltT -= dt;
    // flicker rather than a clean fade — reads much more like a real strike
    bolt.material.opacity = wx.boltT > 0 ? (Math.random() < 0.35 ? 0.2 : 1) : 0;
    if (wx.boltT <= 0) bolt.material.opacity = 0;
  }
  wx.strikeIn -= dt;
  if (wx.strikeIn <= 0) {
    wx.strikeIn = rnd(3.5, 11);
    strikeBolt();
    if (Math.random() < 0.4) setTimeout(strikeBolt, 130);   // double strike
  }
  for (let i = wx.thunderQ.length - 1; i >= 0; i--) {
    wx.thunderQ[i] -= dt;
    if (wx.thunderQ[i] <= 0) { wx.thunderQ.splice(i, 1); sfxThunder(); addShake(0.22); }
  }

  applyWeather();

  // aurora curtains breathe and drift
  if (aurora.visible) {
    for (const m of aurora.children) {
      const t = now * 0.25 + m.userData.phase;
      m.material.opacity = 0.28 + Math.abs(Math.sin(t)) * 0.34;
      m.position.x = Math.sin(t * 0.6) * 14;
      m.scale.y = 1 + Math.sin(t * 0.9) * 0.22;
    }
  }

  const f = wx.preset.fall;
  if (!f) return;
  fallCX = player.pos.x; fallCZ = player.pos.z;   // keep the field around you
  const rain = f === 'rain';
  for (let i = 0; i < FALL_N; i++) {
    const j = i * 3;
    fallP[j] += fallV[j] * dt;
    fallP[j + 1] += fallV[j + 1] * dt;
    fallP[j + 2] += fallV[j + 2] * dt;
    if (f === 'snow') {                       // drift sideways as it comes down
      fallP[j] += Math.sin(now * 0.7 + fallS[i]) * dt * 0.9;
      fallP[j + 2] += Math.cos(now * 0.5 + fallS[i]) * dt * 0.9;
    } else if (f === 'ember' || f === 'mote') {
      fallP[j] += Math.sin(now * 1.6 + fallS[i]) * dt * 0.8;
      fallP[j + 2] += Math.cos(now * 1.3 + fallS[i]) * dt * 0.8;
    }
    // recycle: embers rise and burn out up top, everything else lands —
    // and anything the player has walked away from comes back around
    const strayed = Math.abs(fallP[j] - fallCX) > FALL_R * 1.5 ||
                    Math.abs(fallP[j + 2] - fallCZ) > FALL_R * 1.5;
    const done = strayed || ((f === 'ember') ? fallP[j + 1] > 22
               : (f === 'mote') ? Math.abs(fallP[j + 1] - 10) > 14
               : fallP[j + 1] < -4);
    if (done) {
      seedFall(i, true);
      if (f === 'ember') fallP[j + 1] = rnd(-4, 0);
      if (f === 'mote') fallP[j + 1] = rnd(4, 18);
    }
    if (rain) {                                // stretch each drop into a streak
      const k = i * 6;
      rainSeg[k] = fallP[j];
      rainSeg[k + 1] = fallP[j + 1];
      rainSeg[k + 2] = fallP[j + 2];
      rainSeg[k + 3] = fallP[j] - fallV[j] * 0.028;
      rainSeg[k + 4] = fallP[j + 1] - fallV[j + 1] * 0.028;
      rainSeg[k + 5] = fallP[j + 2] - fallV[j + 2] * 0.028;
    }
  }
  if (rain) rainGeo.attributes.position.needsUpdate = true;
  else fallDotGeo.attributes.position.needsUpdate = true;
}

// ============================================================
// PLAYER + CONTROLS
// ============================================================
const player = {
  pos: new THREE.Vector3(2.5, 0, 2.0),
  yaw: Math.PI * 0.75, pitch: 0,
  vel: new THREE.Vector3(),
  hp: 100, alive: true,
  bob: 0, bobAmt: 0, shake: 0, sprint: 0, lean: 0,
  y: 0, vy: 0, grounded: true,
  invulnT: 0,          // brief grace period after burning an extra life
  shield: 0,           // shield potion soaks damage before health does
};
const GRAVITY = 16;
function addShake(a) { player.shake = Math.min(1.4, player.shake + a); }
const EYE = 1.62;
const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (mini) {
    if (e.code === 'Space') { e.preventDefault(); miniJump(); }
    if (e.code === 'Escape') endTimelineRunner(true);
    return;   // the minigame swallows everything else
  }
  if (alienQuiz) return;   // typing a name — let the input have every key
  if (e.code === 'Space') {
    e.preventDefault();
    if (player.grounded && game.state !== 'menu' && game.state !== 'gameover') {
      player.vy = 5.9;
      player.grounded = false;
      sfxJump();
    }
  }
  // weapon hotkeys
  if (e.code === 'Digit1') selectWeapon(0);
  if (e.code === 'Digit2') selectWeapon(1);
  if (e.code === 'Digit3') selectWeapon(2);
  if (e.code === 'Digit4') selectWeapon(3);
  if (e.code === 'Digit5') selectWeapon(4);
  if (e.code === 'Tab') { e.preventDefault(); openWheel(); }
  if (e.code === 'KeyM') setMuted(!sfxMuted);
});
addEventListener('keyup', e => { if (e.code === 'Tab') closeWheel(); });
addEventListener('keyup', e => keys[e.code] = false);

let pointerLocked = false;
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
});
addEventListener('mousemove', e => {
  if (!pointerLocked || alienQuiz) return;
  player.yaw -= e.movementX * 0.0023;
  player.pitch -= e.movementY * 0.0023;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
});

// ============================================================
// DSLR CAMERA WEAPON (view model)
// ============================================================
const weapon = new THREE.Group();
{
  // photoreal SLR: "Camera 01" from Poly Haven (CC0), PBR textures
  loadModel('./models/camera/Camera_01.gltf', g => {
    const cam = g.scene;
    // The strap is hidden, but GLTFLoader still decoded its three 2K maps —
    // ~48 MB of RAM for geometry that never draws. Throw the whole thing out.
    const strap = [];
    cam.traverse(o => {
      if (o.isMesh) {
        o.castShadow = false;
        if (/strap/i.test(o.name) || (o.material && /strap/i.test(o.material.name || ''))) strap.push(o);
      }
    });
    for (const s of strap) discardMesh(s);
    tuneModel(cam);
    const box = new THREE.Box3().setFromObject(cam);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    cam.position.sub(center);
    const holder = new THREE.Group();
    holder.add(cam);
    holder.scale.setScalar(0.3 / Math.max(size.x, size.y, size.z));
    holder.rotation.y = Math.PI;   // model lens runs +z; flip so it aims downrange
    holder.name = 'camHolder';
    weapon.add(holder);
  });
  // flash burst quad — only visible for the instant the flash fires
  const flashFace = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xfff8e8, emissive: 0xfff2cc, emissiveIntensity: 0.25 }));
  flashFace.position.set(0, 0.12, -0.07);
  flashFace.visible = false;
  weapon.add(flashFace);
  weapon.userData.flashFace = flashFace;
  weapon.position.set(0.26, -0.21, -0.42);
  weapon.rotation.set(-0.2, 0.12, 0.0);
  const fill = new THREE.PointLight(0xfff2dd, 2.6, 2.2, 1.5);
  fill.position.set(-0.15, 0.25, 0.15);
  camera.add(fill);
  camera.add(weapon);
}
scene.add(camera);
const flashLight = new THREE.PointLight(0xffffff, 0, 24, 1.4);
scene.add(flashLight);

// ============================================================
// AUDIO (WebAudio, no assets)
// ============================================================
let AC = null;
function audio() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  return AC;
}
function sfxShutter() {
  const ctx = audio();
  const t = ctx.currentTime;
  // click
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.09, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.15));
  const src = ctx.createBufferSource(); src.buffer = buf;
  const g = ctx.createGain(); g.gain.value = 0.5;
  src.connect(g).connect(ctx.destination);
  src.start(t);
  // flash whine recharge
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(700, t + 0.05);
  o.frequency.exponentialRampToValueAtTime(3400, t + 0.85);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.045, t + 0.05);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  o.connect(og).connect(ctx.destination);
  o.start(t + 0.05); o.stop(t + 0.95);
}
function sfxRobotDie() {
  const ctx = audio(); const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.setValueAtTime(420, t);
  o.frequency.exponentialRampToValueAtTime(55, t + 0.5);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.6);
}
function sfxHurt() {
  const ctx = audio(); const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.25);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.15, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.35);
}
let doorHum = null;
function sfxDoorStart() {
  const ctx = audio();
  if (doorHum) return;
  const o = ctx.createOscillator();
  o.type = 'sawtooth'; o.frequency.value = 65;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 13;
  const lg = ctx.createGain(); lg.gain.value = 8;
  lfo.connect(lg).connect(o.frequency);
  const g = ctx.createGain(); g.gain.value = 0.05;
  o.connect(g).connect(ctx.destination);
  o.start(); lfo.start();
  doorHum = { o, lfo, g };
}
function sfxDoorStop() {
  if (!doorHum) return;
  doorHum.g.gain.exponentialRampToValueAtTime(0.0001, audio().currentTime + 0.2);
  const d = doorHum;
  setTimeout(() => { d.o.stop(); d.lfo.stop(); }, 300);
  doorHum = null;
}
function sfxRound() {
  const ctx = audio(); const t = ctx.currentTime;
  [440, 554, 659].forEach((f, i) => {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.09, t + i * 0.12 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.4);
    o.connect(g).connect(ctx.destination);
    o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.45);
  });
}

// ============================================================
// ENEMIES
// ============================================================
let robotGltf = null;
const enemies = [];

loadModel('./models/RobotExpressive.glb', g => { robotGltf = g; });

const TIER_COLORS = [null, 0xffffff, 0xffa54d, 0xff5544];  // 1..3

function spawnEnemy(doorDef, tier) {
  if (!robotGltf) return null;
  const model = SkeletonUtils.clone(robotGltf.scene);
  model.scale.setScalar(0.38);
  model.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      o.material = o.material.clone();
      if (tier > 1) o.material.color.multiply(new THREE.Color(TIER_COLORS[tier]));
    }
  });
  const zc = (doorDef.z0 + doorDef.z1) / 2 + rnd(-1.2, 1.2);
  model.position.set(rnd(-9.5, -7.5), 0, zc);
  scene.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of robotGltf.animations) actions[clip.name] = mixer.clipAction(clip);
  actions.Running.play();

  const e = {
    kind: 'robot',
    model, mixer, actions, tier,
    hp: tier, maxHp: tier,
    speed: rnd(1.5, 2.1) + game.round * 0.12,
    state: 'enter',
    doorZ: (doorDef.z0 + doorDef.z1) / 2,
    attackCd: 0, stun: 0, deadT: 0,
    cur: 'Running',
  };
  enemies.push(e);
  return e;
}

// goofy waddling enemy with the giant 2D cartoon face
function spawnFaceEnemy(doorDef, tier, boss = false) {
  const bodyCol = boss ? 0x7a1fb8 : [0, 0x2a9d8f, 0xdd8833, 0xcc3344][tier];
  const bMat = new THREE.MeshStandardMaterial({ color: bodyCol, roughness: 0.7 });
  const dMat = new THREE.MeshStandardMaterial({ color: 0x24404a, roughness: 0.8 });
  const root = new THREE.Group();
  const rig = new THREE.Group();
  root.add(rig);
  if (boss) {
    // hulking armoured brute: broad plated torso, shoulder pads, spiked crown, glowing core
    const plate = new THREE.MeshStandardMaterial({
      color: 0x3a1050, roughness: 0.35, metalness: 0.75,
      emissive: 0x2a0044, emissiveIntensity: 0.5,
    });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.66, 0.4), plate);
    torso.position.y = 0.72; torso.castShadow = true; rig.add(torso);
    const belly = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.26, 0.36), bMat);
    belly.position.y = 0.36; belly.castShadow = true; rig.add(belly);
    // glowing reactor core in the chest
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0xff40ff, emissive: 0xff30ff, emissiveIntensity: 3.2 }));
    core.position.set(0, 0.74, 0.21); rig.add(core);
    root.userData.core = core;
    // shoulder pads with spikes
    for (const s of [-1, 1]) {
      const pad = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), plate);
      pad.scale.set(1, 0.75, 1);
      pad.position.set(s * 0.4, 0.98, 0); pad.castShadow = true; rig.add(pad);
      for (let i = 0; i < 3; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 6),
          new THREE.MeshStandardMaterial({ color: 0xd8d0e8, metalness: 0.9, roughness: 0.25 }));
        spike.position.set(s * (0.32 + i * 0.06), 1.1, -0.12 + i * 0.12);
        spike.rotation.z = s * 0.5; rig.add(spike);
      }
    }
    // spiked crown above the face
    for (let i = 0; i < 7; i++) {
      const a = (i / 6 - 0.5) * 2.1;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.3, 6),
        new THREE.MeshStandardMaterial({ color: 0xb050ff, emissive: 0x6a1090, emissiveIntensity: 1.2, metalness: 0.7, roughness: 0.3 }));
      spike.position.set(Math.sin(a) * 0.52, 1.72 + Math.cos(a) * 0.14, -0.05);
      spike.rotation.z = -a; rig.add(spike);
    }
    // heavy hip armour
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.2, 0.38), plate);
    hips.position.y = 0.22; rig.add(hips);
  } else {
    // stubby body
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.27, 0.55, 12), bMat);
    body.position.y = 0.58; body.castShadow = true; rig.add(body);
  }
  // flailing arm pivots at the shoulders
  function limb(x, y, len, mat, r = 0.05) {
    const piv = new THREE.Group();
    piv.position.set(x, y, 0);
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, len, 8), mat);
    seg.position.y = -len / 2;
    seg.castShadow = true;
    piv.add(seg);
    rig.add(piv);
    return piv;
  }
  const armL = boss ? limb(-0.46, 0.92, 0.62, bMat, 0.085) : limb(-0.3, 0.82, 0.42, bMat);
  const armR = boss ? limb(0.46, 0.92, 0.62, bMat, 0.085) : limb(0.3, 0.82, 0.42, bMat);
  const legL = boss ? limb(-0.18, 0.24, 0.26, dMat, 0.1) : limb(-0.11, 0.32, 0.32, dMat);
  const legR = boss ? limb(0.18, 0.24, 0.26, dMat, 0.1) : limb(0.11, 0.32, 0.32, dMat);
  // comically oversized 2D face
  const head = new THREE.Mesh(new THREE.PlaneGeometry(boss ? 1.25 : 0.95, boss ? 1.25 : 0.95),
    new THREE.MeshBasicMaterial({
      map: faceTexes[(Math.random() * faceTexes.length) | 0],
      transparent: true, side: THREE.DoubleSide,
    }));
  head.position.y = boss ? 1.62 : 1.42;
  rig.add(head);
  const zc = (doorDef.z0 + doorDef.z1) / 2 + rnd(-1.2, 1.2);
  if (boss) {
    // bosses climb the porch steps and come in the back way
    root.position.set(rnd(7.4, 8.2), 0, 0.15 + rnd(-0.4, 0.4));
    rearTarget = 1;
  } else {
    root.position.set(rnd(-9.5, -7.5), 0, zc);
  }
  if (boss) {
    root.scale.setScalar(1.75);
    // menacing glow so you can pick the boss out of a crowd
    const aura = new THREE.PointLight(0xd040ff, 8, 9, 1.5);
    aura.position.y = 1.1;
    root.add(aura);
  }
  scene.add(root);
  const e = {
    kind: 'face', boss,
    model: root, rig, armL, armR, legL, legR, head,
    mats: [bMat, dMat], hitFlash: 0,
    mixer: null, actions: null, tier,
    hp: boss ? 14 + game.round * 2 : tier + 1,
    maxHp: boss ? 14 + game.round * 2 : tier + 1,
    speed: boss ? 1.5 + game.round * 0.05 : rnd(1.8, 2.4) + game.round * 0.12,
    state: 'enter',
    doorZ: (doorDef.z0 + doorDef.z1) / 2,
    attackCd: 0, stun: 0, deadT: 0, t: rnd(0, 6),
    cur: '',
    y: 0, vy: 0, grounded: true, jumpCd: 0,
  };
  enemies.push(e);
  if (boss) showToast('!!! A BOSS CAME THROUGH THE DOOR !!!', 3000);
  return e;
}
// ---------- Patrick: a proper animated brawler ----------
let patrickGltf = null;
loadModel('./models/patrick/scene.gltf', g => {
  patrickGltf = g;
  console.log('Patrick loaded —', g.animations.length, 'clips');
});

function patrickPlay(e, key) {
  if (!e.actions || e.cur === key) return;
  const next = e.actions[key];
  if (!next) return;
  const prev = e.actions[e.cur];
  next.reset().play();
  if (prev && prev !== next) next.crossFadeFrom(prev, 0.18, false);
  e.cur = key;
}

// SpongeBob himself, bursting out of the staff room on round 4
function spawnSpongeEnemy() {
  if (!spongeGltf) return null;
  const model = SkeletonUtils.clone(spongeGltf.scene);
  model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

  model.scale.setScalar(1);
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  const bind = new THREE.Box3();
  model.traverse(o => {
    if (o.isMesh) {
      o.geometry.computeBoundingBox();
      bind.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  });
  const size = bind.getSize(new THREE.Vector3());
  const s = 1.6 / Math.max(size.y, 0.001);
  model.scale.setScalar(s);
  model.position.y = -bind.min.y * s;

  const root = new THREE.Group();
  root.add(model);
  root.position.set(-0.85, 0, 9.6);        // just inside the staff room doorway
  scene.add(root);

  const mixer = new THREE.AnimationMixer(model);
  if (spongeGltf.animations && spongeGltf.animations.length) {
    mixer.clipAction(spongeGltf.animations[0]).play();
  }

  // the clip carries root motion, so settle him using the POSED skeleton
  mixer.update(0);
  model.updateMatrixWorld(true);
  let skinned = null;
  model.traverse(o => { if (o.isSkinnedMesh) skinned = skinned || o; });
  let headY = 1.32;
  if (skinned && skinned.skeleton) {
    let minY = Infinity, maxY = -Infinity;
    const v = new THREE.Vector3();
    for (const b of skinned.skeleton.bones) {
      v.setFromMatrixPosition(b.matrixWorld);
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
    if (isFinite(minY)) {
      model.position.y -= minY - 0.02;          // feet on the floor
      headY = (maxY - minY) * 0.86 + 0.02;      // head sits near the top
    }
  }

  const head = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6),
    new THREE.MeshBasicMaterial({ visible: false }));
  head.position.y = headY;
  root.add(head);

  const mats = [];
  model.traverse(o => { if (o.isMesh && o.material) { o.material = o.material.clone(); mats.push(o.material); } });

  // an angry yellow glow so he reads as hostile, not scenery
  const aura = new THREE.PointLight(0xffd83a, 6, 7, 1.6);
  aura.position.y = 1.1;
  root.add(aura);

  const e = {
    kind: 'sponge',
    model: root, head, mixer, actions: null, mats, hitFlash: 0,
    tier: 3,
    hp: 16 + game.round, maxHp: 16 + game.round,
    speed: 2.3 + game.round * 0.06,
    state: 'enter',
    doorZ: 9.6,
    attackCd: 0, stun: 0, deadT: 0, t: 0,
    cur: '',
    y: 0, vy: 0, grounded: true, jumpCd: 0,
  };
  enemies.push(e);
  showToast('!!! HE CAME OUT OF THE STAFF ROOM !!!', 3200);
  return e;
}

function spawnPatrickEnemy(doorDef, tier) {
  if (!patrickGltf) return spawnFaceEnemy(doorDef, tier);
  const model = SkeletonUtils.clone(patrickGltf.scene);
  model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

  // measure the bind pose (setFromObject is unreliable on skinned meshes)
  model.scale.setScalar(1);
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  const bind = new THREE.Box3();
  model.traverse(o => {
    if (o.isMesh) {
      o.geometry.computeBoundingBox();
      bind.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  });
  const size = bind.getSize(new THREE.Vector3());
  const s = 1.55 / Math.max(size.y, 0.001);
  model.scale.setScalar(s);
  model.position.y = -bind.min.y * s;

  const root = new THREE.Group();
  root.add(model);
  const zc = (doorDef.z0 + doorDef.z1) / 2 + rnd(-1.2, 1.2);
  root.position.set(rnd(-9.5, -7.5), 0, zc);
  scene.add(root);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  const pick = frag => patrickGltf.animations.find(c => c.name.includes(frag));
  const map = { Run: 'Run_v2', Idle: 'Idle_v2', LightCombo1: 'LightCombo1',
                Hit: 'Hit_v2', Fall: 'Fall_v2' };
  for (const k in map) {
    const clip = pick(map[k]);
    if (clip) actions[k] = mixer.clipAction(clip);
  }
  if (actions.Fall) { actions.Fall.setLoop(THREE.LoopOnce); actions.Fall.clampWhenFinished = true; }

  // an invisible plane standing in for the head, so headshots work
  const head = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5),
    new THREE.MeshBasicMaterial({ visible: false }));
  head.position.y = 1.34;
  root.add(head);

  const mats = [];
  model.traverse(o => { if (o.isMesh && o.material) { o.material = o.material.clone(); mats.push(o.material); } });

  const e = {
    kind: 'patrick',
    yawOffset: Math.PI / 2,          // his rig faces -X, not +Z
    model: root, head, mixer, actions, mats, hitFlash: 0,
    tier,
    hp: 4 + tier, maxHp: 4 + tier,
    speed: rnd(2.0, 2.6) + game.round * 0.1,
    state: 'enter',
    doorZ: (doorDef.z0 + doorDef.z1) / 2,
    attackCd: 0, stun: 0, deadT: 0, t: 0,
    cur: '',
    y: 0, vy: 0, grounded: true, jumpCd: 0,
  };
  patrickPlay(e, 'Run');
  enemies.push(e);
  return e;
}

// ---------- caterpillar: crawls low, sheds a segment every hit ----------
function spawnWormEnemy(doorDef, tier) {
  const root = new THREE.Group();
  const segMat = new THREE.MeshStandardMaterial({
    color: [0, 0x86c33a, 0xd8a02c, 0xc0392b][tier] || 0x86c33a, roughness: 0.75 });
  const footMat = new THREE.MeshStandardMaterial({ color: 0x2f4a1e, roughness: 0.9 });

  // head group carries the face billboard and antennae
  const headGrp = new THREE.Group();
  headGrp.position.y = 0.42;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 12), segMat);
  skull.castShadow = true;
  headGrp.add(skull);
  const head = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62),
    new THREE.MeshBasicMaterial({ map: wormFaceTex, transparent: true, side: THREE.DoubleSide }));
  head.position.set(0, 0.1, 0.3);
  headGrp.add(head);
  for (const sx of [-1, 1]) {
    const a = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 5), footMat);
    a.position.set(sx * 0.14, 0.28, 0);
    a.rotation.z = sx * 0.45;
    headGrp.add(a);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), segMat);
    tip.position.set(sx * 0.24, 0.42, 0);
    headGrp.add(tip);
  }
  root.add(headGrp);

  // body segments trail behind the head
  const segCount = 6 + tier;
  const segs = [];
  for (let i = 0; i < segCount; i++) {
    const g = new THREE.Group();
    const r = 0.26 - i * 0.012;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), segMat);
    ball.castShadow = true;
    g.add(ball);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.02, 0.2, 6), footMat);
      leg.position.set(sx * r * 0.8, -r * 0.8, 0);
      leg.rotation.z = sx * 0.5;
      g.add(leg);
    }
    g.position.set(0, 0.3, -(i + 1) * 0.34);
    root.add(g);
    segs.push(g);
  }

  const zc = (doorDef.z0 + doorDef.z1) / 2 + rnd(-1.2, 1.2);
  root.position.set(rnd(-9.5, -7.5), 0, zc);
  root.rotation.y = Math.PI / 2;          // already pointed at the door it walks in through
  scene.add(root);

  const e = {
    kind: 'worm',
    model: root, headGrp, head, segs, chain: null,
    mats: [segMat, footMat], hitFlash: 0,
    mixer: null, actions: null, tier,
    hp: segCount, maxHp: segCount,
    speed: rnd(1.3, 1.7) + game.round * 0.07,
    state: 'enter',
    doorZ: (doorDef.z0 + doorDef.z1) / 2,
    attackCd: 0, stun: 0, deadT: 0, t: rnd(0, 6),
    cur: '',
    y: 0, vy: 0, grounded: true, jumpCd: 0,
  };
  enemies.push(e);
  return e;
}

// keep the body length matched to remaining hp
function syncWormLength(e) {
  while (e.segs.length > Math.max(0, e.hp)) {
    const g = e.segs.pop();
    const p = new THREE.Vector3();
    g.getWorldPosition(p);
    spawnSparks(p, 0x9ade6a, 10, 1.0);
    e.model.remove(g);
  }
}

// Everything else can spin on the spot, but a caterpillar can't — cap its turn
// rate so its body always has time to follow the head round.
const WORM_TURN = 3.0;   // rad/s
function aimEnemy(e, wantYaw, dt) {
  if (e.kind !== 'worm') { e.model.rotation.y = wantYaw; return; }
  let d = wantYaw - e.model.rotation.y;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const max = WORM_TURN * dt;
  e.model.rotation.y += Math.max(-max, Math.min(max, d));
}

// Slither. The body is a world-space chain of links, each held exactly one
// spacing behind the link in front of it, so it can neither stretch nor bunch
// up. Each link also leans toward "directly behind the one ahead", which is
// what sweeps the body round when the head turns on the spot — without it the
// body stays where it was and the face ends up at the back of the caterpillar.
const WORM_SPACING = 0.34;
function wormCrawl(e, dt) {
  e.t += dt * e.speed * 3.2;
  const hp = e.model.position;
  const yaw = e.model.rotation.y;

  // lay the chain out behind the head the first time through
  if (!e.chain) {
    e.chain = [];
    for (let i = 0; i < e.segs.length; i++)
      e.chain.push(new THREE.Vector3(
        hp.x - Math.sin(yaw) * WORM_SPACING * (i + 1), 0,
        hp.z - Math.cos(yaw) * WORM_SPACING * (i + 1)));
  }
  while (e.chain.length > e.segs.length) e.chain.pop();   // shot segments fall off the tail

  // Every link eases toward the SAME target — straight back from the face. Chase
  // the link in front instead and the correction has to cascade down all eight
  // segments, which winds the body into a spiral before it unwinds.
  const backX = -Math.sin(yaw), backZ = -Math.cos(yaw);
  const sweep = Math.min(1, dt * 3.5);
  let px = hp.x, pz = hp.z;
  for (let i = 0; i < e.chain.length; i++) {
    const c = e.chain[i];
    let dx = c.x - px, dz = c.z - pz;
    let len = Math.hypot(dx, dz);
    if (len < 1e-4) { dx = backX; dz = backZ; len = 1; }
    dx /= len; dz /= len;
    dx += (backX - dx) * sweep;
    dz += (backZ - dz) * sweep;
    len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    c.set(px + dx * WORM_SPACING, 0, pz + dz * WORM_SPACING);
    px = c.x; pz = c.z;
  }

  // three.js rotates local->world as (x cosY + z sinY, -x sinY + z cosY), so the
  // inverse takes +yaw here. Negating it rotated the body by 2*yaw instead of
  // leaving it put — which is why the head landed on the rear at some headings.
  const a = yaw, ca = Math.cos(a), sa = Math.sin(a);
  for (let i = 0; i < e.segs.length; i++) {
    const c = e.chain[i];
    const seg = e.segs[i];
    // the chain is world-space; rotate it into the (yawed) root's local frame
    const lx = c.x - hp.x, lz = c.z - hp.z;
    seg.position.x = lx * ca - lz * sa;
    seg.position.z = lx * sa + lz * ca;
    seg.position.y = 0.3 + Math.abs(Math.sin(e.t - i * 0.7)) * 0.16;   // inchworm hump
    seg.rotation.z = Math.sin(e.t - i * 0.7) * 0.25;
  }
  e.headGrp.position.y = 0.42 + Math.sin(e.t) * 0.1;
  e.headGrp.rotation.z = Math.sin(e.t * 0.8) * 0.12;
  // the face turns to you so it can be seen and shot from any side
  const fw = new THREE.Vector3();
  e.head.getWorldPosition(fw);
  const toCam = Math.atan2(camera.position.x - fw.x, camera.position.z - fw.z);
  const ang = toCam - e.model.rotation.y;
  e.head.rotation.y = ang;
  e.head.position.set(Math.sin(ang) * 0.3, 0.1, Math.cos(ang) * 0.3);
}

function faceWaddle(e, dt, fast = 1) {
  e.t += dt * e.speed * 2.4 * fast;
  // boss chest core throbs
  const bc = e.model.userData.core;
  if (bc) bc.material.emissiveIntensity = 2.4 + Math.sin(e.t * 3) * 1.4;
  e.armL.rotation.x = Math.sin(e.t) * 1.0 * fast;
  e.armR.rotation.x = -Math.sin(e.t) * 1.0 * fast;
  e.legL.rotation.x = -Math.sin(e.t) * 0.75;
  e.legR.rotation.x = Math.sin(e.t) * 0.75;
  e.head.rotation.z = Math.sin(e.t * 0.6) * 0.16;
  e.rig.position.y = Math.abs(Math.sin(e.t)) * 0.07;
}
function enemyPlay(e, name, once = false) {
  if (!e.actions || e.kind === 'patrick') return;   // patrick has its own clip names
  if (e.cur === name) return;
  const prev = e.actions[e.cur];
  const next = e.actions[name];
  if (!next) return;                                // this rig doesn't have that clip
  next.reset();
  if (once) { next.setLoop(THREE.LoopOnce); next.clampWhenFinished = true; }
  if (prev) next.crossFadeFrom(prev, 0.18, false);
  next.play();
  e.cur = name;
}

function updateEnemy(e, dt) {
  if (e.mixer) e.mixer.update(dt);
  // decay the white hit-flash back to the body colour
  if (e.hitFlash > 0) {
    e.hitFlash = Math.max(0, e.hitFlash - dt * 5);
    if (e.mats) for (const m of e.mats) {
      m.emissiveIntensity = e.hitFlash * 1.4;
      if (e.hitFlash === 0 && m.userData.baseEmissive) m.emissive.copy(m.userData.baseEmissive);
    }
  }
  if (e.kind === 'worm') syncWormLength(e);
  if (e.state === 'dying') {
    e.deadT += dt;
    if (e.kind === 'face') e.rig.rotation.x = -Math.min(Math.PI / 2, e.deadT * 2.6);
    if (e.kind === 'patrick') patrickPlay(e, 'Fall');
    if (e.kind === 'worm') {
      e.headGrp.rotation.z = Math.min(Math.PI / 2, e.deadT * 3);
      e.headGrp.position.y = Math.max(0.16, 0.42 - e.deadT * 0.5);
    }
    if (e.deadT > 1.6) {
      e.model.position.y -= dt * 0.7;
      e.model.traverse(o => { if (o.isMesh) { o.material.transparent = true; o.material.opacity = Math.max(0, 1 - (e.deadT - 1.6)); } });
    }
    if (e.deadT > 2.6) {
      scene.remove(e.model);
      e.gone = true;
    }
    return;
  }
  // enemy gravity / landing on furniture
  if (e.y !== undefined) {
    e.vy -= GRAVITY * dt;
    e.y += e.vy * dt;
    const px = e.model.position.x, pz = e.model.position.z;
    const g = (px > -6 && px < 6 && pz > -9 && pz < 9) ? supportHeight(px, pz, 0.3) : 0;
    if (e.y <= g) { e.y = g; e.vy = 0; e.grounded = true; }
    else e.grounded = false;
    e.model.position.y = e.y;
  }

  if (e.stun > 0) { e.stun -= dt; return; }

  const p = e.model.position;
  let target;
  if (e.state === 'annex') {
    // walk out of the rainbow annex, across the bridge, and into the main hall
    if (p.x > MIRROR.x0 - 0.5) target = new THREE.Vector3(MIRROR.x0 - 1.0, 0, MIRROR.bz);
    else if (p.x > 6.4) target = new THREE.Vector3(6.2, 0, 0.15);
    else { e.state = 'chase'; target = player.pos.clone(); }
  } else if (e.state === 'enter') {
    if (e.kind === 'sponge') {
      target = new THREE.Vector3(-0.85, 0, 7.9);       // out through the staff room door
      if (p.z < 8.4) { e.state = 'chase'; staffTarget = 0; }
    } else if (e.boss) {
      target = new THREE.Vector3(4.6, 0, 0.15);        // in through the rear doors
      if (p.x < 5.2) { e.state = 'chase'; rearTarget = 0; }
    } else {
      target = new THREE.Vector3(-4.8, 0, e.doorZ);
      if (p.x > -5.5) e.state = 'chase';
    }
  } else {
    target = player.pos.clone();
  }
  const dir = target.sub(p); dir.y = 0;
  const dist = dir.length();
  const playerDist = p.distanceTo(player.pos);

  if (e.state !== 'enter' && playerDist < 1.55) {
    // attack — face the player, allowing for models whose forward axis isn't +Z
    aimEnemy(e, Math.atan2(player.pos.x - p.x, player.pos.z - p.z) + (e.yawOffset || 0), dt);
    enemyPlay(e, 'Punch', true);
    if (e.kind === 'face') faceWaddle(e, dt, 2.2);   // frantic arm flailing
    else if (e.kind === 'worm') wormCrawl(e, dt);    // rears up and lunges
    else if (e.kind === 'patrick') patrickPlay(e, 'LightCombo1');
    e.attackCd -= dt;
    if (e.attackCd <= 0) {
      e.attackCd = 1.1;
      damagePlayer(9 + e.tier * 3);
    }
    if (e.actions && e.actions.Punch && e.actions.Punch.paused) {
      e.cur = 'Idle'; enemyPlay(e, 'Punch', true);
    }
  } else if (dist > 0.05) {
    enemyPlay(e, 'Running');
    if (e.kind === 'face') faceWaddle(e, dt);
    else if (e.kind === 'worm') wormCrawl(e, dt);
    else if (e.kind === 'patrick') patrickPlay(e, 'Run');
    dir.normalize();
    // face movement
    aimEnemy(e, Math.atan2(dir.x, dir.z) + (e.yawOffset || 0), dt);
    // a worm steers like it has a body — it drives along its own heading and
    // arcs toward you instead of sliding sideways out from under its segments
    if (e.kind === 'worm') dir.set(Math.sin(e.model.rotation.y), 0, Math.cos(e.model.rotation.y));
    p.addScaledVector(dir, e.speed * dt);

    // hop over couches and tables instead of getting stuck on them
    if (e.jumpCd > 0) e.jumpCd -= dt;
    if (e.kind !== 'worm' && e.grounded && e.jumpCd <= 0 && p.x > -5.6) {
      const ahead = { x: p.x + dir.x * 0.75, z: p.z + dir.z * 0.75 };
      const obstacle = supportHeight(ahead.x, ahead.z, 0.28);
      if (obstacle > 0.15 && obstacle < 1.3) {
        e.vy = Math.sqrt(2 * GRAVITY * (obstacle + 0.45));   // just clears the top
        e.grounded = false;
        e.jumpCd = 0.7;
      }
    }
    // furniture separation only while on the ground and already inside
    if (e.state !== 'enter' && e.state !== 'annex' && p.x > -5.6 && p.x < 6 && e.grounded)
      resolveCircle(p, 0.4, e.y);
    // enemy separation
    for (const o of enemies) {
      if (o === e || o.state === 'dying') continue;
      const d = p.distanceTo(o.model.position);
      if (d < 0.7 && d > 0.001) {
        const push = p.clone().sub(o.model.position).normalize().multiplyScalar((0.7 - d) * 0.5);
        p.add(push);
      }
    }
  }
}

// ---------- headshots ----------
const _hsCenter = new THREE.Vector3(), _hsOC = new THREE.Vector3();
// world-space centre + radius of an enemy's face billboard
function headSphere(e, out) {
  if (e.head) {
    e.head.getWorldPosition(out);
    return 0.44 * (e.model.scale.x || 1);
  }
  out.copy(e.model.position);
  out.y += 1.35;
  return 0.4;
}
// does the ray from `origin` along `dir` pass through the head?
function isHeadshot(e, origin, dir) {
  if (!e.head) return false;
  const r = headSphere(e, _hsCenter);
  _hsOC.copy(_hsCenter).sub(origin);
  const t = _hsOC.dot(dir);
  if (t < 0) return false;                       // behind the camera
  const d2 = _hsOC.lengthSq() - t * t;
  return d2 <= r * r;
}
function headshotKill(e, origin) {
  const p = new THREE.Vector3();
  headSphere(e, p);
  sfxHeadshot();
  spawnSparks(p, 0xff4d6a, 26, 1.5);
  addShake(0.45);
  game.score += 150 * (e.boss ? 6 : 1);
  showToast('HEADSHOT', 1400);
  e.hp = 0;
  killEnemy(e);
}

// white-hot pop when something takes a hit
function flashEnemy(e) {
  if (e.hitFlash < 0.6) sfxEnemyHit();   // don't stack on rapid-fire hits
  e.hitFlash = 1;
  if (e.mats) for (const m of e.mats) {
    if (!m.userData.baseEmissive) m.userData.baseEmissive = m.emissive.clone();
    m.emissive.setHex(0xffffff);
    m.emissiveIntensity = 1.4;
  }
}
// burst of glowing sparks at a point
const sparks = [];
function spawnSparks(pos, color = 0xffd27a, n = 14, power = 1) {
  for (let i = 0; i < n; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(rnd(0.02, 0.05), 6, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true }));
    s.position.copy(pos);
    s.userData.v = new THREE.Vector3(rnd(-1, 1), rnd(0.3, 1), rnd(-1, 1))
      .normalize().multiplyScalar(rnd(1.5, 4.5) * power);
    s.userData.ttl = rnd(0.35, 0.8);
    s.userData.life = s.userData.ttl;
    scene.add(s);
    sparks.push(s);
  }
}

function killEnemy(e) {
  e.state = 'dying';
  enemyPlay(e, 'Death', true);
  sfxRobotDie();
  addShake(e.boss ? 0.9 : 0.28);
  const burst = e.model.position.clone(); burst.y += 1.0;
  spawnSparks(burst, 0xfff0c0, e.boss ? 46 : 20, e.boss ? 2 : 1.2);
  if (e.kind === 'face') sfxHurt();   // extra squawk for the face goblin
  game.kills++;
  game.score += 100 * e.tier * (e.boss ? 8 : 1);
  if (e.boss) { game.bossOut = false; rearTarget = 0; showToast('BOSS DELETED', 2400); }
}

function damagePlayer(dmg) {
  if (!player.alive || game.state !== 'wave') return;
  if (player.invulnT > 0) return;
  // the shield eats what it can before any of it reaches your health
  if (player.shield > 0) {
    const soaked = Math.min(player.shield, dmg);
    player.shield -= soaked;
    dmg -= soaked;
    refreshShield();
    sfxShield();
    shieldFx.classList.remove('hit');
    void shieldFx.offsetWidth;
    shieldFx.classList.add('hit');
    addShake(0.35);
    if (dmg <= 0) return;                 // fully absorbed
  }
  player.hp -= dmg;
  sfxHurt();
  addShake(0.85);
  gradePass.uniforms.uDamage.value = 1;
  dmgFx.style.opacity = 1;
  setTimeout(() => dmgFx.style.opacity = 0, 260);
  if (player.hp <= 0) {
    player.hp = 0;
    if (game.lives > 0) { useExtraLife(); return; }
    player.alive = false;
    gameOver();
  }
}

// spend a 1-UP mushroom instead of dying
function useExtraLife() {
  game.lives--;
  refreshLives();
  player.hp = 100;
  player.invulnT = 3;
  sfx1up();
  addShake(1.1);
  flashFx.style.opacity = 0.6;
  setTimeout(() => flashFx.style.opacity = 0, 260);
  // shove everything nearby off you so you don't get instantly re-killed
  for (const e of enemies) {
    if (e.state === 'dying') continue;
    const away = e.model.position.clone().sub(player.pos).setY(0);
    if (away.lengthSq() < 0.001) away.set(1, 0, 0);
    e.model.position.addScaledVector(away.normalize(), 1.6);
    e.stun = Math.max(e.stun || 0, 0.8);
  }
  showToast('🍄 EXTRA LIFE! 3s of invincibility', 3000);
}

// ============================================================
// WEAPONS — camera, LARP foam sword, tennis racket, SD card shuriken
// ============================================================
const FLASH_MAG = 2;        // shots before the reload
const FLASH_GAP = 0.18;     // beat between the two, so it reads as two pops
const FLASH_RELOAD = 0.85;  // wind-up once both are gone
const WEAPONS = [
  { id: 'camera', name: 'FLASH CAMERA', melee: false, cd: 0.55 },
  { id: 'sword', name: 'LARP FOAM SWORD', melee: true, cd: 0.42, reach: 2.6, arc: 0.85, dmg: 2 },
  { id: 'racket', name: 'TENNIS RACKET', melee: true, cd: 0.5, reach: 2.4, arc: 0.7, dmg: 1 },
  { id: 'sdcard', name: 'SD CARD SHURIKEN', melee: false, cd: 0.22 },
  // unlocked from a mystery box — sits alongside the camera, doesn't replace it
  { id: 'camcorder', name: 'LASER CAMCORDER', melee: false, cd: 0.09, locked: true },
];
let curWeapon = 0;
let swingT = 0;          // melee swing animation clock
let attackCd = 0;
const weaponModels = {};

function buildSword() {
  const g = new THREE.Group();
  // duct-taped foam blade
  const foam = new THREE.MeshStandardMaterial({ color: 0x9fb6d6, roughness: 0.95 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.055, 0.85), foam);
  blade.position.z = -0.5; g.add(blade);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), foam);
  tip.scale.z = 1.6; tip.position.z = -0.93; g.add(tip);
  const tape = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.7, metalness: 0.15 });
  for (const z of [-0.2, -0.55, -0.85]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.092, 0.062, 0.05), tape);
    band.position.z = z; g.add(band);
  }
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x7a4a22, roughness: 0.8 }));
  guard.position.z = -0.06; g.add(guard);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.24, 10),
    new THREE.MeshStandardMaterial({ color: 0x241c16, roughness: 0.95 }));
  grip.rotation.x = Math.PI / 2; grip.position.z = 0.1; g.add(grip);
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x8a6a30, roughness: 0.5, metalness: 0.6 }));
  pommel.position.z = 0.23; g.add(pommel);
  return g;
}

function buildRacket() {
  const g = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xe8e832, roughness: 0.4, metalness: 0.35 });
  const head = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 8, 26), frameMat);
  head.scale.set(1, 1.32, 1);
  head.position.z = -0.62; g.add(head);
  // string bed
  const strMat = new THREE.MeshBasicMaterial({ color: 0xf2f2ee, transparent: true, opacity: 0.75 });
  for (let i = -3; i <= 3; i++) {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.48, 0.006), strMat);
    v.position.set(i * 0.048, 0, -0.62); g.add(v);
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.006, 0.006), strMat);
    h.position.set(0, i * 0.062, -0.62); g.add(h);
  }
  for (const s of [-1, 1]) {
    const throat = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.022, 0.2), frameMat);
    throat.position.set(s * 0.07, -0.17, -0.47);
    throat.rotation.x = 0.25; g.add(throat);
  }
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x1e2226, roughness: 0.95 }));
  handle.position.z = -0.2; g.add(handle);
  const butt = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.03), frameMat);
  butt.position.z = -0.04; g.add(butt);
  return g;
}

// ---------- SD card shuriken ----------
let sdcardProto = null;
const sdcards = [];
loadModel('./models/sdcard/scene.gltf', g => {
  const m = g.scene;
  m.updateMatrixWorld(true);
  const bb = new THREE.Box3();
  m.traverse(o => {
    if (o.isMesh) {
      o.geometry.computeBoundingBox();
      bb.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  });
  const size = bb.getSize(new THREE.Vector3());
  const s = 0.26 / Math.max(size.x, size.y, size.z, 0.001);   // ~26cm across
  m.scale.setScalar(s);
  const c = bb.getCenter(new THREE.Vector3()).multiplyScalar(s);
  m.position.sub(c);                                           // centre it for spinning
  const holder = new THREE.Group();
  holder.add(m);
  sdcardProto = holder;
  // stack a few in the off hand as the held view model
  if (weaponModels.sdcard) {
    for (let i = 0; i < 3; i++) {
      const c = holder.clone();
      c.position.set(i * 0.008, i * 0.011, i * 0.014);
      c.rotation.set(0.5, 0.2 + i * 0.1, 0.2);
      c.scale.setScalar(0.72);
      weaponModels.sdcard.add(c);
    }
  }
  console.log('SD card loaded');
});

function throwSdCard() {
  if (!sdcardProto) return;
  addShake(0.12);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const card = sdcardProto.clone();
  card.position.copy(camera.position).addScaledVector(fwd, 0.55).add(new THREE.Vector3(0, -0.12, 0));
  scene.add(card);
  // spin axis roughly perpendicular to the throw, like a flicked card
  const up = new THREE.Vector3(0, 1, 0);
  const axis = new THREE.Vector3().crossVectors(fwd, up).normalize();
  sdcards.push({
    mesh: card,
    v: fwd.clone().multiplyScalar(24),
    spin: axis, spinRate: 26, ttl: 3,
  });
}

function sfxSwing() {
  const ctx = audio(); const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.22, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const k = i / d.length;
    d[i] = (Math.random() * 2 - 1) * Math.sin(k * Math.PI) * 0.5;
  }
  const src = ctx.createBufferSource(); src.buffer = buf;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.2);
  const g = ctx.createGain(); g.gain.value = 0.28;
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t);
}
function sfxWhack() {
  const ctx = audio(); const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(330, t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.14);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.2);
}
function sfxJump() {
  const ctx = audio(); const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(240, t);
  o.frequency.exponentialRampToValueAtTime(520, t + 0.11);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.06, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.15);
}

function selectWeapon(i) {
  const w = WEAPONS[i];
  if (!w || i === curWeapon) return;
  if (w.locked) { showToast('Locked — find it in a mystery box', 1800); return; }
  curWeapon = i;
  for (const k in weaponModels) weaponModels[k].visible = false;
  const slr = weapon.getObjectByName('camHolder');
  if (slr) slr.visible = w.id === 'camera';
  if (weaponModels[w.id]) weaponModels[w.id].visible = true;
  wepNameEl.textContent = w.name;
  swingT = 0;
}

// melee arc: hit everything in a wide cone in front
function meleeSwing() {
  const w = WEAPONS[curWeapon];
  swingT = 0.0001;
  sfxSwing();
  addShake(0.22);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  let hitAny = false;
  for (const e of enemies) {
    if (e.state === 'dying') continue;
    const to = e.model.position.clone(); to.y += 0.8 * (e.boss ? 1.6 : 1);
    to.sub(camera.position);
    const dist = to.length();
    if (dist > w.reach) continue;
    to.normalize();
    if (to.dot(fwd) < Math.cos(w.arc)) continue;
    hitAny = true;
    flashEnemy(e);
    // a clean swing to the face takes the head off
    if (isHeadshot(e, camera.position, fwd)) { headshotKill(e, camera.position); continue; }
    e.hp -= w.dmg * (game.arsenalT > 0 ? 2 : 1);
    e.stun = 0.3;
    spawnSparks(e.model.position.clone().setY(1.0), w.id === 'sword' ? 0x9fd8ff : 0xe8e832, 8, 0.8);
    // knockback
    const kb = e.model.position.clone().sub(camera.position).setY(0).normalize()
      .multiplyScalar(w.id === 'racket' ? 1.5 : 0.8);
    e.model.position.add(kb);
    if (e.hp <= 0) killEnemy(e);
  }
  // melee also smashes the mystery crate — and any computer in swing range
  if (damageCrate(camera.position.clone().addScaledVector(fwd, w.reach * 0.6),
                  w.reach * 0.75, 1)) hitAny = true;
  if (damageMac(camera.position.clone().addScaledVector(fwd, w.reach * 0.6),
                w.reach * 0.6, 2)) hitAny = true;
  if (damageSideDoor(camera.position.clone().addScaledVector(fwd, w.reach * 0.6),
                     w.reach * 0.8, 1)) hitAny = true;
  if (hitAny) sfxWhack();
}

// ---------- GTA-style weapon wheel ----------
const wheelEl = document.getElementById('wheel');
const wheelSvg = document.getElementById('wheelSvg');
const wheelLabel = document.getElementById('wheelLabel');
const wepNameEl = document.getElementById('wepName');
let wheelOpen = false, wheelPick = 0, wheelAngle = 0;

{
  const N = WEAPONS.length, R0 = 52, R1 = 150, gap = 0.045;
  const SHORT = ['CAMERA', 'SWORD', 'RACKET', 'SD CARDS', 'CAMCORDER'];
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2 - Math.PI / 2 + gap;
    const a1 = ((i + 1) / N) * Math.PI * 2 - Math.PI / 2 - gap;
    const P = (r, a) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d',
      `M ${P(R0, a0)} L ${P(R1, a0)} A ${R1} ${R1} 0 0 1 ${P(R1, a1)} L ${P(R0, a1)} A ${R0} ${R0} 0 0 0 ${P(R0, a0)} Z`);
    path.setAttribute('class', 'seg');
    path.dataset.i = i;
    path.addEventListener('mouseenter', () => setWheelPick(i));
    path.addEventListener('click', () => { setWheelPick(i); closeWheel(); });
    wheelSvg.appendChild(path);

    const am = (a0 + a1) / 2, rm = (R0 + R1) / 2;
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', (Math.cos(am) * rm).toFixed(1));
    label.setAttribute('y', (Math.sin(am) * rm + 6).toFixed(1));
    label.textContent = SHORT[i];
    wheelSvg.appendChild(label);
    const num = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    num.setAttribute('class', 'num');
    num.setAttribute('x', (Math.cos(am) * rm).toFixed(1));
    num.setAttribute('y', (Math.sin(am) * rm - 14).toFixed(1));
    num.textContent = String(i + 1);
    wheelSvg.appendChild(num);
  }
}
function setWheelPick(i) {
  if (WEAPONS[i] && WEAPONS[i].locked) {
    wheelLabel.textContent = WEAPONS[i].name + '  —  LOCKED';
    for (const s of wheelSvg.querySelectorAll('.seg')) s.classList.remove('on');
    return;
  }
  wheelPick = i;
  wheelLabel.textContent = WEAPONS[i].name;
  for (const s of wheelSvg.querySelectorAll('.seg')) s.classList.toggle('on', +s.dataset.i === i);
}
// grey out slots you haven't unlocked yet
function refreshWheelLocks() {
  for (const s of wheelSvg.querySelectorAll('.seg')) {
    s.classList.toggle('locked', !!(WEAPONS[+s.dataset.i] && WEAPONS[+s.dataset.i].locked));
  }
}
function openWheel() {
  if (wheelOpen || game.state === 'menu' || game.state === 'gameover') return;
  wheelOpen = true;
  wheelAngle = 0;
  wheelEl.style.display = 'flex';
  setWheelPick(curWeapon);
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeWheel() {
  if (!wheelOpen) return;
  wheelOpen = false;
  wheelEl.style.display = 'none';
  selectWeapon(wheelPick);
  canvas.requestPointerLock();
}

// build + mount the alternate weapon view models
{
  weaponModels.sword = buildSword();
  weaponModels.sword.scale.setScalar(0.8);
  weaponModels.sword.position.set(0.2, -0.26, 0.08);
  weaponModels.sword.rotation.set(0.16, -0.22, 0.22);

  weaponModels.racket = buildRacket();
  weaponModels.racket.scale.setScalar(0.66);
  weaponModels.racket.position.set(0.24, -0.28, 0.06);
  weaponModels.racket.rotation.set(0.18, -0.2, 0.26);

  // the SD card view model gets filled in once the gltf lands
  weaponModels.sdcard = new THREE.Group();
  weaponModels.sdcard.position.set(-0.04, -0.18, -0.34);
  weaponModels.sdcard.rotation.set(0.15, -0.3, 0.2);

  for (const k in weaponModels) {
    const m = weaponModels[k];
    m.visible = false;
    m.userData.rest = { pos: m.position.clone(), rot: m.rotation.clone() };
    weapon.add(m);
  }
  wepNameEl.textContent = WEAPONS[0].name;
  refreshWheelLocks();
}

// ============================================================
// MYSTERY BOX + LASER CAMCORDER UPGRADE
// ============================================================
let crate = null;
const debris = [];
const beams = [];
let mouseHeld = false;
let laserCd = 0;

function crateTexture() {
  const [c, ctx] = makeCanvas(256, 256);
  ctx.fillStyle = '#a97c44'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = `rgba(60,38,16,${0.25})`;
    ctx.fillRect(0, i * 64, 256, 3);
  }
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = `rgba(80,52,24,${rnd(0.1, 0.3)})`;
    ctx.lineWidth = rnd(0.5, 2);
    ctx.beginPath();
    const y = rnd(0, 256);
    ctx.moveTo(0, y); ctx.lineTo(256, y + rnd(-6, 6));
    ctx.stroke();
  }
  ctx.strokeStyle = '#4a2f12'; ctx.lineWidth = 14; ctx.strokeRect(7, 7, 242, 242);
  ctx.fillStyle = '#2f6f3a';
  ctx.font = 'bold 150px Georgia'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('?', 128, 138);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const crateMat = new THREE.MeshStandardMaterial({ map: crateTexture(), roughness: 0.85 });

function sfxThunk() {
  const ctx = audio(); const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.3, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.3);
}
function sfxLaser() {
  const ctx = audio(); const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = 'square';
  o.frequency.setValueAtTime(1200, t);
  o.frequency.exponentialRampToValueAtTime(240, t + 0.07);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.05, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.09);
}

function spawnCrate() {
  // drop somewhere open in the room, biased toward the player so it's findable
  let x = 0, z = 0;
  for (let i = 0; i < 24; i++) {
    x = Math.max(-5, Math.min(5, player.pos.x + rnd(-5, 5)));
    z = Math.max(-8, Math.min(8, player.pos.z + rnd(-5, 5)));
    if (supportHeight(x, z, 0.45) < 0.15) break;         // clear of furniture
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), crateMat);
  mesh.position.set(x, 3.2, z);
  mesh.castShadow = true;
  scene.add(mesh);
  crate = { mesh, vy: 0, landed: false, hp: 2, beam: null };
  // a glowing marker beam so you can spot where it landed
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.34, 5, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x8fe36a, transparent: true, opacity: 0.10,
                                  side: THREE.BackSide, depthWrite: false }));
  beam.position.set(x, 2.5, z);
  scene.add(beam);
  crate.beam = beam;
  showToast('MYSTERY BOX DROPPED — FLASH IT OPEN', 3000);
}

// every weapon routes crate damage through here so they all crack it open
function damageCrate(point, radius = 2.2, amount = 1) {
  if (!crate || !crate.landed) return false;
  if (crate.mesh.position.distanceTo(point) > radius) return false;
  crate.hp -= amount;
  crate.mesh.rotation.y += 0.35;
  spawnSparks(crate.mesh.position.clone().setY(0.55), 0xd8a860, 10, 0.9);
  addShake(0.2);
  if (crate.hp <= 0) breakCrate();
  return true;
}

function breakCrate() {
  // wooden shrapnel
  for (let i = 0; i < 10; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(rnd(0.08, 0.18), 0.03, rnd(0.08, 0.18)), crateMat);
    p.position.copy(crate.mesh.position);
    p.userData.v = new THREE.Vector3(rnd(-2, 2), rnd(2, 5), rnd(-2, 2));
    p.userData.ttl = 1.3;
    scene.add(p);
    debris.push(p);
  }
  const from = crate.mesh.position.clone();
  scene.remove(crate.mesh);
  if (crate.beam) scene.remove(crate.beam);
  crate = null;
  sfxRound();
  // Smash-Bros style: the prize launches out and lands on the floor.
  // Nothing happens until you decide to walk over it.
  spawnDrop(pickMysteryReward(), from);
}

// ============================================================
// SHOOTABLE COMPUTERS — smash the lab up, one hides a shield potion
// ============================================================
const matScreenDead = new THREE.MeshStandardMaterial({
  color: 0x0a0c10, roughness: 0.35, metalness: 0.4,
  emissive: 0x120408, emissiveIntensity: 0.4 });

// every weapon routes computer damage through here, same as the crate
function damageMac(point, radius = 0.75, amount = 1) {
  let hitAny = false;
  for (const m of macs) {
    if (m.broken) continue;
    if (m.hit.distanceTo(point) > radius) continue;
    m.hp -= amount;
    hitAny = true;
    spawnSparks(m.hit.clone(), 0x9fd8ff, 6, 0.7);
    m.g.position.x += rnd(-0.012, 0.012);      // rattle on the desk
    if (m.hp <= 0) breakMac(m);
  }
  return hitAny;
}

function breakMac(m) {
  m.broken = true;
  m.face.material = matScreenDead;
  m.chin.visible = false;
  m.screen.rotation.z = rnd(-0.5, 0.5);        // knocked askew
  m.screen.rotation.x = rnd(-0.3, 0.3);
  m.g.rotation.z = rnd(-0.18, 0.18);
  m.smokeT = 6;

  // glass and casing everywhere
  spawnSparks(m.hit.clone(), 0xbfe6ff, 26, 1.6);
  spawnSparks(m.hit.clone(), 0xffd08a, 14, 1.2);
  for (let i = 0; i < 12; i++) {
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(rnd(0.03, 0.1), rnd(0.01, 0.03), rnd(0.03, 0.09)),
      i % 3 ? matWhite : matScreenDead);
    p.position.copy(m.hit);
    p.userData.v = new THREE.Vector3(rnd(-2.4, 2.4), rnd(1.6, 4.4), rnd(-2.4, 2.4));
    p.userData.ttl = 1.5;
    scene.add(p);
    debris.push(p);
  }
  // a short-lived fireball
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffb15a, transparent: true, opacity: 0.9,
                                  blending: THREE.AdditiveBlending, depthWrite: false }));
  ball.position.copy(m.hit);
  scene.add(ball);
  macBursts.push({ mesh: ball, t: 0 });
  const light = new THREE.PointLight(0xffa33c, 14, 6, 2);
  light.position.copy(m.hit);
  scene.add(light);
  macBursts[macBursts.length - 1].light = light;

  addShake(0.35);
  sfxGlass();
  sfxExplode();
  game.score += 25;

  if (m.potion) {
    m.potion = false;
    spawnDrop('shield', m.hit.clone());
  }
}

const macBursts = [];
function updateMacBursts(dt) {
  for (let i = macBursts.length - 1; i >= 0; i--) {
    const b = macBursts[i];
    b.t += dt;
    const k = b.t / 0.42;
    b.mesh.scale.setScalar(1 + k * 2.6);
    b.mesh.material.opacity = Math.max(0, 0.9 * (1 - k));
    if (b.light) b.light.intensity = Math.max(0, 14 * (1 - k));
    if (k >= 1) {
      scene.remove(b.mesh);
      if (b.light) scene.remove(b.light);
      macBursts.splice(i, 1);
    }
  }
}

// ============================================================
// BREAKABLE BACK-ROOM DOORS
// ============================================================
// Three hits from anything. The first two spread cracks across the slab, the
// third blows it off the latch and leaves the room open for the rest of the run.
function hurtSideDoor(d, amount = 1) {
  if (d.broken) return false;
  d.hp -= amount;
  const stage = Math.min(1, Math.max(0, SIDE_DOOR_HP - 1 - d.hp));
  for (const c of d.cracks) {
    c.visible = true;
    c.material.map = crackStage[stage];
    c.material.opacity = d.hp === SIDE_DOOR_HP - 1 ? 0.75 : 1;
    c.material.needsUpdate = true;
  }
  // the whole leaf shudders in the frame
  d.leaf.rotation.z = rnd(-0.02, 0.02);
  spawnSparks(d.hit.clone(), 0xc99e5f, 8, 0.7);
  addShake(0.12);
  sfxThunk();
  if (d.hp <= 0) breakSideDoor(d);
  return true;
}

function breakSideDoor(d) {
  d.broken = true;
  d.leaf.rotation.z = 0;
  for (const c of d.cracks) { c.material.map = crackStage[1]; c.material.opacity = 1; }
  // splinters off the latch edge
  for (let i = 0; i < 16; i++) {
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(rnd(0.03, 0.12), rnd(0.02, 0.05), rnd(0.02, 0.06)),
      new THREE.MeshStandardMaterial({ color: 0xc09257, roughness: 0.8 }));
    p.position.copy(d.hit).add(new THREE.Vector3(rnd(-0.4, 0.4), rnd(-0.7, 0.8), 0));
    p.userData.v = new THREE.Vector3(rnd(-1.8, 1.8), rnd(1.4, 3.8), rnd(-3.4, -1));
    p.userData.ttl = 1.4;
    scene.add(p);
    debris.push(p);
  }
  if (d.room) {
    d.room.open = true;
    if (d.room.gapCollider) d.room.gapCollider.off = true;
    showToast(`${d.room.label} IS OPEN`, 2200);
  }
  addShake(0.45);
  sfxGlass();
  playSfx('doorOpen', 0.6);
  game.score += 50;
}

// point-and-radius, same shape as damageMac — for melee and thrown SD cards
function damageSideDoor(point, radius = 0.75, amount = 1) {
  let any = false;
  for (const d of sideDoors) {
    if (d.broken) continue;
    if (d.hit.distanceTo(point) > radius) continue;
    if (hurtSideDoor(d, amount)) any = true;
  }
  return any;
}

// cone/ray test, for the flash camera and the laser camcorder
function aimedSideDoor(fwd, maxDist, cosArc) {
  for (const d of sideDoors) {
    if (d.broken) continue;
    const to = d.hit.clone().sub(camera.position);
    const dist = to.length();
    if (dist > maxDist) continue;
    if (to.normalize().dot(fwd) < cosArc) continue;
    return d;
  }
  return null;
}

// one intact computer per round is hiding a shield potion
function seedMacPotion() {
  for (const m of macs) m.potion = false;
  const intact = macs.filter(m => !m.broken);
  if (!intact.length) return;
  intact[(Math.random() * intact.length) | 0].potion = true;
}

// ---------- the box can contain any of these ----------
// weight = how often it turns up relative to the others
const MYSTERY_REWARDS = ['camcorder', 'timeline', 'nuke', 'medkit', 'arsenal', 'shield', 'life1up'];
const REWARD_WEIGHTS = { camcorder: 3, timeline: 3, nuke: 3, medkit: 3, arsenal: 3, shield: 2, life1up: 1 };
const REWARD_INFO = {
  camcorder: { icon: '🎥', name: 'Laser Camcorder', accent: '#4ec5ff',
               desc: 'Hold fire to spray cutting lasers until the round ends.' },
  timeline:  { icon: '🎬', name: 'Timeline Runner', accent: '#c8a6ff',
               desc: 'Survive a Premiere sequence. Every frame banks points.' },
  nuke:      { icon: '💥', name: 'Exposure Bomb', accent: '#fff2a8',
               desc: 'One blinding frame. Everything in the room is deleted.' },
  medkit:    { icon: '🩹', name: 'Full Restore', accent: '#5cff9d',
               desc: 'Health back to 100, plus a 250 point bonus.' },
  arsenal:   { icon: '🔥', name: 'Arsenal', accent: '#ff8a3d',
               desc: 'Double damage on every weapon for 25 seconds.' },
  life1up:   { icon: '🍄', name: '1-UP Mushroom', accent: '#ff5252',
               desc: 'An extra life. Die once and you get right back up.' },
  // turns up in the box now and then, and always from the rigged computer
  shield:    { icon: '🛡️', name: 'Shield Potion', accent: '#4ec5ff',
               desc: '100 points of shield soak up damage before your health.' },
};

const rewardPop = document.getElementById('rewardPop');
const rpIcon = document.getElementById('rpIcon');
const rpName = document.getElementById('rpName');
const rpDesc = document.getElementById('rpDesc');
let rewardTimer = null;
function showRewardPopup(key) {
  const info = REWARD_INFO[key];
  if (!info) return;
  clearTimeout(rewardTimer);
  rewardPop.style.setProperty('--rc', info.accent);
  rewardPop.style.setProperty('--rcGlow', info.accent + '55');
  rpIcon.textContent = info.icon;
  rpName.textContent = info.name;
  rpDesc.textContent = info.desc;
  rewardPop.classList.remove('hide', 'show');
  rewardPop.style.display = 'flex';
  void rewardPop.offsetWidth;               // restart the animations
  rewardPop.classList.add('show');
  // keep this in step with the .rpBar drain in the stylesheet
  rewardTimer = setTimeout(() => {
    rewardPop.classList.add('hide');
    setTimeout(() => {
      rewardPop.classList.remove('show', 'hide');
      rewardPop.style.display = 'none';
    }, 220);
  }, 1600);
}

// ============================================================
// DROPPED ITEMS — the prize pops out of the box and waits on the
// floor, Smash-Bros style, until you choose to step on it
// ============================================================
const drops = [];

// floating icon + name so you can read the item before deciding to grab it
function dropLabel(key) {
  const info = REWARD_INFO[key];
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const x = c.getContext('2d');
  x.font = '96px system-ui, "Apple Color Emoji", sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(info.icon, 256, 58);
  x.font = 'bold 34px "Courier New", monospace';
  x.fillStyle = info.accent;
  x.shadowColor = '#000'; x.shadowBlur = 8;
  x.fillText(info.name.toUpperCase(), 256, 132);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.28, 0.4, 1);
  s.position.y = 0.62;
  return s;
}

// a proper red-cap mushroom for the 1-UP, a glowing pod for everything else
function dropBody(key) {
  const info = REWARD_INFO[key];
  const g = new THREE.Group();
  if (key === 'life1up') {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.21, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xe8342c, emissive: 0x5a0d08, emissiveIntensity: 0.8, roughness: 0.45 }));
    cap.position.y = 0.1;
    cap.scale.set(1, 0.86, 1);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.12, 0.16, 14),
      new THREE.MeshStandardMaterial({ color: 0xfff3dc, emissive: 0x554433, emissiveIntensity: 0.5, roughness: 0.6 }));
    stem.position.y = 0.02;
    g.add(cap, stem);
    const spotMat = new THREE.MeshStandardMaterial({ color: 0xfffaf0, emissive: 0x998877, emissiveIntensity: 0.6, roughness: 0.5 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      const t = i % 2 ? 0.62 : 1.02;                  // two rings of spots
      const sp = new THREE.Mesh(new THREE.SphereGeometry(i % 2 ? 0.055 : 0.042, 10, 8), spotMat);
      sp.position.set(Math.cos(a) * 0.2 * Math.sin(t), 0.1 + Math.cos(t) * 0.18, Math.sin(a) * 0.2 * Math.sin(t));
      sp.scale.set(1, 0.5, 1);
      g.add(sp);
    }
    // two little eyes so it reads as a 1-UP and not a lamp
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x201510, roughness: 0.4 });
    for (const dx of [-0.045, 0.045]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.019, 8, 8), eyeMat);
      eye.position.set(dx, 0.02, 0.105);
      g.add(eye);
    }
  } else {
    const col = new THREE.Color(info.accent);
    const pod = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.85,
                                       roughness: 0.25, metalness: 0.3, flatShading: true }));
    pod.position.y = 0.04;
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16,
                                    wireframe: true, depthWrite: false }));
    shell.position.y = 0.04;
    g.add(pod, shell);
  }
  const halo = new THREE.PointLight(new THREE.Color(info.accent), 3.2, 3.6, 1.7);
  halo.position.y = 0.2;
  g.add(halo);
  return g;
}

// Where a drop is allowed to bounce. Anything spawned behind the south wall
// belongs to that back room — without this it gets batted back into the main
// hall and lands on the wrong side of the door you just broke down.
function dropBounds(from) {
  if (from.z > 9.2) {
    const r = from.x < 0 ? SIDE_ROOMS.staff : SIDE_ROOMS.gear;
    return { x0: r.x0 + 0.45, x1: r.x1 - 0.45, z0: 9.5, z1: r.zFar - 0.3 };
  }
  return { x0: -5.5, x1: 5.5, z0: -8.5, z1: 8.5 };
}

function spawnDrop(key, from) {
  if (!REWARD_INFO[key]) return;
  const holder = new THREE.Group();
  const body = dropBody(key);
  const label = dropLabel(key);
  holder.add(body, label);
  holder.position.copy(from);
  scene.add(holder);

  const a = Math.random() * Math.PI * 2;
  drops.push({
    key, holder, body, label,
    v: new THREE.Vector3(Math.cos(a) * rnd(0.9, 2.4), rnd(5.4, 6.8), Math.sin(a) * rnd(0.9, 2.4)),
    landed: false, ttl: 34, t: rnd(0, 6), spin: rnd(2.5, 5) * (Math.random() < 0.5 ? -1 : 1),
    tumble: new THREE.Vector3(rnd(-7, 7), rnd(-7, 7), rnd(-7, 7)),
    bounds: dropBounds(from),
  });
  showToast(`${REWARD_INFO[key].icon} ${REWARD_INFO[key].name.toUpperCase()} — STEP ON IT TO USE IT`, 3200);
}

// where an item comes to rest at (x,z) — sits on top of furniture too
function dropRest(x, z) { return supportHeight(x, z, 0.22) + 0.24; }

function updateDrops(dt) {
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.t += dt;
    d.ttl -= dt;
    const p = d.holder.position;

    if (!d.landed) {
      d.v.y -= 16 * dt;
      p.addScaledVector(d.v, dt);
      // keep it inside whichever room it was dropped in — walls bat it back
      const bd = d.bounds;
      if (p.x < bd.x0 || p.x > bd.x1) { p.x = Math.max(bd.x0, Math.min(bd.x1, p.x)); d.v.x *= -0.5; }
      if (p.z < bd.z0 || p.z > bd.z1) { p.z = Math.max(bd.z0, Math.min(bd.z1, p.z)); d.v.z *= -0.5; }
      d.body.rotation.x += d.tumble.x * dt;
      d.body.rotation.y += d.tumble.y * dt;
      d.body.rotation.z += d.tumble.z * dt;
      const rest = dropRest(p.x, p.z);
      if (p.y <= rest && d.v.y < 0) {
        p.y = rest;
        if (d.v.y < -2.2) {                      // bounce a couple of times, then settle
          d.v.y *= -0.44;
          d.v.x *= 0.6; d.v.z *= 0.6;
          d.tumble.multiplyScalar(0.5);
          sfxThunk();
        } else {
          d.landed = true;
          d.restY = rest;
          d.body.rotation.set(0, d.body.rotation.y, 0);
          sfxThunk();
        }
      }
    } else {
      d.body.rotation.y += d.spin * 0.35 * dt;
      p.y = d.restY + 0.12 + Math.sin(d.t * 2.6) * 0.07;
    }

    // blink out its last few seconds so you know it's leaving
    d.holder.visible = d.ttl > 5 || Math.sin(d.ttl * 18) > -0.2;
    d.label.material.opacity = Math.min(1, Math.max(0.25, d.ttl / 5));

    // step on it — only counts when your feet are near its height
    const dxz = Math.hypot(p.x - player.pos.x, p.z - player.pos.z);
    const footGap = Math.abs(player.y - (d.landed ? d.restY - 0.24 : p.y - 0.24));
    if (d.landed && dxz < 0.85 && footGap < 1.3) {
      spawnSparks(p.clone(), new THREE.Color(REWARD_INFO[d.key].accent).getHex(), 16, 1.1);
      scene.remove(d.holder);
      drops.splice(i, 1);
      sfxPickup();                   // the grab; the reward then plays its own sound
      grantMysteryReward(d.key);
      continue;
    }
    if (d.ttl <= 0) {
      spawnSparks(p.clone(), 0x666666, 6, 0.5);
      scene.remove(d.holder);
      drops.splice(i, 1);
    }
  }
}

function clearDrops() {
  for (const d of drops) scene.remove(d.holder);
  drops.length = 0;
}

// weighted roll, skipping anything that would be a dud right now
function pickMysteryReward() {
  // don't waste a box on something the player is already holding
  const pool = MYSTERY_REWARDS.filter(r =>
    !(r === 'camcorder' && game.upgraded) && !(r === 'shield' && player.shield >= 100));
  let total = 0;
  for (const r of pool) total += REWARD_WEIGHTS[r] || 1;
  let roll = Math.random() * total;
  for (const r of pool) {
    roll -= REWARD_WEIGHTS[r] || 1;
    if (roll <= 0) return r;
  }
  return pool[pool.length - 1];
}

function grantMysteryReward(key) {
  const pick = key && REWARD_INFO[key] ? key : pickMysteryReward();
  showRewardPopup(pick);
  switch (pick) {
    case 'camcorder':
      upgradeWeapon();
      break;

    case 'timeline':
      setTimeout(startTimelineRunner, 1400);   // let the popup land first
      break;

    case 'nuke': {
      flashFx.style.opacity = 0.85;
      setTimeout(() => flashFx.style.opacity = 0, 220);
      flashDecay = 1.6;
      addShake(1.3);
      for (const e of [...enemies]) {
        if (e.state === 'dying') continue;
        flashEnemy(e);
        e.hp = 0;
        killEnemy(e);
      }
      break;
    }

    case 'medkit':
      player.hp = 100;
      game.score += 250;
      for (let i = 0; i < 18; i++) {
        spawnSparks(camera.position.clone().add(
          new THREE.Vector3(rnd(-1, 1), rnd(-0.6, 0.6), rnd(-1, 1))), 0x66ff99, 1, 0.6);
      }
      break;

    case 'arsenal':
      game.arsenalT = 25;
      selectWeapon(2);
      break;

    case 'shield':
      player.shield = 100;
      refreshShield();
      sfxShield();
      for (let i = 0; i < 14; i++) {
        spawnSparks(camera.position.clone().add(
          new THREE.Vector3(rnd(-1, 1), rnd(-0.5, 0.8), rnd(-1, 1))), 0x4ec5ff, 1, 0.7);
      }
      break;

    case 'life1up':
      game.lives++;
      refreshLives();
      sfx1up();
      for (let i = 0; i < 14; i++) {
        spawnSparks(camera.position.clone().add(
          new THREE.Vector3(rnd(-1, 1), rnd(-0.5, 0.8), rnd(-1, 1))), 0xff5252, 1, 0.7);
      }
      break;
  }
}

// the Mario 1-UP jingle, roughly
function sfx1up() {
  const ctx = audio(); const t = ctx.currentTime;
  [[659, 0], [784, 0.09], [1047, 0.18], [880, 0.27], [988, 0.35], [1319, 0.44]].forEach(([f, dt]) => {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + dt);
    g.gain.exponentialRampToValueAtTime(0.07, t + dt + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.13);
    o.connect(g).connect(ctx.destination);
    o.start(t + dt); o.stop(t + dt + 0.15);
  });
}

// ============================================================
// MYSTERY BOX MINIGAME — Adobe Premiere "Timeline Runner"
// ============================================================
const miniEl = document.getElementById('mini');
const miniCanvas = document.getElementById('miniCanvas');
const mctx = miniCanvas.getContext('2d');
let mini = null;

const TRACK_CLIP_COLORS = ['#4a5fd0', '#6a4ad0', '#3f7fc4', '#5a4ab8'];

function startTimelineRunner() {
  mini = {
    t: 0, dist: 0, speed: 420, hp: 3,
    py: 0, vy: 0, grounded: true,
    obstacles: [], clips: [], keyframes: [],
    scroll: 0, over: false, endT: 0, dead: false,
    nextObstacle: 420,
  };
  // pre-seed the decorative clips on the other tracks
  for (let i = 0; i < 26; i++) {
    mini.clips.push({
      x: i * rnd(180, 300), w: rnd(90, 260), track: (Math.random() * 3) | 0,
      col: TRACK_CLIP_COLORS[(Math.random() * TRACK_CLIP_COLORS.length) | 0],
    });
  }
  miniEl.style.display = 'flex';
  if (document.pointerLockElement) document.exitPointerLock();
  showToast('', 1);
}

function endTimelineRunner(bailed) {
  if (!mini) return;
  const earned = Math.round(mini.dist / 8) * (mini.dead ? 1 : 2);
  game.score += earned;
  miniEl.style.display = 'none';
  mini = null;
  if (!bailed) showToast(`TIMELINE RENDERED — +${earned} POINTS`, 3200);
  canvas.requestPointerLock();
}

function miniJump() {
  if (!mini || mini.over) return;
  if (mini.grounded) { mini.vy = -720; mini.grounded = false; }
}

function updateTimelineRunner(dt) {
  const m = mini;
  const W = miniCanvas.width, H = miniCanvas.height;
  const GROUND = H - 190;          // top of the V1 track = the "floor"

  if (!m.over) {
    m.t += dt;
    m.speed = 420 + m.t * 26;
    m.dist += m.speed * dt;
    m.scroll += m.speed * dt;

    // physics
    m.vy += 1900 * dt;
    m.py += m.vy * dt;
    if (m.py >= 0) { m.py = 0; m.vy = 0; m.grounded = true; }

    // spawn obstacles
    m.nextObstacle -= m.speed * dt;
    if (m.nextObstacle <= 0) {
      m.nextObstacle = rnd(300, 520) - Math.min(140, m.t * 5);
      const kind = Math.random();
      m.obstacles.push({
        x: W + 60,
        type: kind < 0.45 ? 'error' : kind < 0.75 ? 'keyframe' : 'gap',
        w: kind < 0.45 ? 44 : kind < 0.75 ? 34 : 70,
        h: kind < 0.45 ? 66 : kind < 0.75 ? 46 : 26,
        hit: false,
      });
    }
    for (const o of m.obstacles) o.x -= m.speed * dt;
    m.obstacles = m.obstacles.filter(o => o.x > -140);

    // collision — player box is 46x56 at x=190
    const px = 190, pw = 44, ph = 54;
    const pyTop = GROUND - ph + m.py;
    for (const o of m.obstacles) {
      if (o.hit) continue;
      const oyTop = GROUND - o.h;
      if (px + pw > o.x && px < o.x + o.w && pyTop + ph > oyTop) {
        o.hit = true;
        m.hp--;
        m.flash = 0.35;
        if (m.hp <= 0) { m.over = true; m.dead = true; m.endT = 1.6; }
      }
    }
    if (m.flash > 0) m.flash -= dt;
    // survive 32 seconds and the render completes
    if (m.t > 32) { m.over = true; m.endT = 2.0; }
  } else {
    m.endT -= dt;
    if (m.endT <= 0) { endTimelineRunner(false); return; }
  }

  // ---------------- draw the Premiere UI ----------------
  mctx.fillStyle = '#1e2129'; mctx.fillRect(0, 0, W, H);

  // track header column
  mctx.fillStyle = '#252932'; mctx.fillRect(0, 0, 118, H);
  const trackY = [H - 470, H - 380, H - 290, GROUND, H - 100];
  const trackNames = ['V4', 'V3', 'V2', 'V1', 'A1'];
  mctx.font = 'bold 13px Courier New';
  for (let i = 0; i < trackY.length; i++) {
    mctx.fillStyle = '#2e3440';
    mctx.fillRect(6, trackY[i] - 4, 106, 78);
    mctx.fillStyle = i === 3 ? '#c8a6ff' : '#8d95a3';
    mctx.fillText(trackNames[i], 18, trackY[i] + 26);
    mctx.fillStyle = '#454c5a';
    mctx.fillRect(52, trackY[i] + 12, 18, 14);
    mctx.fillRect(76, trackY[i] + 12, 18, 14);
  }

  // timeline ruler + timecode
  mctx.fillStyle = '#2b2f3a'; mctx.fillRect(118, 0, W - 118, 34);
  mctx.strokeStyle = '#4a515f'; mctx.lineWidth = 1;
  mctx.font = '11px Courier New';
  const tickOff = m.scroll % 100;
  for (let x = 118 - tickOff; x < W; x += 100) {
    mctx.beginPath(); mctx.moveTo(x, 20); mctx.lineTo(x, 34); mctx.stroke();
    const secs = Math.floor((m.scroll + x - 118) / 100);
    mctx.fillStyle = '#7f8794';
    mctx.fillText(`00:00:${String(secs % 60).padStart(2, '0')}:00`, x + 4, 15);
  }
  for (let x = 118 - tickOff + 20; x < W; x += 20) {
    mctx.beginPath(); mctx.moveTo(x, 28); mctx.lineTo(x, 34); mctx.stroke();
  }

  // track lanes
  for (let i = 0; i < trackY.length; i++) {
    mctx.fillStyle = i === 3 ? '#22262f' : '#1f232b';
    mctx.fillRect(118, trackY[i] - 4, W - 118, 78);
    mctx.strokeStyle = '#2b303a';
    mctx.strokeRect(118, trackY[i] - 4, W - 118, 78);
  }

  // decorative clips on the non-play tracks
  for (const c of m.clips) {
    let cx = c.x - m.scroll * 0.85;
    const span = 26 * 300;
    cx = ((cx % span) + span) % span - 200;
    if (cx > W || cx + c.w < 118) continue;
    const ty = [trackY[0], trackY[1], trackY[2]][c.track];
    mctx.fillStyle = c.col;
    mctx.fillRect(Math.max(118, cx), ty, Math.min(c.w, cx + c.w - 118), 70);
    mctx.fillStyle = 'rgba(255,255,255,0.16)';
    mctx.fillRect(Math.max(118, cx), ty, Math.min(c.w, cx + c.w - 118), 15);
    // little waveform squiggle
    mctx.strokeStyle = 'rgba(255,255,255,0.25)';
    mctx.beginPath();
    for (let k = 0; k < c.w; k += 6) {
      const wx = cx + k;
      if (wx < 118 || wx > W) continue;
      mctx.moveTo(wx, ty + 48);
      mctx.lineTo(wx, ty + 48 - Math.abs(Math.sin(k * 0.4 + c.x)) * 14);
    }
    mctx.stroke();
  }

  // audio waveform track
  mctx.fillStyle = '#2f7d5b';
  mctx.fillRect(118, trackY[4], W - 118, 70);
  mctx.strokeStyle = '#8fe8bb'; mctx.beginPath();
  for (let x = 118; x < W; x += 4) {
    const a = Math.sin((x + m.scroll) * 0.05) * Math.sin((x + m.scroll) * 0.013) * 26;
    mctx.moveTo(x, trackY[4] + 35 - a);
    mctx.lineTo(x, trackY[4] + 35 + a);
  }
  mctx.stroke();

  // the V1 "running" clip strip the player runs along
  mctx.fillStyle = '#6a4ad0';
  mctx.fillRect(118, GROUND, W - 118, 70);
  mctx.fillStyle = 'rgba(255,255,255,0.14)';
  mctx.fillRect(118, GROUND, W - 118, 16);
  mctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let x = 118 - (m.scroll % 60); x < W; x += 60) mctx.fillRect(x, GROUND, 2, 70);

  // obstacles
  for (const o of m.obstacles) {
    const oy = GROUND - o.h;
    if (o.type === 'error') {
      mctx.fillStyle = o.hit ? '#5a2222' : '#d0342c';
      mctx.fillRect(o.x, oy, o.w, o.h);
      mctx.fillStyle = '#fff'; mctx.font = 'bold 11px Courier New';
      mctx.fillText('!', o.x + o.w / 2 - 3, oy + o.h / 2 + 4);
      mctx.strokeStyle = '#ff8a80'; mctx.strokeRect(o.x, oy, o.w, o.h);
    } else if (o.type === 'keyframe') {
      mctx.fillStyle = o.hit ? '#5a4a22' : '#e8c22e';
      mctx.beginPath();
      mctx.moveTo(o.x + o.w / 2, oy);
      mctx.lineTo(o.x + o.w, oy + o.h / 2);
      mctx.lineTo(o.x + o.w / 2, oy + o.h);
      mctx.lineTo(o.x, oy + o.h / 2);
      mctx.closePath(); mctx.fill();
    } else {
      mctx.fillStyle = o.hit ? '#333' : '#12141a';
      mctx.fillRect(o.x, GROUND - o.h, o.w, o.h + 70);
      mctx.strokeStyle = '#ff5544';
      mctx.setLineDash([6, 5]);
      mctx.strokeRect(o.x, GROUND - o.h, o.w, o.h + 70);
      mctx.setLineDash([]);
    }
  }

  // the player: a little render-clip guy
  const px = 190, ph = 54, pw = 44;
  const pyTop = GROUND - ph + m.py;
  mctx.save();
  if (m.flash > 0 && Math.floor(m.flash * 20) % 2 === 0) mctx.globalAlpha = 0.35;
  mctx.fillStyle = '#f5e04a';
  mctx.fillRect(px, pyTop, pw, ph);
  mctx.fillStyle = '#1e2129';
  const bounce = m.grounded ? Math.sin(m.t * 22) * 2 : 0;
  mctx.fillRect(px + 9, pyTop + 14 + bounce, 8, 9);
  mctx.fillRect(px + 27, pyTop + 14 + bounce, 8, 9);
  mctx.fillRect(px + 12, pyTop + 34, 20, 4);
  // running legs
  mctx.fillStyle = '#c8a6ff';
  if (m.grounded) {
    const s = Math.sin(m.t * 18) * 8;
    mctx.fillRect(px + 8, GROUND, 9, 10 + s);
    mctx.fillRect(px + 26, GROUND, 9, 10 - s);
  } else {
    mctx.fillRect(px + 8, pyTop + ph, 9, 10);
    mctx.fillRect(px + 26, pyTop + ph, 9, 10);
  }
  mctx.restore();

  // playhead
  mctx.strokeStyle = '#e8e8ee'; mctx.lineWidth = 2;
  mctx.beginPath(); mctx.moveTo(px + pw / 2, 26); mctx.lineTo(px + pw / 2, H); mctx.stroke();
  mctx.fillStyle = '#e8e8ee';
  mctx.beginPath();
  mctx.moveTo(px + pw / 2 - 9, 20); mctx.lineTo(px + pw / 2 + 9, 20);
  mctx.lineTo(px + pw / 2, 34); mctx.closePath(); mctx.fill();

  // HUD strip
  mctx.fillStyle = 'rgba(10,12,16,0.85)'; mctx.fillRect(0, H - 44, W, 44);
  mctx.font = 'bold 18px Courier New';
  mctx.fillStyle = '#c8a6ff';
  mctx.fillText(`RENDER  ${Math.min(100, Math.round(m.t / 32 * 100))}%`, 20, H - 16);
  mctx.fillStyle = '#eaffea';
  mctx.fillText(`FRAMES ${Math.round(m.dist)}`, 300, H - 16);
  mctx.fillStyle = '#ff6a5a';
  mctx.fillText('MEDIA ' + '♥'.repeat(Math.max(0, m.hp)), 560, H - 16);
  // render progress bar
  mctx.fillStyle = '#2b2f3a'; mctx.fillRect(820, H - 30, 420, 16);
  mctx.fillStyle = '#6a4ad0'; mctx.fillRect(820, H - 30, 420 * Math.min(1, m.t / 32), 16);

  if (m.over) {
    mctx.fillStyle = 'rgba(8,9,13,0.82)'; mctx.fillRect(0, 0, W, H);
    mctx.textAlign = 'center';
    mctx.font = 'bold 46px Courier New';
    mctx.fillStyle = m.dead ? '#ff5544' : '#7CFC00';
    mctx.fillText(m.dead ? 'MEDIA OFFLINE' : 'RENDER COMPLETE', W / 2, H / 2 - 10);
    mctx.font = '20px Courier New';
    mctx.fillStyle = '#eaffea';
    mctx.fillText(`+${Math.round(m.dist / 8) * (m.dead ? 1 : 2)} POINTS`, W / 2, H / 2 + 34);
    mctx.textAlign = 'left';
  }
}

// chunky pro camcorder view model with a laser emitter
let camcorder = null;
function buildCamcorder() {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x232326, roughness: 0.55, metalness: 0.3 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x121214, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.24, 0.52), bodyMat);
  g.add(body);
  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.2, 16), darkMat);
  hood.rotation.x = Math.PI / 2;
  hood.position.set(0, 0.02, -0.35);
  g.add(hood);
  const emitter = new THREE.Mesh(new THREE.CircleGeometry(0.07, 16),
    new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2020, emissiveIntensity: 1.2 }));
  emitter.position.set(0, 0.02, -0.452);
  g.add(emitter);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.34), bodyMat);
  handle.position.set(0, 0.19, -0.02);
  g.add(handle);
  for (const dz of [-0.16, 0.12]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.05), bodyMat);
    post.position.set(0, 0.15, dz); g.add(post);
  }
  const mic = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 10), darkMat);
  mic.rotation.x = Math.PI / 2;
  mic.position.set(0, 0.21, -0.24); g.add(mic);
  const eyepiece = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.12, 10), darkMat);
  eyepiece.rotation.x = Math.PI / 2;
  eyepiece.position.set(-0.06, 0.14, 0.3); g.add(eyepiece);
  // flip-out screen on the left showing the desktop
  const screenArm = new THREE.Group();
  const scr = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.13, 0.18), darkMat);
  scr.position.set(-0.04, 0, 0); screenArm.add(scr);
  const scrFace = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.11), matScreenDesktop);
  scrFace.rotation.y = Math.PI / 2;
  scrFace.position.set(-0.051, 0, 0); screenArm.add(scrFace);
  screenArm.position.set(-0.11, 0.03, -0.1);
  screenArm.rotation.y = -0.5;
  g.add(screenArm);
  const rec = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff3030, emissiveIntensity: 2.5 }));
  rec.position.set(0.06, 0.1, 0.27);
  g.userData.rec = rec;
  g.add(rec);
  return g;
}
// unlock the camcorder as its own slot and equip it
function upgradeWeapon() {
  const slot = WEAPONS.findIndex(w => w.id === 'camcorder');
  if (slot < 0) return;
  game.upgraded = true;
  WEAPONS[slot].locked = false;
  if (!camcorder) {
    camcorder = buildCamcorder();
    camcorder.scale.setScalar(0.58);
    camcorder.position.set(0.03, -0.04, 0.08);
    camcorder.rotation.set(0, 0, 0);
    weaponModels.camcorder = camcorder;
    camcorder.userData.rest = { pos: camcorder.position.clone(), rot: camcorder.rotation.clone() };
    weapon.add(camcorder);
  }
  refreshWheelLocks();
  curWeapon = -1;                 // force selectWeapon to actually switch
  selectWeapon(slot);
}

function fireLaser() {
  sfxLaser();
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  // muzzle just right/below of view center
  const muzzle = camera.position.clone()
    .add(fwd.clone().multiplyScalar(0.5))
    .add(new THREE.Vector3(-Math.sin(player.yaw - Math.PI / 2), 0, -Math.cos(player.yaw - Math.PI / 2)).multiplyScalar(0.22))
    .add(new THREE.Vector3(0, -0.16, 0));
  // a beam straight through the face is an instant kill
  let head = null, headDist = Infinity;
  for (const e of enemies) {
    if (e.state === 'dying') continue;
    const d = e.model.position.distanceTo(camera.position);
    if (d < headDist && d < 30 && isHeadshot(e, camera.position, fwd)) { head = e; headDist = d; }
  }
  // otherwise pick the nearest enemy within a tight cone
  let best = head, bestAng = Math.cos(0.22);
  if (!best) {
    for (const e of enemies) {
      if (e.state === 'dying') continue;
      const to = e.model.position.clone(); to.y += 0.9;
      to.sub(camera.position);
      const d = to.length();
      if (d > 30) continue;
      to.normalize();
      const dot = to.dot(fwd);
      if (dot > bestAng) { bestAng = dot; best = e; }
    }
  }
  let end;
  if (best) {
    if (head === best) {
      end = new THREE.Vector3();
      headSphere(best, end);
      flashEnemy(best);
      headshotKill(best, camera.position);
    } else {
      end = best.model.position.clone(); end.y += 0.9;
      best.hp -= 1;
      best.stun = 0.15;
      flashEnemy(best);
      spawnSparks(end, 0xff5533, 5, 0.7);
      if (best.hp <= 0) killEnemy(best);
    }
  } else {
    end = camera.position.clone().add(fwd.clone().multiplyScalar(30));
  }
  // lasers cut through screens on the way to whatever's behind them
  for (const m of macs) {
    if (m.broken) continue;
    const to = m.hit.clone().sub(camera.position);
    const t = to.dot(fwd);
    if (t > 0 && t < 26 && to.lengthSq() - t * t < 0.32 * 0.32) {
      m.hp--;
      spawnSparks(m.hit.clone(), 0x9fd8ff, 4, 0.6);
      if (m.hp <= 0) breakMac(m);
    }
  }
  // lasers chew through the back-room doors as well
  {
    const d = aimedSideDoor(fwd, 26, Math.cos(0.06));
    if (d) hurtSideDoor(d, 1);
  }
  // lasers chew the crate open too
  if (crate && crate.landed) {
    const to = crate.mesh.position.clone().setY(0.4).sub(camera.position);
    const t = to.dot(fwd);
    if (t > 0 && to.lengthSq() - t * t < 0.55 * 0.55 && t < 24) {
      end = crate.mesh.position.clone().setY(0.4);
      damageCrate(end, 2.5, 1);
    }
  }
  // beam visual
  const dir = end.clone().sub(muzzle);
  const len = dir.length();
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, len, 6),
    new THREE.MeshBasicMaterial({ color: 0xff3838, transparent: true, opacity: 0.9 }));
  beam.position.copy(muzzle).add(dir.clone().multiplyScalar(0.5));
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  scene.add(beam);
  beams.push({ mesh: beam, ttl: 0.09 });
}

// ============================================================
// GREEN SCREEN PORTAL + PSYCHEDELIC MODE
// ============================================================
let portal = null;
const PortalShader = {
  uniforms: { uTime: { value: 0 }, uOpen: { value: 0 } },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform float uTime, uOpen;
    varying vec2 vUv;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p);
      float a = atan(p.y, p.x);
      // swirling spiral arms pulled toward the centre
      float sw = sin(a * 4.0 + uTime * 3.0 - r * 12.0);
      float rings = sin(r * 26.0 - uTime * 6.0);
      float glow = smoothstep(1.0, 0.15, r);
      vec3 col = mix(vec3(0.05,0.85,0.35), vec3(0.55,0.15,0.95), 0.5 + 0.5 * sw);
      col = mix(col, vec3(1.0), 0.35 * max(0.0, rings));
      col += vec3(0.9,1.0,0.7) * smoothstep(0.35, 0.0, r);   // hot core
      float edge = smoothstep(1.0, 0.86, r);
      float alpha = glow * edge * uOpen;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(col * (0.6 + glow), alpha);
    }`,
};

function openPortal() {
  if (portal) return;
  const mat = new THREE.ShaderMaterial({
    ...PortalShader, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.CircleGeometry(1.25, 48), mat);
  m.position.set(-2, 1.5, -8.55);
  scene.add(m);
  const light = new THREE.PointLight(0x66ff88, 0, 9, 1.5);
  light.position.set(-2, 1.5, -7.9);
  scene.add(light);
  portal = {
    mesh: m, mat, light, open: 0, life: 26,
    toSpawn: 3 + Math.floor(game.round / 2),    // how many it will disgorge
    spawnT: 1.6,
  };
  sfxPortal();
  showToast('A PORTAL TEARS OPEN IN THE GREEN SCREEN', 3000);
}

// something climbs out of the portal
function portalDisgorge() {
  const zc = -8.2;
  const fake = { z0: zc - 0.6, z1: zc + 0.6 };
  const e = (game.round >= 2 && Math.random() < 0.35)
    ? spawnWormEnemy(fake, pickTier())
    : spawnFaceEnemy(fake, pickTier());
  if (!e) return;
  // drop it straight out of the portal mouth, already hunting
  e.model.position.set(-2 + rnd(-0.7, 0.7), 0, zc);
  e.state = 'chase';
  e.chain = null;          // re-lay the body behind it at the portal, not back at the door
  spawnSparks(new THREE.Vector3(-2, 1.4, -8.4), 0x66ff9a, 16, 1.2);
  addShake(0.25);
}
function closePortal() {
  if (!portal) return;
  scene.remove(portal.mesh); scene.remove(portal.light);
  portal = null;
}
function sfxPortal() {
  const ctx = audio(); const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(90, t);
  o.frequency.exponentialRampToValueAtTime(900, t + 0.7);
  const lfo = ctx.createOscillator(); lfo.frequency.value = 22;
  const lg = ctx.createGain(); lg.gain.value = 60;
  lfo.connect(lg).connect(o.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.2);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
  o.connect(g).connect(ctx.destination);
  o.start(t); lfo.start(t); o.stop(t + 1.0); lfo.stop(t + 1.0);
}

// ============================================================
// WANDERING BEAR — occasionally barrels through the building
// ============================================================
let bearGltf = null, bear = null, bearCooldown = 28;
// the model ships KHR_materials_pbrSpecularGlossiness, which three r160 dropped,
// so its maps never bind — load them by hand and rebuild the material.
// The 2K diffuse is 16 MB decoded, so it goes through the same budget as the
// GLTF maps — tuneTexture only has an image to resample once the load lands.
const bearTexLoader = new THREE.TextureLoader();
const bearDiffuse = bearTexLoader.load('./models/bear/textures/Bear_diffuse.png',
  t => tuneTexture(t));
bearDiffuse.colorSpace = THREE.SRGBColorSpace;
bearDiffuse.flipY = false;
const bearNormalMap = bearTexLoader.load('./models/bear/textures/Bear_normal.png',
  t => tuneTexture(t));
bearNormalMap.flipY = false;
const bearMat = new THREE.MeshStandardMaterial({
  map: bearDiffuse, normalMap: bearNormalMap, roughness: 0.92, metalness: 0,
});

loadModel('./models/bear/scene.gltf', g => {
  bearGltf = g;
  console.log('Bear loaded —', g.animations.length, 'clips');
});

function spawnBear() {
  if (!bearGltf || bear) return;
  const model = SkeletonUtils.clone(bearGltf.scene);
  let skinned = null;
  model.traverse(o => {
    if (o.isMesh) {
      o.material = bearMat;
      o.castShadow = true;
      o.frustumCulled = false;
      if (o.isSkinnedMesh) skinned = o;
    }
  });

  // Box3.setFromObject collapses on skinned meshes — measure the bind-pose
  // geometry through its own world matrix instead.
  model.scale.setScalar(1);
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  const bind = new THREE.Box3();
  model.traverse(o => {
    if (o.isMesh) {
      o.geometry.computeBoundingBox();
      bind.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  });
  const size = bind.getSize(new THREE.Vector3());
  model.scale.setScalar(1.4 / Math.max(size.y, 0.001));   // ~1.4m at the shoulder

  const holder = new THREE.Group();
  holder.add(model);
  scene.add(holder);

  const mixer = new THREE.AnimationMixer(model);
  const clips = bearGltf.animations;
  const pick = n => clips.find(c => c.name.toLowerCase().includes(n));
  const runClip = pick('sprint') || pick('run') || pick('trot') || clips[0];
  mixer.clipAction(runClip).play();

  // the run clip carries root motion, so settle the paws using the POSED skeleton
  mixer.update(0);
  model.updateMatrixWorld(true);
  if (skinned && skinned.skeleton) {
    let minY = Infinity;
    const v = new THREE.Vector3();
    for (const b of skinned.skeleton.bones) {
      v.setFromMatrixPosition(b.matrixWorld);
      if (v.y < minY) minY = v.y;
    }
    if (isFinite(minY)) model.position.y -= minY - 0.04;   // small allowance for paw thickness
  }

  // enter through one door, arc across the room, leave through the other
  const inDoor = Math.random() < 0.5 ? DOOR_A : DOOR_B;
  const outDoor = inDoor === DOOR_A ? DOOR_B : DOOR_A;
  const zIn = (inDoor.z0 + inDoor.z1) / 2;
  const zOut = (outDoor.z0 + outDoor.z1) / 2;
  const path = [
    new THREE.Vector3(-11, 0, zIn),
    new THREE.Vector3(-5.2, 0, zIn),
    new THREE.Vector3(1.5, 0, (zIn + zOut) / 2 + rnd(-1.5, 1.5)),
    new THREE.Vector3(3.6, 0, zOut + rnd(-1, 1)),
    new THREE.Vector3(-5.2, 0, zOut),
    new THREE.Vector3(-12, 0, zOut + rnd(-2, 2)),
  ];
  holder.position.copy(path[0]);
  bear = { holder, mixer, path, leg: 1, speed: 6.2, heading: 0, hitCd: 0 };
  showToast('!!! A BEAR JUST RAN IN — GET OUT OF THE WAY !!!', 3000);
}

function updateBear(dt) {
  if (!bear) return;
  const b = bear;
  b.mixer.update(dt);
  const target = b.path[b.leg];
  const pos = b.holder.position;
  const to = target.clone().sub(pos);
  to.y = 0;
  const dist = to.length();
  if (dist < 0.45) {
    b.leg++;
    if (b.leg >= b.path.length) {          // made it back outside
      scene.remove(b.holder);
      bear = null;
      return;
    }
  } else {
    to.normalize();
    pos.addScaledVector(to, b.speed * dt);
    // smoothly turn toward the direction of travel
    const want = Math.atan2(to.x, to.z);
    let d = want - b.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    b.heading += d * Math.min(1, dt * 4);
    b.holder.rotation.y = b.heading;
  }
  // thundering footfalls when it storms past you
  const near = Math.hypot(pos.x - player.pos.x, pos.z - player.pos.z);
  if (near < 6) addShake(0.055 * (1 - near / 6));

  // get in its way and it mauls you
  if (b.hitCd > 0) b.hitCd -= dt;
  if (near < 1.5 && b.hitCd <= 0 && player.y < 1.6) {
    b.hitCd = 1.6;
    bearMaul();
  }
}

// full-screen claw slash, huge damage, and a hard knock back
function bearMaul() {
  const dmg = 42;
  addShake(1.4);
  // hurl the player away from the bear
  if (bear) {
    const away = new THREE.Vector3(
      player.pos.x - bear.holder.position.x, 0,
      player.pos.z - bear.holder.position.z).normalize();
    player.pos.addScaledVector(away, 1.5);
    player.vy = 4.2;
    player.grounded = false;
  }
  // blood spray in front of the camera
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  spawnSparks(camera.position.clone().addScaledVector(fwd, 1.2), 0xb3121c, 26, 1.8);
  // claw graphic
  clawFx.classList.remove('hit');
  void clawFx.offsetWidth;
  clawFx.classList.add('hit');
  gradePass.uniforms.uDamage.value = 1.6;
  showToast('MAULED BY A BEAR', 2200);
  damagePlayer(dmg);
}

// ============================================================
// "NAME THAT ALIEN" — random dancing-alien quiz break
// ============================================================
let alienGltf = null, alienQuiz = null, alienCooldown = 40;
loadModel('./models/alien/scene.gltf', g => {
  alienGltf = g;
  console.log('Alien loaded —', g.animations.length, 'clips');
});

const aqEl = document.getElementById('alienQuiz');
const aqForm = document.getElementById('aqForm');
const aqInput = document.getElementById('aqInput');
const aqResult = document.getElementById('aqResult');

function startAlienQuiz() {
  if (!alienGltf || alienQuiz) return;
  game.alienDone = true;          // one alien per run, that's it
  const model = SkeletonUtils.clone(alienGltf.scene);
  model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

  // size it to ~1.9m using the bind-pose geometry (setFromObject lies on skinned meshes)
  model.scale.setScalar(1);
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  const bind = new THREE.Box3();
  model.traverse(o => {
    if (o.isMesh) {
      o.geometry.computeBoundingBox();
      bind.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  });
  const size = bind.getSize(new THREE.Vector3());
  const s = 1.9 / Math.max(size.y, 0.001);
  model.scale.setScalar(s);
  model.position.y = -bind.min.y * s;

  // drop it right in front of the player, facing them
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0; fwd.normalize();
  const holder = new THREE.Group();
  holder.add(model);
  holder.position.set(
    Math.max(-5, Math.min(5, player.pos.x + fwd.x * 3.6)), 0,
    Math.max(-8, Math.min(8, player.pos.z + fwd.z * 3.6)));
  holder.rotation.y = Math.atan2(-fwd.x, -fwd.z);
  scene.add(holder);

  // theatrical spotlight so it pops
  const spot = new THREE.PointLight(0x66ffe0, 14, 9, 1.5);
  spot.position.set(holder.position.x, 2.6, holder.position.z);
  scene.add(spot);

  const mixer = new THREE.AnimationMixer(model);
  if (alienGltf.animations.length) mixer.clipAction(alienGltf.animations[0]).play();

  alienQuiz = { holder, mixer, spot, answered: false, t: 0 };
  game.state = 'alien';
  aqEl.style.display = 'flex';
  aqResult.classList.remove('pop');
  aqInput.value = '';
  if (document.pointerLockElement) document.exitPointerLock();
  setTimeout(() => aqInput.focus(), 60);
}

function finishAlienQuiz() {
  if (!alienQuiz) return;
  scene.remove(alienQuiz.holder);
  scene.remove(alienQuiz.spot);
  alienQuiz = null;
  aqEl.style.display = 'none';
  aqResult.classList.remove('pop');
  game.state = 'wave';
  canvas.requestPointerLock();
}

aqForm.addEventListener('submit', e => {
  e.preventDefault();
  if (!alienQuiz || alienQuiz.answered) return;
  const name = aqInput.value.trim() || 'that guy';
  alienQuiz.answered = true;
  aqResult.textContent = 'Correct!';
  aqResult.classList.add('pop');
  aqForm.style.display = 'none';
  game.score += 500;
  showToast(`"${name}" — correct!  +500`, 3000);
  setTimeout(() => { aqForm.style.display = 'flex'; finishAlienQuiz(); }, 1900);
});

function updateAlienQuiz(dt) {
  if (!alienQuiz) return;
  alienQuiz.t += dt;
  alienQuiz.mixer.update(dt);
  alienQuiz.holder.rotation.y += dt * 0.5;                       // slow turntable
  alienQuiz.spot.intensity = 12 + Math.sin(alienQuiz.t * 4) * 4;
  // keep the camera pointed at it
  const h = alienQuiz.holder.position;
  const want = Math.atan2(-(h.x - player.pos.x), -(h.z - player.pos.z));
  let d = want - player.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  player.yaw += d * Math.min(1, dt * 4);
  player.pitch += (0.02 - player.pitch) * Math.min(1, dt * 4);
}

// ============================================================
// GAME STATE / ROUNDS
// ============================================================
const game = {
  state: 'menu',     // menu | intermission | wave | gameover
  round: 0, kills: 0, score: 0,
  spawnQueue: 0, spawnTimer: 0, spawnDoorToggle: false,
  interT: 0,
  charge: 1,
  mysteryUsed: false, upgraded: false, bossOut: false, portalUsed: false,
  arsenalT: 0, alienDone: false, crateTimer: 18,
  flashShots: 2, flashCd: 0,      // two frames per charge of the flash camera
  spongeOut: false, bridgeOut: false,
  lives: 0,          // 1-UP mushrooms banked
};
window.GAME = game;   // debug hooks
window.ENEMIES = enemies;
window.PLAYER = player;
window.WEAPON = weapon;
window.DEBUG = {
  spawnFaceEnemy, spawnSparks, addShake, upgradeWeapon, DOOR_A, DOOR_B,
  openPortal, selectWeapon, spawnCrate,
  startTimelineRunner, grantMysteryReward, pickMysteryReward, MYSTERY_REWARDS,
  spawnDrop, clearDrops, updateDrops, getDrops: () => drops, useExtraLife, refreshLives, damagePlayer,
  getMini: () => mini,
  spawnBear, getBear: () => bear, showRewardPopup, REWARD_INFO, spawnWormEnemy, spawnPatrickEnemy,
  startAlienQuiz, isHeadshot, headSphere, camera, scene, THREE, spawnSpongeEnemy,
  getCrate: () => crate, damageCrate, updateEnemy, wormCrawl,
  startWave, endWave, MIRROR, revealMirror, refreshRoundBadge,
  WEATHER, setWeather, weatherForRound, strikeBolt, wx, updateWeather,
  macs, damageMac, breakMac, seedMacPotion, refreshShield,
  sideDoors, hurtSideDoor, breakSideDoor, damageSideDoor, SIDE_ROOMS, chest, armChest,
  // these live further down the file, so read them lazily (TDZ otherwise)
  playSfx, decodeSfx, setMuted, sfxBuf: () => sfxBuf, sfxFiles: () => SFX_FILES,
  sfxDoorStart: () => sfxDoorStart(), sfxDoorStop: () => sfxDoorStop(),
  doorLoopOn: () => !!doorLoop,
  tvVideo, tvTexture, eastTV,
};

const hud = document.getElementById('hud');
const startOverlay = document.getElementById('startOverlay');
const gameoverOverlay = document.getElementById('gameoverOverlay');
const flashFx = document.getElementById('flashFx');
const dmgFx = document.getElementById('dmgFx');
const roundInfo = document.getElementById('roundInfo');
const statsEl = document.getElementById('stats');
const roundBadge = document.getElementById('roundBadge');
const rbNum = document.getElementById('rbNum');
const hpBar = document.getElementById('hpBar');
const chargeBar = document.getElementById('chargeBar');
const flashPips = document.getElementById('flashPips');
const toast = document.getElementById('toast');
const promptEl = document.getElementById('prompt');
const crosshairEl = document.getElementById('crosshair');
const clawFx = document.getElementById('clawFx');
const critFx = document.getElementById('critFx');
const hpLabelEl = document.querySelector('#bars .barLabel');
const scoreVal = document.getElementById('scoreVal');
const hiScoreEl = document.getElementById('hiScore');

// ---- persistent high score ----
let hiScore = 0;
try { hiScore = parseInt(localStorage.getItem('digiDefenseHi') || '0', 10) || 0; } catch (_) {}
let shownScore = -1, beatenThisRun = false;
function refreshScore() {
  if (game.score === shownScore) return;
  shownScore = game.score;
  scoreVal.textContent = game.score.toLocaleString();
  scoreVal.classList.add('pop');
  setTimeout(() => scoreVal.classList.remove('pop'), 130);
  if (game.score > hiScore) {
    hiScore = game.score;
    try { localStorage.setItem('digiDefenseHi', String(hiScore)); } catch (_) {}
    if (!beatenThisRun && game.score > 0) {
      beatenThisRun = true;
      showToast('NEW HIGH SCORE!', 2600);
      hiScoreEl.classList.add('beat');
    }
  }
  hiScoreEl.textContent = (beatenThisRun ? 'NEW BEST ' : 'BEST ') + hiScore.toLocaleString();
}

const shieldFx = document.getElementById('shieldFx');
const shieldRow = document.getElementById('shieldRow');
const shieldBar = document.getElementById('shieldBar');
function refreshShield() {
  if (player.shield <= 0) { shieldRow.style.display = 'none'; return; }
  shieldRow.style.display = 'block';
  shieldBar.style.width = Math.max(0, Math.min(100, player.shield)) + '%';
}

const livesBox = document.getElementById('livesBox');
function refreshLives() {
  if (game.lives <= 0) { livesBox.style.display = 'none'; return; }
  livesBox.style.display = 'block';
  livesBox.textContent = game.lives > 4 ? `🍄 ×${game.lives}` : '🍄'.repeat(game.lives);
  livesBox.classList.remove('pop');
  void livesBox.offsetWidth;
  livesBox.classList.add('pop');
}

// the round number stays on screen the whole run, and flares when it ticks over
function refreshRoundBadge() {
  if (game.round < 1) { roundBadge.style.display = 'none'; return; }
  roundBadge.style.display = 'block';
  rbNum.textContent = game.round;
  roundBadge.classList.remove('bump');
  void roundBadge.offsetWidth;
  roundBadge.classList.add('bump');
}

function showToast(msg, ms = 2200) {
  toast.textContent = msg;
  toast.style.opacity = 1;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.style.opacity = 0, ms);
}

function startGame() {
  startOverlay.style.display = 'none';
  hud.style.display = 'block';
  canvas.requestPointerLock();
  audio();
  decodeSfx().then(startMusic);     // the click is the gesture audio was waiting on
  if (tvVideo) tvVideo.play().catch(() => {});
  game.state = 'intermission';
  game.round = 0;
  game.flashShots = FLASH_MAG;
  game.flashCd = 0;
  game.charge = 1;
  refreshRoundBadge();          // nothing to show until round 1 starts
  game.interT = 3;
  showToast('GET READY — THE GARAGE DOORS ARE OPENING…');
}

function startWave() {
  game.round++;
  game.state = 'wave';
  armChest();
  game.mysteryUsed = false;
  game.bossOut = false;
  game.portalUsed = false;
  // make sure a box turns up early in every round
  if (!crate) game.crateTimer = Math.min(game.crateTimer, rnd(6, 12));
  game.spawnQueue = Math.min(2 + game.round, 10);
  game.spawnTimer = 1.2;
  sfxRound();
  sfxDoorStart();
  roundInfo.textContent = `ROUND ${game.round}`;
  setTimeout(() => { if (game.state === 'wave') roundInfo.textContent = ''; }, 2600);
  refreshRoundBadge();

  // a fresh sky for every round — no announcement, you can see it
  setWeather(weatherForRound(game.round));

  // and a new computer hiding the shield potion
  seedMacPotion();
  doorA.target = 1;
  if (game.round >= 2) doorB.target = 1;

  // round 4: the staff room door bangs open and SpongeBob comes for you
  if (game.round === 4 && spongeGltf && !game.spongeOut) {
    game.spongeOut = true;
    staffTarget = 1;
    setTimeout(() => {
      if (sponge && sponge.g) { world.remove(sponge.g); sponge = null; }   // he's left the room
      spawnSpongeEnemy();
      addShake(0.7);
    }, 1400);
  }

  // round 6: the porch door opens and the bridge to the rainbow annex extends
  if (game.round === 6 && !game.bridgeOut) {
    game.bridgeOut = true;
    rearTarget = 1;
    openBridge();
  }
  // covers a restart straight into a late round — the annex must not be hidden
  // once enemies are allowed to come out of it
  if (game.round >= 6) {
    mirrorActive = true;
    revealMirror();
    if (MIRROR.bridge) MIRROR.bridge.visible = true;
  }
}

function endWave() {
  doorA.target = 0; doorB.target = 0;
  sfxDoorStart();
  game.state = 'intermission';
  game.interT = 6;
  player.hp = Math.min(100, player.hp + 30);
  // an unopened crate stays put for the next round
  closePortal();
  // the laser camcorder is yours for good now — no revert
  sfxRoundClear();
  showToast(`ROUND ${game.round} CLEAR — doors closing, +30 health`);
}

function gameOver() {
  game.state = 'gameover';
  stopMusic();
  document.exitPointerLock();
  document.getElementById('goStats').innerHTML =
    `<span style="font-size:44px;color:#eaffea;display:inline-block;margin-top:4px">${game.score.toLocaleString()}</span>` +
    `<br><span style="color:${game.score >= hiScore ? '#7CFC00' : '#ffd24d'}">` +
    `${game.score >= hiScore && game.score > 0 ? 'NEW HIGH SCORE' : 'BEST ' + hiScore.toLocaleString()}</span>`;
  gameoverOverlay.style.display = 'flex';
  hud.style.display = 'none';
}

startOverlay.addEventListener('click', startGame);
gameoverOverlay.addEventListener('click', () => location.reload());

// ---------- graphics picker on the menu ----------
{
  const row = document.getElementById('qualityRow');
  const hint = document.getElementById('qHint');
  if (row) {
    // the whole overlay is click-to-start, so swallow clicks that land in here
    row.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('.qBtn');
      if (b) setQuality(b.dataset.q);
    });
    for (const b of row.querySelectorAll('.qBtn')) b.classList.toggle('on', b.dataset.q === perf.name);
    if (hint) {
      hint.addEventListener('click', e => e.stopPropagation());
      hint.textContent = perf.pinned
        ? 'Saved on this computer · press [ or ] in game to change · F3 for FPS'
        : `Auto-detected as ${TIER.label} · drop to LOW if it stutters · F3 for FPS`;
    }
  }
}

// tier for current round
function pickTier() {
  const r = game.round;
  const roll = Math.random();
  if (r >= 6 && roll < 0.25) return 3;
  if (r >= 3 && roll < 0.45) return 2;
  return 1;
}

// ============================================================
// FLASH FIRE
// ============================================================
let flashDecay = 0;
addEventListener('mouseup', e => { if (e.button === 0) mouseHeld = false; });
addEventListener('mousedown', e => {
  if (mini) { miniJump(); return; }
  if (alienQuiz) return;
  if (game.state === 'menu' || game.state === 'gameover') return;
  if (wheelOpen) return;
  if (!pointerLocked) { canvas.requestPointerLock(); return; }
  if (e.button !== 0) return;

  // non-camera weapons handle their own attack
  const w = WEAPONS[curWeapon];
  if (w.id === 'camcorder') { mouseHeld = true; return; }   // autofires in the tick loop
  if (w.id !== 'camera') {
    if (attackCd > 0) return;
    attackCd = w.cd;
    if (w.melee) meleeSwing();
    else if (w.id === 'sdcard') throwSdCard();
    return;
  }
  // two frames in the camera: pop them back to back, then wait out the recharge
  if (game.flashShots <= 0) return;
  if (game.flashCd > 0) return;                 // brief beat between the two
  game.flashShots--;
  game.flashCd = FLASH_GAP;
  if (game.flashShots <= 0) game.charge = 0;    // empty — the slow wind-up begins
  sfxShutter();
  // visual flash
  flashFx.style.opacity = 0.5;   // shader adds the rest of the bleach
  setTimeout(() => flashFx.style.opacity = 0, 70);
  flashLight.position.copy(camera.position);
  flashLight.intensity = 260;
  flashDecay = 1;
  addShake(0.5);
  weapon.userData.flashFace.visible = true;
  weapon.userData.flashFace.material.emissiveIntensity = 6;
  // hit detection: cone in view direction
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  for (const e2 of enemies) {
    if (e2.state === 'dying') continue;
    // a flash straight into the face deletes them outright
    if (e2.model.position.distanceTo(camera.position) < 18 && isHeadshot(e2, camera.position, fwd)) {
      flashEnemy(e2);
      headshotKill(e2, camera.position);
      continue;
    }
    const to = e2.model.position.clone();
    to.y += 0.8;
    to.sub(camera.position);
    const dist = to.length();
    if (dist > 16) continue;
    to.normalize();
    if (to.dot(fwd) < Math.cos(0.5)) continue;   // ~28.6° cone
    const dmg = (dist < 6 ? 2 : 1) * (game.arsenalT > 0 ? 2 : 1);
    e2.hp -= dmg;
    e2.stun = 0.45;
    flashEnemy(e2);
    if (e2.hp <= 0) killEnemy(e2);
  }
  // flash the mystery crate open (generous cone — it sits low on the floor)
  if (crate && crate.landed) {
    const to = crate.mesh.position.clone();
    to.y += 0.2;
    to.sub(camera.position);
    const dist = to.length();
    to.normalize();
    if (dist < 8 && to.dot(fwd) > Math.cos(0.85)) {
      crate.hp--;
      crate.mesh.rotation.y += 0.3;
      if (crate.hp <= 0) breakCrate();
    }
  }
  // a flash at a back-room door chips it open too
  {
    const d = aimedSideDoor(fwd, 9, Math.cos(0.34));
    if (d) hurtSideDoor(d, 1);
  }
  // the flash pops any screen you're pointed at — tight cone, they're small
  for (const m of macs) {
    if (m.broken) continue;
    const to = m.hit.clone().sub(camera.position);
    const d = to.length();
    if (d < 7 && to.normalize().dot(fwd) > Math.cos(0.30)) {
      m.hp--;
      if (m.hp <= 0) breakMac(m);
    }
  }
  // weapon kick
  weapon.position.z = -0.36;
});

// ============================================================
// MOVEMENT
// ============================================================
function updatePlayer(dt) {
  const sprinting = !!(keys.ShiftLeft || keys.ShiftRight);
  const speed = sprinting ? 6.4 : 4.2;
  const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const r = new THREE.Vector3(-f.z, 0, f.x);
  const move = new THREE.Vector3();
  if (keys.KeyW) move.add(f);
  if (keys.KeyS) move.sub(f);
  if (keys.KeyD) move.add(r);
  if (keys.KeyA) move.sub(r);
  let strafe = 0;
  if (keys.KeyD) strafe += 1;
  if (keys.KeyA) strafe -= 1;
  const moving = move.lengthSq() > 0;
  if (moving) {
    move.normalize().multiplyScalar(speed * dt);
    player.pos.add(move);
  }

  // head bob, sprint kick, strafe lean
  player.bobAmt += ((moving ? (sprinting ? 1.35 : 1) : 0) - player.bobAmt) * Math.min(1, dt * 9);
  player.bob += dt * (sprinting ? 13.5 : 9.5) * player.bobAmt;
  player.sprint += ((sprinting && moving ? 1 : 0) - player.sprint) * Math.min(1, dt * 6);
  player.lean += ((-strafe * 0.03) - player.lean) * Math.min(1, dt * 7);
  player.shake = Math.max(0, player.shake - dt * 3.2);

  // bounds: inside room unless a garage door is open at that z
  const p = player.pos;
  const inDoorGap = !doorBlocks(p.z);
  if (p.x > -5.7 || !inDoorGap) {
    // treat west wall as solid
    if (p.x < -5.65 && p.x > -6.4 && doorBlocks(p.z)) p.x = -5.65;
  }
  if (p.x < -13) p.x = -13;
  // the rear doorway lets you out onto the porch
  const inRearDoor = p.z > EAST_DOOR.z0 + 0.15 && p.z < EAST_DOOR.z1 - 0.15;
  if (p.x > 5.65 && !(inRearDoor || p.x > 6.2)) p.x = 5.65;
  // the porch edge only holds you back until the bridge is out
  if (p.x > 8.35 && !(onBridge(p.x, p.z) || inMirror(p.x, p.z))) p.x = 8.35;
  if (p.x > MIRROR.x1 - 0.35) p.x = MIRROR.x1 - 0.35;
  if (p.x > -6 && p.x < 6) {  // inside: N/S wall clamp
    if (p.z < -8.65) p.z = -8.65;
    if (p.z > 8.65) {
      // the south wall only lets you through a doorway you've smashed open
      const room = anySideRoomOpen() ? openSideRoomAt(p.x, p.z) : null;
      if (!room) p.z = 8.65;
      else if (p.z > room.zFar) p.z = room.zFar;
    }
  } else if (p.x <= -6) {     // outside, west
    if (p.z < -14) p.z = -14;
    if (p.z > 14) p.z = 14;
  }
  if (p.x > -6) resolveCircle(p, 0.32, player.y);

  // ---- vertical: gravity, landing on furniture, shrink lerp ----
  player.vy -= GRAVITY * dt;
  player.y += player.vy * dt;
  let ground = 0;
  if (p.x > -6 && p.x < 6 && p.z > -9 && p.z < 9) ground = supportHeight(p.x, p.z, 0.25);
  else if (onBridge(p.x, p.z) || inMirror(p.x, p.z)) ground = 0;
  else if (p.x > 8.5) ground = DROP_Y;         // stepped off the porch — 12 ft down
  if (player.y <= ground) {
    if (!player.grounded && player.vy < -6) addShake(0.3);
    if (!player.grounded && player.vy < -2) sfxLand();
    player.y = ground;
    player.vy = 0;
    player.grounded = true;
  } else {
    player.grounded = false;
  }
  updatePlayerCamera(dt);
}

// camera placement: bob, shake, lean, sprint FOV, weapon sway
function updatePlayerCamera(dt) {
  const p = player.pos;
  // bob: vertical figure-eight + lateral sway, plus impact shake
  const bobY = Math.sin(player.bob * 2) * 0.035 * player.bobAmt;
  const bobX = Math.cos(player.bob) * 0.028 * player.bobAmt;
  const sh = player.shake * player.shake;
  const sx = (Math.random() - 0.5) * 0.09 * sh;
  const sy = (Math.random() - 0.5) * 0.09 * sh;

  const right = new THREE.Vector3(-Math.cos(player.yaw), 0, Math.sin(player.yaw));
  camera.position.set(p.x, player.y + EYE + bobY + sy, p.z)
    .addScaledVector(right, bobX + sx);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(player.yaw + (Math.random() - 0.5) * 0.02 * sh);
  camera.rotateX(player.pitch + (Math.random() - 0.5) * 0.02 * sh);
  camera.rotateZ(player.lean + Math.sin(player.bob) * 0.012 * player.bobAmt + (Math.random() - 0.5) * 0.03 * sh);

  // FOV widens as you sprint
  const targetFov = BASE_FOV + player.sprint * 9;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 7);
    camera.updateProjectionMatrix();
  }

  // weapon sways opposite the bob for weight
  weapon.position.x = 0.26 - bobX * 0.55;
  weapon.position.y = -0.21 - bobY * 0.6;
  weapon.rotation.z = -player.lean * 1.6;
}

// ============================================================
// MAIN LOOP
// ============================================================
// ============================================================
// SAMPLED SFX — Kenney game audio packs, CC0 (see audio/KENNEY-CC0-LICENSE.txt)
// ============================================================
// The synth beeps above stay as a fallback: if a file 404s or won't decode,
// the matching sfx call drops back to the oscillator version instead of going
// silent. Lists of files mean "pick one at random" so repeats don't grate.
//
// TO SWAP A SOUND: drop your file in audio/ and point at it from
// audio/sounds.json — see audio/README.md. That file wins over this table, so
// you never have to come in here. This is only the fallback if it goes missing.
const SFX_DEFAULTS = {
  shutter:  ['shutter.ogg'],
  reload:   ['reload.ogg'],
  enemyDie: ['enemy_die.ogg'],
  hurt:     ['hurt.ogg'],
  doorOpen: ['door_open.ogg'],
  doorClose:['door_close.ogg'],
  doorMotor:['door_motor.ogg'],
  round:    ['round.ogg'],
  thunk:    ['thunk.ogg'],
  laser:    ['laser.ogg'],
  swing:    ['swing.ogg'],
  whack:    ['whack.ogg'],
  jump:     ['jump.ogg'],
  land:     ['land.ogg'],
  portal:   ['portal.ogg'],
  oneup:    ['oneup.ogg'],
  thunder:  ['thunder.ogg'],
  hit:      ['hit1.ogg', 'hit2.ogg', 'hit3.ogg'],
  glass:    ['glass.ogg'],
  explode:  ['explode.ogg'],
  shield:   ['potion.wav'],
  pickup:   ['useitem.wav', 'itemused.wav'],
  roundClear: ['levelcomplete.wav'],
  music:    ['menumusic-loop.wav'],
  headshot: ['headshot.ogg'],
};
let SFX_FILES = { ...SFX_DEFAULTS };
const sfxSilenced = new Set();          // manifest entries set to null
const sfxRaw = {}, sfxBuf = {};
let sfxBus = null, sfxMuted = false;
try { sfxMuted = localStorage.getItem('digiDefenseMute') === '1'; } catch (_) {}

// A static site can't list a directory, so the folder declares itself. Anything
// the manifest names replaces the default for that sound; anything it leaves
// out keeps the default. A bad or missing manifest changes nothing.
async function loadSfxManifest() {
  try {
    const r = await fetch('./audio/sounds.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const m = await r.json();
    for (const [k, v] of Object.entries(m)) {
      if (k.startsWith('_')) continue;                    // comment keys
      // null means "I want this one silent" — not "use the synth fallback"
      if (v === null || v === '') { SFX_FILES[k] = []; sfxSilenced.add(k); continue; }
      const list = (Array.isArray(v) ? v : [v]).filter(f => typeof f === 'string' && f);
      if (list.length) SFX_FILES[k] = list;
    }
  } catch (e) {
    console.warn('audio/sounds.json ignored:', e.message, '— using built-in sounds');
  }
}

// fetch up front, decode once there's a context (which needs a user gesture)
const sfxFetched = loadSfxManifest().then(() => Promise.all(
  Object.entries(SFX_FILES).map(async ([k, files]) => {
    sfxRaw[k] = await Promise.all(files.map(f =>
      fetch('./audio/' + f).then(r => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null)));
    if (files.length && sfxRaw[k].every(b => !b)) {
      console.warn(`sfx "${k}": none of [${files}] loaded — falling back to the synth beep`);
    }
  }))).catch(() => {});

let sfxDecoding = false;
async function decodeSfx() {
  if (sfxDecoding || sfxBus) return;
  sfxDecoding = true;
  await sfxFetched;                 // the manifest adds a hop; don't decode early
  const ctx = audio();
  sfxBus = ctx.createGain();
  sfxBus.gain.value = sfxMuted ? 0 : 0.85;
  sfxBus.connect(ctx.destination);
  for (const k of Object.keys(SFX_FILES)) {
    const raw = sfxRaw[k] || [];
    const bufs = [];
    for (const b of raw) {
      if (!b) continue;
      try { bufs.push(await ctx.decodeAudioData(b.slice(0))); } catch (_) {}
    }
    sfxBuf[k] = bufs;
  }
}

// A one-shot fired from the tick loop would stack 60 copies a second into a
// buzzing wash, so every sound has a minimum gap between retriggers.
const SFX_GAP = { hit: 0.06, laser: 0.07, thunk: 0.05, whack: 0.05, glass: 0.06 };
const SFX_GAP_DEFAULT = 0.04;
const sfxLast = {};

// returns false when there's no sample yet, so callers can fall back
function playSfx(name, vol = 1, rate = 1) {
  if (sfxSilenced.has(name)) return true;   // muted on purpose, don't fall back
  const list = sfxBuf[name];
  if (!sfxBus || !list || !list.length) return false;
  const ctx = audio();
  const now = ctx.currentTime;
  const gap = SFX_GAP[name] !== undefined ? SFX_GAP[name] : SFX_GAP_DEFAULT;
  if (sfxLast[name] !== undefined && now - sfxLast[name] < gap) return true;  // throttled, not missing
  sfxLast[name] = now;
  const src = ctx.createBufferSource();
  src.buffer = list[(Math.random() * list.length) | 0];
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(g).connect(sfxBus);
  src.start();
  return true;
}

// continuous sounds (the garage door motor) — started and stopped explicitly
function playSfxLoop(name, vol = 1) {
  const list = sfxBuf[name];
  if (!sfxBus || !list || !list.length) return null;
  const ctx = audio();
  const src = ctx.createBufferSource();
  src.buffer = list[0];
  src.loop = true;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.15);
  src.connect(g).connect(sfxBus);
  src.start();
  return { src, g };
}
function stopSfxLoop(h) {
  if (!h) return;
  const ctx = audio();
  h.g.gain.cancelScheduledValues(ctx.currentTime);
  h.g.gain.setValueAtTime(h.g.gain.value, ctx.currentTime);
  h.g.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
  setTimeout(() => { try { h.src.stop(); } catch (_) {} }, 300);
}

function setMuted(m) {
  sfxMuted = m;
  if (sfxBus) sfxBus.gain.value = m ? 0 : 0.85;
  try { localStorage.setItem('digiDefenseMute', m ? '1' : '0'); } catch (_) {}
  showToast(m ? '🔇 SOUND OFF' : '🔊 SOUND ON', 1200);
}

// route every existing sfx call at a sample, keeping the synth as a fallback
const synthSfx = {
  shutter: sfxShutter, robotDie: sfxRobotDie, hurt: sfxHurt,
  doorStart: sfxDoorStart, doorStop: sfxDoorStop, round: sfxRound,
  thunk: sfxThunk, laser: sfxLaser, swing: sfxSwing, whack: sfxWhack,
  jump: sfxJump, portal: sfxPortal, oneUp: sfx1up, thunder: sfxThunder,
};
sfxShutter   = () => { playSfx('shutter', 0.55, rnd(0.95, 1.05)) || synthSfx.shutter(); };
sfxRobotDie  = () => { playSfx('enemyDie', 0.5, rnd(0.9, 1.1))   || synthSfx.robotDie(); };
sfxHurt      = () => { playSfx('hurt', 0.6, rnd(0.9, 1.1))       || synthSfx.hurt(); };
// The doors are a START/STOP pair, not one-shots: the tick loop calls
// sfxDoorStop() every single frame the doors aren't moving, and relies on it
// being a no-op once the motor is already off. Both must stay idempotent.
let doorLoop = null;
sfxDoorStart = () => {
  if (doorLoop) return;                        // motor's already running
  doorLoop = playSfxLoop('doorMotor', 0.18);
  if (doorLoop) playSfx('doorOpen', 0.45);     // clunk as it takes up
  else synthSfx.doorStart();                   // no sample — fall back to the hum
};
sfxDoorStop = () => {
  if (doorLoop) {
    stopSfxLoop(doorLoop);
    doorLoop = null;
    playSfx('doorClose', 0.4);                 // clunk as it settles
  } else {
    synthSfx.doorStop();                       // guarded internally, safe every frame
  }
};
sfxRound     = () => { playSfx('round', 0.6)                     || synthSfx.round(); };
sfxThunk     = () => { playSfx('thunk', 0.6, rnd(0.9, 1.15))     || synthSfx.thunk(); };
sfxLaser     = () => { playSfx('laser', 0.22, rnd(0.9, 1.2))     || synthSfx.laser(); };
sfxSwing     = () => { playSfx('swing', 0.4, rnd(0.9, 1.15))     || synthSfx.swing(); };
sfxWhack     = () => { playSfx('whack', 0.6, rnd(0.9, 1.1))      || synthSfx.whack(); };
sfxJump      = () => { playSfx('jump', 0.3, rnd(0.95, 1.1))      || synthSfx.jump(); };
sfxPortal    = () => { playSfx('portal', 0.5)                    || synthSfx.portal(); };
sfx1up       = () => { playSfx('oneup', 0.7)                     || synthSfx.oneUp(); };
sfxThunder   = () => { playSfx('thunder', 0.7, rnd(0.8, 1.05))   || synthSfx.thunder(); };
// new ones with no synth equivalent
function sfxLand()     { playSfx('land', 0.35, rnd(0.9, 1.1)); }
function sfxEnemyHit() { playSfx('hit', 0.45, rnd(0.9, 1.2)); }
function sfxHeadshot() { playSfx('headshot', 0.5); }
function sfxGlass()    { playSfx('glass', 0.55, rnd(0.9, 1.1)); }
function sfxExplode()  { playSfx('explode', 0.6, rnd(0.9, 1.1)); }
function sfxShield()   { playSfx('shield', 0.55); }
// sits under whatever the item itself plays, so keep it quiet
function sfxPickup()   { playSfx('pickup', 0.4); }
function sfxRoundClear() { playSfx('roundClear', 0.6); }

// Background music. It runs on the sfx bus so the M key mutes it with
// everything else, and it can only start once the samples have decoded.
let musicLoop = null;
function startMusic() { if (!musicLoop) musicLoop = playSfxLoop('music', 0.2); }
function stopMusic()  { stopSfxLoop(musicLoop); musicLoop = null; }
function sfxReload()   { playSfx('reload', 0.4); }

// ============================================================
// ADAPTIVE PERFORMANCE
// ============================================================
// Nothing here needs the player to know what a pixel ratio is. The renderer
// watches its own frame time and walks the resolution down until the frame
// rate is back where it belongs, then carefully walks it back up. If it bottoms
// out and is still struggling, it starts switching effects off one at a time.
const TARGET_MS = 1000 / 58;    // above this we are leaving frames on the table
const PANIC_MS = 1000 / 45;     // below 45 fps it genuinely feels bad

const perfEl = document.getElementById('perfStats');
let relief = 0;                 // how many effects we have already sacrificed

function shedLoad() {
  relief++;
  if (relief === 1 && bloomPass) {
    setBloom(false);
    showToast('PERFORMANCE — BLOOM OFF');
  } else if (relief <= 2 && renderer.shadowMap.enabled) {
    renderer.shadowMap.enabled = false;
    sun.castShadow = false;
    scene.traverse(o => { if (o.isMesh && o.material) refreshMat(o.material); });
    showToast('PERFORMANCE — SHADOWS OFF');
  } else if (relief <= 3 && dust && dust.visible) {
    dust.visible = false;
    scene.fog.far *= 0.7;
    showToast('PERFORMANCE — EFFECTS REDUCED');
  } else if (relief === 4 && perf.name !== 'low') {
    showToast('STILL CHOPPY? PRESS  [  FOR LOW QUALITY', 4500);
  } else {
    relief = 99;                // out of things to give up; stop nagging
  }
}

// changing shadowMap.enabled or its type invalidates every compiled program
function refreshMat(mat) {
  for (const m of (Array.isArray(mat) ? mat : [mat])) if (m) m.needsUpdate = true;
}

function samplePerf(msRaw) {
  perf.acc += msRaw;
  perf.accFrames++;
  if (perf.accFrames < 20) return;
  const avg = perf.acc / perf.accFrames;
  perf.acc = 0; perf.accFrames = 0;
  perf.ms += (avg - perf.ms) * 0.5;          // smooth so one hitch cannot swing it
  perf.fps = 1000 / perf.ms;
  if (perf.cooldown > 0) { perf.cooldown--; return; }

  if (perf.ms > PANIC_MS) {
    if (perf.scale > TIER.minScale + 0.001) {
      perf.scale = Math.max(TIER.minScale, perf.scale - 0.1);
      applyResolution();
      perf.cooldown = 3;
    } else if (relief < 99) {
      perf.starved++;
      if (perf.starved >= 4) { perf.starved = 0; shedLoad(); perf.cooldown = 25; }
    }
  } else if (perf.ms < TARGET_MS && perf.scale < 1) {
    // plenty of headroom — creep back toward full resolution
    perf.scale = Math.min(1, perf.scale + 0.05);
    applyResolution();
    perf.cooldown = 8;
    perf.starved = 0;
  } else {
    perf.starved = 0;
  }
}

// [ and ] step quality down / up. The tier decides how the whole scene is
// built, so it takes effect on reload rather than trying to rebuild live.
function setQuality(name) {
  if (!TIERS[name] || name === perf.name) return;
  try { localStorage.setItem('dd_quality', name); } catch (e) { /* private mode */ }
  location.reload();
}
let qArmed = 0;
addEventListener('keydown', e => {
  if (e.code === 'F3' || (e.code === 'KeyP' && e.shiftKey)) {
    perf.showStats = !perf.showStats;
    if (perfEl) perfEl.style.display = perf.showStats ? 'block' : 'none';
    return;
  }
  const dir = e.code === 'BracketLeft' ? -1 : e.code === 'BracketRight' ? 1 : 0;
  if (!dir) return;
  const next = TIER_ORDER[TIER_ORDER.indexOf(perf.name) + dir];
  if (!next) return;
  // switching rebuilds the scene, so mid-run it costs you the round — make the
  // player say it twice
  const mid = game.state === 'wave' || game.state === 'intermission';
  if (mid && Date.now() - qArmed > 3000) {
    qArmed = Date.now();
    showToast(`PRESS AGAIN FOR ${TIERS[next].label} — RESTARTS THE RUN`, 3000);
    return;
  }
  setQuality(next);
});
// console handles, for poking at this on the machine that is actually struggling
window.digiPerf = {
  setQuality, shed: shedLoad, tiers: TIERS,
  get state() { return { tier: perf.name, scale: perf.scale, fps: perf.fps, relief }; },
};

// last values pushed to the HUD, so we only touch the DOM on a real change
const hudLast = { crit: null, hp: -1, shots: -2, left: -1 };

const clock = new THREE.Clock();
let frameMark = performance.now();
let hiddenSkip = 0;
function tick() {
  requestAnimationFrame(tick);

  // A backgrounded tab does not need a full frame of physics and shading.
  // Browsers already throttle rAF here; this drops most of what is left. It
  // trickles rather than stopping dead, so a host that mis-reports visibility
  // gets a slow game instead of a black canvas.
  if (document.hidden && ++hiddenSkip % 6) { clock.getDelta(); return; }

  const nowMs = performance.now();
  samplePerf(nowMs - frameMark);
  frameMark = nowMs;
  perf.frame++;
  // shadows are expensive enough to be worth re-rendering on a cadence
  if (renderer.shadowMap.enabled && perf.frame % TIER.shadowEvery === 0) {
    renderer.shadowMap.needsUpdate = true;
  }
  const info = renderer.info.render;
  if (perf.showStats && perfEl && perf.frame % 15 === 0) {
    perfEl.textContent =
      `${perf.fps.toFixed(0)} FPS · ${perf.ms.toFixed(1)} ms\n` +
      `${TIER.label} · scale ${perf.scale.toFixed(2)} · ${(Math.min(devicePixelRatio, TIER.maxPR) * perf.scale).toFixed(2)}x\n` +
      `${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris\n` +
      `bloom ${bloomPass ? 'on' : 'off'} · shadows ${renderer.shadowMap.enabled ? 'on' : 'off'}\n` +
      `[ / ] quality · F3 hide`;
  }
  renderer.info.reset();   // counters above describe the frame we just finished

  const dt = Math.min(clock.getDelta(), 0.05);

  const now = clock.elapsedTime;

  // the sky keeps living even on the menu and between rounds
  updateWeather(dt, now);
  updateMacBursts(dt);
  updateChest(dt);

  // fans spin always
  for (const f of fans) f.rotation.y += dt * 5;

  // the bear runs its route whenever one is out, and shows up now and then
  if (bear) updateBear(dt);
  else if (game.state === 'wave' || game.state === 'intermission') {
    bearCooldown -= dt;
    if (bearCooldown <= 0 && bearGltf) {
      bearCooldown = rnd(45, 95);
      spawnBear();
    }
  }

  // sponge guy paces the staff room, swinging his noodle arms
  if (sponge && sponge.real) {
    const s = sponge;
    if (s.mixer) s.mixer.update(dt);
    s.g.position.x += s.dir * dt * 0.5;
    if (s.g.position.x > -1.8) s.dir = -1;
    if (s.g.position.x < -4.0) s.dir = 1;
    s.g.rotation.y = s.dir > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
  } else if (sponge) {
    const s = sponge;
    s.t += dt * 6;
    s.g.position.x += s.dir * dt * 0.55;
    if (s.g.position.x > -1.6) { s.dir = -1; }
    if (s.g.position.x < -4.2) { s.dir = 1; }
    s.g.rotation.y = s.dir > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    s.armL.rotation.x = Math.sin(s.t) * 0.9;
    s.armR.rotation.x = -Math.sin(s.t) * 0.9;
    s.legL.rotation.x = -Math.sin(s.t) * 0.7;
    s.legR.rotation.x = Math.sin(s.t) * 0.7;
    s.rig.position.y = Math.abs(Math.sin(s.t)) * 0.06;
    s.rig.rotation.z = Math.sin(s.t) * 0.05;
    // occasional blink
    s.blink -= dt;
    const closed = s.blink < 0 && s.blink > -0.13;
    for (const e of s.eyes) e.scale.y = closed ? 0.12 : 1;
    if (s.blink < -0.13) s.blink = 2 + Math.random() * 3;
  }

  // drifting dust motes
  if (dust) {
    const pa = dust.geometry.attributes.position;
    const { seed, base } = dust.userData;
    for (let i = 0; i < seed.length; i++) {
      const s = seed[i];
      pa.array[i * 3] = base[i * 3] + Math.sin(now * 0.22 + s) * 0.35;
      pa.array[i * 3 + 1] = base[i * 3 + 1] + Math.sin(now * 0.14 + s * 1.7) * 0.22;
      pa.array[i * 3 + 2] = base[i * 3 + 2] + Math.cos(now * 0.18 + s * 0.8) * 0.35;
    }
    pa.needsUpdate = true;
  }

  // light shafts fade in with the doors, shimmering slightly
  for (let i = 0; i < shafts.length; i++) {
    const open = garageDoors[i] ? garageDoors[i].open : 0;
    shafts[i].material.opacity = open * (0.15 + Math.sin(now * 1.3 + i) * 0.02);
  }

  // flying sparks
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.userData.ttl -= dt;
    s.userData.v.y -= 11 * dt;
    s.position.addScaledVector(s.userData.v, dt);
    if (s.position.y < 0.03) { s.position.y = 0.03; s.userData.v.y *= -0.35; s.userData.v.multiplyScalar(0.6); }
    s.material.opacity = Math.max(0, s.userData.ttl / s.userData.life);
    s.scale.setScalar(0.5 + s.material.opacity);
    if (s.userData.ttl <= 0) { scene.remove(s); sparks.splice(i, 1); }
  }

  // post-processing uniforms
  gradePass.uniforms.uTime.value = now;
  gradePass.uniforms.uFlash.value = Math.max(0, flashDecay) * 0.28;
  gradePass.uniforms.uSprint.value = player.sprint;
  gradePass.uniforms.uDamage.value = Math.max(0, gradePass.uniforms.uDamage.value - dt * 2.2);
  if (bloomPass) {
    bloomPass.strength = BLOOM_BASE + Math.max(0, flashDecay) * 0.9 + (game.upgraded ? 0.12 : 0);
  }

  // garage door animation
  let anyMoving = false;
  for (const d of garageDoors) {
    const prev = d.open;
    d.open += Math.sign(d.target - d.open) * dt * 0.35;
    d.open = Math.max(0, Math.min(1, d.open));
    if (Math.abs(prev - d.open) > 0.0001) anyMoving = true;
    // sectional door: each panel rides up the vertical track, then bends 90°
    // at the top and slides horizontally back along the ceiling
    const H = d.height;
    for (const s of d.sections) {
      const sp = s.s0 + d.open * H;
      const u = Math.max(0, Math.min(1, (sp - (H - 0.2)) / 0.4));
      s.sec.rotation.z = -u * Math.PI / 2;
      s.sec.position.y = Math.min(sp, H - 0.2 + u * 0.34);
      s.sec.position.x = Math.max(0, sp - H);
    }
  }
  if (!anyMoving) sfxDoorStop();

  // rear French doors swing for the boss
  rearOpen += (rearTarget - rearOpen) * Math.min(1, dt * 2.2);
  for (const d of rearDoors) d.pivot.rotation.y = -d.s * rearOpen * Math.PI * 0.62;

  // back-room doors: the staff one also swings in on cue for SpongeBob, and a
  // smashed door slams the rest of the way and stays there
  for (const d of sideDoors) {
    const want = Math.max(d.broken ? 1 : 0, d === staffDoor ? staffTarget : 0);
    d.open += (want - d.open) * Math.min(1, dt * (d.broken ? 6 : 2.6));
    d.pivot.rotation.y = d.s * d.open * Math.PI * 0.62;
    if (!d.broken && d.leaf.rotation.z) d.leaf.rotation.z *= Math.max(0, 1 - dt * 9);
  }

  // the timeline runner takes over completely while it's up
  if (mini) {
    updateTimelineRunner(dt);
    composer.render();
    return;
  }

  // the alien quiz pauses the fight but keeps the world rendering
  if (alienQuiz) {
    updateAlienQuiz(dt);
    updatePlayerCamera();
    composer.render();
    return;
  }

  // the alien shows up once per run, then never again
  if (game.state === 'wave' && !alienQuiz && alienGltf && !game.alienDone) {
    alienCooldown -= dt;
    if (alienCooldown <= 0) {
      alienCooldown = rnd(70, 130);
      startAlienQuiz();
    }
  }

  if (game.state !== 'menu' && game.state !== 'gameover') {
    updatePlayer(dt);

    // arsenal power-up timer
    if (game.arsenalT > 0) {
      game.arsenalT -= dt;
      if (game.arsenalT <= 0) showToast('Arsenal buff expired');
    }

    // post-1UP invincibility — the HUD readout throbs while it lasts
    if (player.invulnT > 0) {
      player.invulnT -= dt;
      livesBox.style.display = 'block';
      if (game.lives <= 0) livesBox.textContent = '✨';
      livesBox.style.opacity = 0.3 + Math.abs(Math.sin(now * 9)) * 0.7;
      if (player.invulnT <= 0) { livesBox.style.opacity = 1; refreshLives(); }
    }

    // flash recharge — only once both frames are spent
    if (game.flashCd > 0) game.flashCd -= dt;
    if (game.flashShots <= 0) {
      game.charge = Math.min(1, game.charge + dt / FLASH_RELOAD);
      if (game.charge >= 1) {
        game.flashShots = FLASH_MAG;
        weapon.userData.flashFace.material.emissiveIntensity = 0.25;
        sfxReload();                       // camera's wound on, two frames ready
      }
    }

    // flash decay
    if (flashDecay > 0) {
      flashDecay -= dt * 6;
      flashLight.intensity = Math.max(0, flashDecay) * 260;
      weapon.userData.flashFace.material.emissiveIntensity = 0.25 + Math.max(0, flashDecay) * 6;
      weapon.userData.flashFace.visible = flashDecay > 0;
      weapon.position.z += (-0.42 - weapon.position.z) * dt * 10;
    }

    // spawning
    if (game.state === 'wave' && game.spawnQueue > 0) {
      game.spawnTimer -= dt;
      if (game.spawnTimer <= 0 && robotGltf) {
        game.spawnTimer = Math.max(0.55, 1.4 - game.round * 0.07);
        const useB = game.round >= 2 && (game.spawnDoorToggle = !game.spawnDoorToggle);
        const doorDef = useB ? DOOR_B : DOOR_A;
        // one boss can show up from round 3 on
        const wantBoss = game.round >= 3 && !game.bossOut && Math.random() < 0.3;
        if (wantBoss) { spawnFaceEnemy(doorDef, 3, true); game.bossOut = true; }
        else if (game.round >= 3 && Math.random() < 0.28) spawnPatrickEnemy(doorDef, pickTier());
        else if (game.round >= 2 && Math.random() < 0.3) spawnWormEnemy(doorDef, pickTier());
        else spawnFaceEnemy(doorDef, pickTier());
        // from round 6 some of them come out of the rainbow annex instead
        if (mirrorActive && Math.random() < 0.45) {
          const e = enemies[enemies.length - 1];
          if (e && e.state === 'enter') {
            e.model.position.set(rnd(MIRROR.x0 + 1.5, MIRROR.x1 - 1.5), 0, rnd(-4, 4));
            e.state = 'annex';
          }
        }
        game.spawnQueue--;
      }
    }

    // laser camcorder autofire
    if (mouseHeld && WEAPONS[curWeapon].id === 'camcorder') {
      laserCd -= dt;
      if (laserCd <= 0) { laserCd = 0.09; fireLaser(); }
      if (camcorder) camcorder.userData.rec.material.emissiveIntensity = 2.5 + Math.random() * 2;
    }
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i];
      b.ttl -= dt;
      b.mesh.material.opacity = Math.max(0, b.ttl / 0.09) * 0.9;
      if (b.ttl <= 0) { scene.remove(b.mesh); beams.splice(i, 1); }
    }

    // crates drop in on their own every so often during a wave
    if (game.state === 'wave' && !crate) {
      game.crateTimer -= dt;
      if (game.crateTimer <= 0) {
        game.crateTimer = rnd(15, 28);
        spawnCrate();
      }
    }

    // mystery crate physics
    if (crate) {
      if (!crate.landed) {
        crate.vy -= 9.8 * dt;
        crate.mesh.position.y += crate.vy * dt;
        crate.mesh.rotation.y += dt * 1.5;
        if (crate.mesh.position.y <= 0.3) {
          crate.mesh.position.y = 0.3;
          crate.landed = true;
          addShake(0.35);
          sfxThunk();
        }
      } else {
        crate.mesh.rotation.y += dt * 0.5;
        crate.mesh.position.y = 0.3 + Math.sin(now * 2.2) * 0.04;
      }
      if (crate.beam) {
        // fade the marker out as you walk up to it
        const near = Math.hypot(crate.mesh.position.x - player.pos.x,
                                crate.mesh.position.z - player.pos.z);
        crate.beam.material.opacity =
          (0.09 + Math.sin(now * 3) * 0.035) * Math.min(1, Math.max(0, (near - 1.2) / 2));
      }
    }
    for (let i = debris.length - 1; i >= 0; i--) {
      const p = debris[i];
      p.userData.ttl -= dt;
      p.userData.v.y -= 9.8 * dt;
      p.position.addScaledVector(p.userData.v, dt);
      p.rotation.x += dt * 6; p.rotation.z += dt * 4;
      if (p.position.y < 0.02) p.position.y = 0.02;
      if (p.userData.ttl <= 0) { scene.remove(p); debris.splice(i, 1); }
    }

    // melee swing animation
    if (attackCd > 0) attackCd -= dt;
    const wm = weaponModels[WEAPONS[curWeapon].id];
    if (swingT > 0) {
      swingT += dt * 4.2;
      if (swingT >= 1) swingT = 0;
    }
    if (wm) {
      const s = swingT > 0 ? Math.sin(swingT * Math.PI) : 0;
      const rest = wm.userData.rest;
      if (WEAPONS[curWeapon].melee) {
        wm.rotation.x = rest.rot.x - s * 1.5;
        wm.rotation.z = rest.rot.z + s * 1.25;
        wm.position.z = rest.pos.z - s * 0.3;
        wm.position.y = rest.pos.y + s * 0.12;
      } else if (WEAPONS[curWeapon].id === 'sdcard') {
        // idle spin in the hand, plus a flick on throw
        for (const c of wm.children) c.rotation.y += dt * 1.6;
        wm.position.z = rest.pos.z - Math.max(0, attackCd / WEAPONS[curWeapon].cd) * 0.22;
        wm.rotation.z = rest.rot.z + Math.max(0, attackCd / WEAPONS[curWeapon].cd) * 0.5;
      }
    }

    // thrown SD cards: spin, drop, and slice whatever they hit
    for (let i = sdcards.length - 1; i >= 0; i--) {
      const c = sdcards[i];
      c.ttl -= dt;
      c.v.y -= 5.5 * dt;                       // gentle arc — they fly flat and fast
      c.mesh.position.addScaledVector(c.v, dt);
      c.mesh.rotateOnAxis(c.spin, c.spinRate * dt);
      const q = c.mesh.position;
      let done = c.ttl <= 0 || q.y < 0.05 ||
                 q.x < -6.2 || q.x > 8.4 || q.z < -9.2 || q.z > 9.2;
      if (!done && damageCrate(q, 0.75, 1)) done = true;
      if (!done && damageMac(q, 0.45, 1)) done = true;
      if (!done && damageSideDoor(q, 0.6, 1)) done = true;
      if (!done) {
        for (const e of enemies) {
          if (e.state === 'dying') continue;
          const hitR = e.boss ? 1.1 : 0.6;
          if (e.model.position.distanceTo(q) < hitR ||
              (e.head && e.head.getWorldPosition(new THREE.Vector3()).distanceTo(q) < 0.5)) {
            flashEnemy(e);
            spawnSparks(q.clone(), 0xd8d8e8, 8, 0.9);
            // a card to the face still counts as a headshot
            const hp = new THREE.Vector3();
            headSphere(e, hp);
            if (hp.distanceTo(q) < 0.5) headshotKill(e, q);
            else {
              e.hp -= 2 * (game.arsenalT > 0 ? 2 : 1);
              e.stun = 0.25;
              if (e.hp <= 0) killEnemy(e);
            }
            done = true;
            break;
          }
        }
      }
      if (done) { scene.remove(c.mesh); sdcards.splice(i, 1); }
    }

    // portal: opens mid-wave from round 2 and disgorges enemies
    if (game.state === 'wave' && !portal && !game.portalUsed && game.round >= 2 &&
        Math.random() < dt * 0.09) {
      openPortal();
      game.portalUsed = true;
    }
    if (portal) {
      portal.life -= dt;
      const closing = portal.life <= 1.2 || portal.toSpawn <= 0;
      portal.open += ((closing ? 0 : 1) - portal.open) * Math.min(1, dt * 4);
      portal.mat.uniforms.uTime.value = now;
      portal.mat.uniforms.uOpen.value = portal.open;
      portal.light.intensity = portal.open * 7 * (0.8 + Math.sin(now * 8) * 0.2);
      portal.mesh.scale.setScalar(0.7 + portal.open * 0.3);
      // things climb out while it's wide open
      if (portal.toSpawn > 0 && portal.open > 0.75) {
        portal.spawnT -= dt;
        if (portal.spawnT <= 0) {
          portal.spawnT = rnd(1.1, 2.0);
          portal.toSpawn--;
          portalDisgorge();
        }
      }
      if (portal.toSpawn <= 0 && portal.open < 0.03) closePortal();
      else if (portal.life <= 0) closePortal();
    }

    // items that popped out of a broken box
    updateDrops(dt);

    promptEl.style.display = 'none';

    // crosshair turns red when a head is lined up
    {
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      let onHead = false;
      for (const e of enemies) {
        if (e.state === 'dying') continue;
        if (isHeadshot(e, camera.position, fwd)) { onHead = true; break; }
      }
      crosshairEl.classList.toggle('head', onHead);
    }

    // enemies — one misbehaving enemy must never freeze the render loop
    for (const e of enemies) {
      try {
        updateEnemy(e, dt);
      } catch (err) {
        if ((window.__enemyErrs = (window.__enemyErrs || 0) + 1) <= 3) console.error('enemy update failed', e.kind, err);
        e.hp = 0; e.state = 'dying'; e.deadT = 3;      // retire it rather than stall
      }
    }
    for (let i = enemies.length - 1; i >= 0; i--) if (enemies[i].gone) enemies.splice(i, 1);

    // wave end
    if (game.state === 'wave' && game.spawnQueue === 0 && enemies.length === 0) endWave();

    // intermission countdown
    if (game.state === 'intermission') {
      game.interT -= dt;
      roundInfo.textContent = `NEXT ROUND IN ${Math.ceil(game.interT)}`;
      if (game.interT <= 0) startWave();
    }

    // HUD — critical health pulses the bar and the screen edges.
    // Writing these every frame forces a style recalc on top of the render, so
    // the bars only move when the number behind them actually changed.
    const crit = player.alive && player.hp > 0 && player.hp <= 30;
    if (crit !== hudLast.crit) {
      hudLast.crit = crit;
      critFx.classList.toggle('on', crit);
      critFx.style.opacity = crit ? '' : '0';
      hpBar.classList.toggle('crit', crit);
      hpLabelEl.classList.toggle('crit', crit);
    }
    if (player.hp !== hudLast.hp) {
      hudLast.hp = player.hp;
      hpBar.style.width = player.hp + '%';
    }
    // loaded: the bar shows frames left. empty: it shows the reload winding up.
    if (game.flashShots > 0) {
      chargeBar.style.width = (game.flashShots / FLASH_MAG * 100) + '%';
      if (hudLast.shots !== game.flashShots) {
        hudLast.shots = game.flashShots;
        chargeBar.style.background = 'linear-gradient(90deg,#7CFC00,#efe)';
        flashPips.textContent = '●'.repeat(game.flashShots) + '○'.repeat(FLASH_MAG - game.flashShots);
        flashPips.style.color = '#bfff6a';
      }
    } else {
      chargeBar.style.width = (game.charge * 100) + '%';
      if (hudLast.shots !== -1) {
        hudLast.shots = -1;
        chargeBar.style.background = 'linear-gradient(90deg,#c8791b,#ffd24d)';
        flashPips.textContent = 'RELOADING';
        flashPips.style.color = '#ffd24d';
      }
    }
    refreshScore();
    // the round badge carries the round now, so this only tracks the wave
    let left = game.spawnQueue;
    for (const e of enemies) if (e.state !== 'dying') left++;
    if (left !== hudLast.left) {
      hudLast.left = left;
      statsEl.textContent = `ENEMIES LEFT ${left}`;
    }
  }

  composer.render();
}
tick();
