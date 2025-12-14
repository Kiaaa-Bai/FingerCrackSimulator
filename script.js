import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ===================== BASIC SETUP =====================

const contextUI = document.getElementById('context-ui');
const currentModeEl = document.getElementById('current-mode');
const modeHintEl = document.getElementById('mode-hint');
const backBtn = document.getElementById('back-btn');
const popLayer = document.getElementById('pop-layer');
const overviewHintEl = document.getElementById('overview-hint');
const detailHintEl = document.getElementById('detail-hint');

const MODE_HINTS = {
  hand:  'Gently drag a fingertip to simulate joint cracking.',
  neck:  'Drag sideways to bend the neck.',
  waist: 'Drag sideways to twist the waist.'
};

const POP_WORDS = ['POP', 'CRACK', 'SNAP'];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b2b2b);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(1.5, 1.8, 4);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.style.touchAction = 'none';
document.body.appendChild(renderer.domElement);

// ===================== LIGHT =====================

scene.add(new THREE.AmbientLight(0xffffff, 0.8));

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 10, 5);
scene.add(dirLight);

// ===================== AUDIO =====================

const listener = new THREE.AudioListener();
camera.add(listener);

const crackSound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();
const crackBuffers = [];

['assets/crack_1.mp3', 'assets/crack_2.mp3', 'assets/crack_3.mp3', 'assets/crack_4.mp3', 'assets/crack_5.mp3', 'assets/crack_6.mp3', 'assets/crack_7.mp3', 'assets/crack_8.mp3', 'assets/crack_10.mp3']
  .forEach(f => {
    audioLoader.load(f, b => crackBuffers.push(b));
  });

// ===================== GLOBAL STATE =====================

let activeChain = null;

let model = null;
const boneMap = {};
const chains = [];
const targets = [];
const originalPositions = {};

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const dragPlane = new THREE.Plane();
let selectedTarget = null;
let dragging = false;

// ===== Drag Accumulator (screen-space) =====
let dragStartY = 0;
let dragStartX = 0;
let dragAccumX = 0;
let dragAccumY = 0;

let camTransition = null;
// {
//   fromPos, toPos,
//   fromRot, toRot,
//   t, dur
// }

// ===== View State =====
let viewState = 'overview'; // 'overview' | 'hand' | 'neck' | 'waist'

// two kinds of targets
const selectorTargets = []; // 3 balls in overview (click only)
const controlTargets = [];  // balls in detail (drag only)

const CAMERA_PRESETS = {
  overview: {
    pos: new THREE.Vector3(0.100, 1.2, 1.896),
    rot: new THREE.Euler(-0.105, 0.000, 0.000)
  },

  hand: {
    pos: new THREE.Vector3(-0.763, 1.289, 0.20),
    rot: new THREE.Euler(0.616, 0.135, 0.000)
  },

  neck: {
    pos: new THREE.Vector3(-0.031, 1.590, 0.400),
    rot: new THREE.Euler(-0.089, -0.030, 0.000)
  },

  waist: {
    pos: new THREE.Vector3(-0.031, 1.5, 1),
    rot: new THREE.Euler(-0.089, -0.030, 0.000)
  }
};

function applyCameraPreset(mode, duration = 0.4) {
  const preset = CAMERA_PRESETS[mode];
  if (!preset) return;

  camTransition = {
    fromPos: camera.position.clone(),
    toPos: preset.pos.clone(),

    fromRot: camera.rotation.clone(),
    toRot: preset.rot.clone(),

    t: 0,
    dur: duration
  };
}






// ===================== LIMIT PRESETS =====================

const LIMIT_PRESETS = {
  finger: { SOFT: 1.1, CRACK: 1.3, HARD: 1.5 },
  neck:   { SOFT: 0.35, CRACK: 0.5, HARD: 0.65 },
  waist:  { SOFT: 0.3, CRACK: 0.45, HARD: 0.6 }
};

// ===================== LOAD MODEL =====================

