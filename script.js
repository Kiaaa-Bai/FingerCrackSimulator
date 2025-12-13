import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ===================== BASIC SETUP =====================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b2b2b);

const camera = new THREE.PerspectiveCamera(
  10,
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

['assets/crack_1.mp3', 'assets/crack_2.mp3', 'assets/crack_3.mp3', 'assets/crack_4.mp3']
  .forEach(f => {
    audioLoader.load(f, b => crackBuffers.push(b));
  });

// ===================== GLOBAL STATE =====================

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
// ===== View State =====
let viewState = 'overview'; // 'overview' | 'hand' | 'neck' | 'waist'

// two kinds of targets
const selectorTargets = []; // 3 balls in overview (click only)
const controlTargets = [];  // balls in detail (drag only)

// camera animation
let camAnim = null; // { fromPos, toPos, fromLook, toLook, t, dur }

const CAMERA_PRESETS = {
  overview: {
    pos:  new THREE.Vector3(0, 1.2, 12),
    look: new THREE.Vector3(0, 1.0, 0)
  },

  hand: {
    // 🔴 你之后只调这 6 个数字
    pos:  new THREE.Vector3(-1, 2, 0.5),
    look: new THREE.Vector3(0, 0, 1)
  },

  neck: {
    pos:  new THREE.Vector3(0, 1.9, 2.0),
    look: new THREE.Vector3(0, 1.7, 0)
  },

  waist: {
    pos:  new THREE.Vector3(0, 1.2, 2.4),
    look: new THREE.Vector3(0, 1.0, 0)
  }
};




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
      axis: 'x',
      limits: LIMIT_PRESETS.finger,
      target,
      cracked: false,
      lastCrack: 0
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
    target.position.y += 0.25;

    originalPositions[name] = target.position.clone();

    chains.push({
      type: name.toLowerCase(),
      bones: [bone],
      axis: axis,
      limits,
      target,
      cracked: false,
      lastCrack: 0
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

  // show only selectors
  selectorTargets.forEach(t => (t.visible = true));
  controlTargets.forEach(t => (t.visible = false));

  // reset camera
  animateCamera(
  CAMERA_PRESETS.overview.pos,
  CAMERA_PRESETS.overview.look,
  0.7
);

}

function enterDetail(mode) {
  viewState = mode;

  // hide selectors
  selectorTargets.forEach(t => (t.visible = false));

  // show only relevant control targets
  controlTargets.forEach(t => {
    t.visible = (t.userData.mode === mode);
  });

  const preset = CAMERA_PRESETS[mode];
  if (preset) {
    animateCamera(preset.pos, preset.look, 0.6);
  }
}



// ===================== TARGET SPHERE =====================

function createTarget(name, kind) {

  const radius = (kind === 'selector') ? 0.18 : 0.07;
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

  chains.forEach(c => {

    if (c.bones.length === 1) {
      solveSingle(c);
      return;
    }

    const curl = c.target.position.y - originalPositions[c.target.userData.name].y;
    let angle = THREE.MathUtils.clamp(-curl * 3, -c.limits.HARD, c.limits.HARD);

    triggerCheck(c, angle);

    c.bones.forEach((b, i) => {
      b.rotation[c.axis] = angle * (i === 0 ? 0.4 : i === 1 ? 0.35 : 0.25);
    });
  });
}

function solveSingle(c) {

  const bone = c.bones[0];
  const origin = originalPositions[c.target.userData.name];
  if (!origin) return;

  // 用 target 偏移量直接驱动角度（关键）
  const offset = c.target.position.clone().sub(origin);

  let angle = 0;

  if (c.axis === 'z') {
    // 脖子：左右歪头（拖左右）
    angle = THREE.MathUtils.clamp(
      -offset.x * 2.5,
      -c.limits.HARD,
      c.limits.HARD
    );
  }

  if (c.axis === 'y') {
    // 腰：左右扭腰（拖左右）
    angle = THREE.MathUtils.clamp(
      offset.x * 2.0,
      -c.limits.HARD,
      c.limits.HARD
    );
  }

  // crack 检测
  triggerCheck(c, angle);

  // 平滑回正 / 跟随
  bone.rotation[c.axis] = THREE.MathUtils.lerp(
    bone.rotation[c.axis],
    angle,
    dragging ? 1.0 : 0.18
  );
}



// ===================== CRACK =====================

function triggerCheck(chain, angle) {

  const now = Date.now();
  if (!chain.cracked && Math.abs(angle) > chain.limits.CRACK) {

    if (now - chain.lastCrack > 900 && crackBuffers.length) {
      chain.lastCrack = now;
      chain.cracked = true;

      crackSound.stop();
      crackSound.setBuffer(
        crackBuffers[Math.floor(Math.random() * crackBuffers.length)]
      );
      crackSound.setVolume(1);
      crackSound.play();
    }
  }

  if (Math.abs(angle) < chain.limits.SOFT) {
    chain.cracked = false;
  }
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
  selectedTarget.material.color.setHex(0xffff00);

  camera.getWorldDirection(dragPlane.normal);
  dragPlane.constant = -selectedTarget.position.dot(dragPlane.normal);
});


function animateCamera(toPos, toLookAt, duration = 0.6) {
  camAnim = {
    fromPos: camera.position.clone(),
    toPos: toPos.clone(),
    fromLook: getCameraLookAt(),
    toLook: toLookAt.clone(),
    t: 0,
    dur: duration
  };
}

function getCameraLookAt() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  return camera.position.clone().add(dir);
}


window.addEventListener('pointermove', e => {
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
  // camera tween
if (camAnim) {
  camAnim.t += 1 / 60;
  const a = Math.min(camAnim.t / camAnim.dur, 1);
  const k = a * a * (3 - 2 * a); // smoothstep

  camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, k);

  const look = new THREE.Vector3().lerpVectors(camAnim.fromLook, camAnim.toLook, k);
  camera.lookAt(look);

  if (a >= 1) camAnim = null;
}

// === keep control targets visually small ===
controlTargets.forEach(t => {
  if (!t.visible) return;

  const dist = camera.position.distanceTo(t.position);

  // 这个 0.04 可以调：越小越精细
  const s = dist * 0.1;

  t.scale.setScalar(s);
});

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