const loader = new GLTFLoader();
loader.load('assets/hand.glb', gltf => {

  model = gltf.scene;
  scene.add(model);

  model.traverse(o => {
    if (o.isBone) {
        console.log(o.name);
        boneMap[o.name] = o;
    }

    if (o.isMesh) {
      o.material.roughness = 0.6;
      o.material.metalness = 0.0;
    }
    if (o.isBone) boneMap[o.name] = o;
  });

  initFingers();      // create control targets for hand
  initSpine();        // create control targets for neck/waist
  initSelectors();    // create 3 selector targets
  enterOverview();    // set initial view + visibility


});

// ===================== INIT FINGERS =====================

function initFingers() {
    
  const fingerDefs = [
  ['Index', [
    'mixamorig1RightHandIndex1',
    'mixamorig1RightHandIndex2',
    'mixamorig1RightHandIndex3'
  ]],
  ['Middle', [
    'mixamorig1RightHandMiddle1',
    'mixamorig1RightHandMiddle2',
    'mixamorig1RightHandMiddle3'
  ]],
  ['Ring', [
    'mixamorig1RightHandRing1',
    'mixamorig1RightHandRing2',
    'mixamorig1RightHandRing3'
  ]],
  ['Pinky', [
    'mixamorig1RightHandPinky1',
    'mixamorig1RightHandPinky2',
    'mixamorig1RightHandPinky3'
  ]],
  ['Thumb', [
    'mixamorig1RightHandThumb1',
    'mixamorig1RightHandThumb2',
    'mixamorig1RightHandThumb3'
  ]]
];



  fingerDefs.forEach(([name, bones]) => {

    const chainBones = bones
        .map(b => boneMap[b])
        .filter(Boolean);


    if (!chainBones.length) return;

    const axis = (name === 'Thumb') ? 'z' : 'x';


    const tip = chainBones[chainBones.length - 1];
    const target = createTarget(name, 'control');
    target.userData.mode = 'hand'; // which detail mode this target belongs to


    tip.getWorldPosition(target.position);

    // 向手指局部法线方向微偏移（而不是世界 Y）
    const offset = new THREE.Vector3(0, 0.025, 0);
    offset.applyQuaternion(
        tip.getWorldQuaternion(new THREE.Quaternion())
    );

    target.position.add(offset);


    chains.push({
      type: 'finger',
      bones: chainBones,
      axis: axis,
      limits: LIMIT_PRESETS.finger,
      target,
      cracked: false,
      state: 'soft',      // 'soft' | 'hard' | 'snapped'
      prevAngle: 0
    });

    controlTargets.push(target);
    scene.add(target);

    originalPositions[name] = target.position.clone();
    scene.add(target);
  });
  console.log('targets count:', targets.length);

}

// ===================== INIT NECK / WAIST =====================

function initSpine() {

  const defs = [
  ['Neck', 'mixamorig1Neck', 'z', LIMIT_PRESETS.neck],
  ['Waist', 'mixamorig1Spine2', 'y', LIMIT_PRESETS.waist]
];



  defs.forEach(([name, boneName, axis, limits]) => {


    const bone = boneMap[boneName];
    if (!bone) return;

    const target = createTarget(name, 'control');
    target.userData.mode = name.toLowerCase(); // 'neck' or 'waist'

    bone.getWorldPosition(target.position);
    target.position.y -= 0;

    originalPositions[name] = target.position.clone();

    chains.push({
      type: name.toLowerCase(),
      bones: [bone],
      axis: axis,
      limits,
      target,
      cracked: false,
      state: 'soft',      // 'soft' | 'hard' | 'snapped'
      prevAngle: 0
    });

    controlTargets.push(target);
    scene.add(target);
  });
  console.log('targets count:', targets.length);

}

function initSelectors() {
  // 3 balls shown in overview, click only
  const defs = [
    { mode: 'hand',  bone: 'mixamorig1RightHand', offset: new THREE.Vector3(0.25, 0.15, 0) },
    { mode: 'neck',  bone: 'mixamorig1Neck',      offset: new THREE.Vector3(0, 0.25, 0) },
    { mode: 'waist', bone: 'mixamorig1Spine2',    offset: new THREE.Vector3(0, 0.25, 0) }
  ];

  defs.forEach(d => {
    const b = boneMap[d.bone];
    if (!b) return;

    const t = createTarget(d.mode, 'selector');
    t.userData.mode = d.mode;

    const p = new THREE.Vector3();
    b.getWorldPosition(p);
    t.position.copy(p).add(d.offset);

    selectorTargets.push(t);
    scene.add(t);
  });
}

function enterOverview() {
  viewState = 'overview';

  selectorTargets.forEach(t => (t.visible = true));
  controlTargets.forEach(t => (t.visible = false));

  contextUI.hidden = true;
  if (overviewHintEl) overviewHintEl.hidden = false;
  if (detailHintEl) detailHintEl.hidden = true;

  applyCameraPreset('overview');
}

function enterDetail(mode) {
  viewState = mode;

  selectorTargets.forEach(t => (t.visible = false));

  controlTargets.forEach(t => {
    t.visible = (t.userData.mode === mode);
  });

  applyCameraPreset(mode);

   // === UI ===
  contextUI.hidden = false;
  currentModeEl.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
  modeHintEl.textContent = MODE_HINTS[mode] || '';
  if (overviewHintEl) overviewHintEl.hidden = true;
  if (detailHintEl) detailHintEl.hidden = false;
}




// ===================== TARGET SPHERE =====================

function createTarget(name, kind) {

  const radius = (kind === 'selector') ? 0.1 : 0.07;
  // selector 大，control 小

  const geo = new THREE.SphereGeometry(radius, 16, 16);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x00ff00,
    transparent: true,
    opacity: (kind === 'selector') ? 0.55 : 0.75,
    depthTest: false
  });

  const m = new THREE.Mesh(geo, mat);
  m.userData.name = name;
  m.userData.kind = kind;
  m.renderOrder = 999;
  m.visible = false;
  return m;
}



// ===================== IK SOLVER =====================

function solveChains() {
  if (!activeChain) return;

  const c = activeChain;

  // ===== 颈部 / 腰部 =====
  if (c.bones.length === 1) {
    solveSingle(c);
    return;
  }

  // ===== 手指 =====
  const origin = originalPositions[c.target.userData.name];
  if (!origin) return;

  // 👉 用 screen-space 拖动作为主输入（比世界坐标稳定）
  // 正值 = 朝手心，负值 = 朝手背
  const input = -dragAccumY * 1 // ⭐ 灵敏度在这里调（1.4–2.0 都合理）
  const absInput = Math.abs(input);

  const isPalmSide = input > 0;   // 朝手心
  const isBackSide = input < 0;   // 朝手背

  // ===============================
  // ⭐ 方向感知的人体极限（核心）
  // ===============================

  const softLimit  = isPalmSide
    ? c.limits.SOFT * 1.25   // 手心：正常活动很大
    : c.limits.SOFT * 0.55;  // 手背：正常活动很小

  const crackLimit = isPalmSide
    ? c.limits.CRACK * 1.35  // 手心：需要掰很大才咔
    : c.limits.CRACK * 1.35; // 手背：很小就咔

  const hardLimit  = isPalmSide
    ? c.limits.HARD * 1.15
    : c.limits.HARD * 0.65;

  // ===============================
  // ⭐ 卡顿 → SNAP 状态机
  // ===============================

  let angle = 0;

  if (absInput < softLimit) {
    // 正常活动区
    c.state = 'soft';
    angle = input;
  }

  else if (absInput < crackLimit) {
    // 卡住区（明显阻尼）
    c.state = 'hard';

    angle = THREE.MathUtils.lerp(
      c.prevAngle,
      Math.sign(input) * softLimit,
      0.10 // ⭐ 越小越“卡”
    );
  }

else {
  if (c.state !== 'snapped') {
    triggerCrackSound();

    const jointPos = new THREE.Vector3();
    c.bones[c.bones.length - 1].getWorldPosition(jointPos);
    showPopEffect(jointPos, 'snap');
  }

  c.state = 'snapped';
  angle = Math.sign(input) * hardLimit;
}



  c.prevAngle = angle;

  // ===============================
  // ⭐ 分段弯曲（更真实）
  // ===============================

  c.bones.forEach((b, i) => {
    const weight =
      i === 0 ? 0.45 :
      i === 1 ? 0.35 :
               0.20;

    b.rotation[c.axis] = angle * weight;
  });
}




function solveSingle(c) {

  const bone = c.bones[0];
  const origin = originalPositions[c.target.userData.name];
  if (!origin) return;

  // 用 target 偏移量直接驱动角度（关键）
  const offset = c.target.position.clone().sub(origin);

let input = dragAccumX * 0.1;

if (c.type === 'neck') {
  input = -dragAccumX * 0.1;   // 脖子：反向 + 降低灵敏度
}

if (c.type === 'waist') {
  input = dragAccumX * 0.08;    // 腰：同向，稍微慢一点
}

let angle = 0;

if (Math.abs(input) < c.limits.SOFT) {
  c.state = 'soft';
  angle = input;
}

else if (Math.abs(input) < c.limits.CRACK) {
  c.state = 'hard';

  angle = THREE.MathUtils.lerp(
    c.prevAngle,
    Math.sign(input) * c.limits.SOFT,
    0.15
  );
}

else {
  if (c.state !== 'snapped') {
    triggerCrackSound();

    const jointPos = new THREE.Vector3();
    bone.getWorldPosition(jointPos);
    showPopEffect(jointPos, c.type);
  }

  c.state = 'snapped';
  angle = Math.sign(input) * c.limits.HARD;
}



c.prevAngle = angle;


  // 平滑回正 / 跟随
  bone.rotation[c.axis] = THREE.MathUtils.lerp(
    bone.rotation[c.axis],
    angle,
    dragging ? 1.0 : 0.18
  );
}



// ===================== CRACK =====================

function triggerCrackSound() {
  if (!crackBuffers.length) return;

  crackSound.stop();
  crackSound.setBuffer(
    crackBuffers[Math.floor(Math.random() * crackBuffers.length)]
  );
  crackSound.setVolume(1);
  crackSound.play();
}





// ===================== INTERACTION =====================

window.addEventListener('pointerdown', e => {

  if (listener.context.state === 'suspended') {
    listener.context.resume();
  }

  setMouse(e);
  raycaster.setFromCamera(mouse, camera);

  // === OVERVIEW: click selector only ===
  if (viewState === 'overview') {
    const hit = raycaster.intersectObjects(selectorTargets.filter(t => t.visible))[0];
    if (hit) {
      hit.object.material.color.setHex(0xffff00);
      enterDetail(hit.object.userData.mode);
      setTimeout(() => hit.object.material.color.setHex(0x00ff00), 200);
    }
    return; // IMPORTANT: no dragging in overview
  }

  // === DETAIL: drag control only ===
  const hit = raycaster.intersectObjects(controlTargets.filter(t => t.visible))[0];
  if (!hit) return;

  selectedTarget = hit.object;
  dragging = true;
  activeChain = chains.find(c => c.target === selectedTarget);

  selectedTarget.material.color.setHex(0xffff00);

  dragStartY = e.clientY;
  dragStartX = e.clientX;
  dragAccumX = 0;
  dragAccumY = 0;


  camera.getWorldDirection(dragPlane.normal);
  dragPlane.constant = -selectedTarget.position.dot(dragPlane.normal);
});

function getCameraLookAt() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  return camera.position.clone().add(dir);
}


window.addEventListener('pointermove', e => {

    if (!dragging) return;

    // === screen-space drag ===
    dragAccumY = (dragStartY - e.clientY) * 0.01;
    dragAccumX = (e.clientX - dragStartX) * 0.01;

  if (!dragging || !selectedTarget) return;

  setMouse(e);
  raycaster.setFromCamera(mouse, camera);

  const p = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(dragPlane, p)) {
    selectedTarget.position.copy(p);
  }
});


window.addEventListener('pointerup', () => {
  if (selectedTarget) {
    selectedTarget.material.color.setHex(0x00ff00);
  }
  selectedTarget = null;
  dragging = false;
  activeChain = null;

});


// ===================== CAMERA FOCUS =====================

function focusCamera(target) {

  const p = new THREE.Vector3();
  target.getWorldPosition(p);

  camera.position.lerp(
    new THREE.Vector3(p.x + 0.9, p.y + 0.5, p.z + 0.9),
    0.6
  );
}

// ===================== UTILS =====================

function setMouse(e) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
}

// ===================== POP EFFECT =====================

function showPopEffect(worldPosition, type) {
  if (!popLayer || !worldPosition) return;

  const p = worldPosition.clone().project(camera);
  if (p.z > 1) return; // behind camera

  const x = (p.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
  const y = (-p.y * 0.5 + 0.5) * renderer.domElement.clientHeight;

  const wordPool = POP_WORDS.slice();
  if (type && POP_WORDS.includes(type.toUpperCase())) {
    wordPool.push(type.toUpperCase()); // bias toward provided type but keep randomness
  }
  const word = wordPool[Math.floor(Math.random() * wordPool.length)];

  const el = document.createElement('div');
  el.className = 'pop-effect';
  el.textContent = word;

  const hue = 90 + Math.random() * 40; // yellow-green to bright green
  const color = `hsl(${Math.floor(hue)}, 95%, 65%)`;
  const size = 22 + Math.random() * 10; // px
  const dur = 0.3 + Math.random() * 0.2; // 300–500ms

  el.style.color = color;
  el.style.fontSize = `${size}px`;
  el.style.left = `${x}px`;
  const yOffset = type === 'waist' ? 200 : -16; // waist pops sit noticeably lower
  el.style.top = `${y + yOffset}px`;
  el.style.animation = `pop-burst ${dur}s ease-out forwards`;

  popLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ===================== LOOP =====================

function animate() {
  requestAnimationFrame(animate);

  if (!dragging && viewState !== 'overview') {
  controlTargets.forEach(t => {
    const o = originalPositions[t.userData.name];
    if (o) t.position.lerp(o, 0.22);
  });
}


  solveChains();

  chains.forEach(c => {
  if (dragging) return;

  const speed = c.state === 'snapped' ? 0.05 : 0.2;

  c.bones.forEach(b => {
    b.rotation[c.axis] = THREE.MathUtils.lerp(
      b.rotation[c.axis],
      0,
      speed
    );
  });

  if (Math.abs(c.prevAngle) < 0.01) {
    c.state = 'soft';
    c.prevAngle = 0;
  }
});


// === keep control targets visually small ===
controlTargets.forEach(t => {
  if (!t.visible) return;

  const dist = camera.position.distanceTo(t.position);

  // 这个 0.04 可以调：越小越精细
  const s = dist * 0.4;

  t.scale.setScalar(s);
});

if (camTransition) {
  camTransition.t += 1 / 60;
  const a = Math.min(camTransition.t / camTransition.dur, 1);

  // smoothstep（非常重要，比 linear 好很多）
  const k = a * a * (3 - 2 * a);

  camera.position.lerpVectors(
    camTransition.fromPos,
    camTransition.toPos,
    k
  );

  camera.rotation.set(
    THREE.MathUtils.lerp(camTransition.fromRot.x, camTransition.toRot.x, k),
    THREE.MathUtils.lerp(camTransition.fromRot.y, camTransition.toRot.y, k),
    THREE.MathUtils.lerp(camTransition.fromRot.z, camTransition.toRot.z, k)
  );

  if (a >= 1) camTransition = null;
}


  renderer.render(scene, camera);
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') enterOverview();
});

backBtn.addEventListener('click', () => {
  enterOverview();
});
