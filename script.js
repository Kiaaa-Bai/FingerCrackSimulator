import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ================= Core Tuning Section =================

const INITIAL_OFFSET = 0; 
const BEND_DIRECTION = -1; 
const ROTATION_AXIS = 'x';
const TARGET_OFFSET_DIST = 0.15; 

// 5. Physical limits (radians) - fine-tuned
const LIMITS = {
    // Bend backward
    SOFT_EXTENSION: -0.3,       // Resistance point (slight hyperextension)
    CRACK_EXT_THRESHOLD: -0.5,  // ★ Sound trigger point (between soft/hard)
    HARD_EXTENSION: -0.8,       // ★ Hard limit (max after crack to avoid extreme bend)

    // Curl forward
    SOFT_CURL: 1.3,
    CRACK_CURL_THRESHOLD: 1.45,
    HARD_CURL: 1.5              // ★ Fist limit (avoid clipping into palm)
};

const RESTORE_SPEED = 0.2;

// ===============================================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x333333);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(1, 2, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.style.touchAction = 'none'; 
document.body.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.8); 
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(5, 10, 5);
scene.add(dirLight);

let handModel = null;
const ikChains = []; 
const targetMeshes = []; 
const boneMap = {}; 
const originalPositions = {}; 

const fingersConfig = [
    { name: 'Index', bones: ['Index_1', 'Index_2', 'Index_3'] },
    { name: 'Middle', bones: ['Middle_1', 'Middle_2', 'Middle_3'] },
    { name: 'Ring', bones: ['Ring_1', 'Ring_2', 'Ring_3'] },
    { name: 'Pinky', bones: ['Pinky_1', 'Pinky_2', 'Pinky_3'] },
    { name: 'Thumb', bones: ['Thumb_1', 'Thumb_2', 'Thumb_3'] }
];

// --- Audio system ---
const listener = new THREE.AudioListener();
camera.add(listener);
const crackSound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();
const crackBuffers = [];

// Load audio and log
['assets/crack_1.mp3', 'assets/crack_2.mp3', 'assets/crack_3.mp3', 'assets/crack_4.mp3'].forEach(file => {
    audioLoader.load(file, (buffer) => {
        crackBuffers.push(buffer);
        console.log(`✅ Audio loaded: ${file}`);
    }, undefined, (err) => {
        console.error(`❌ Audio failed: ${file}`, err);
    });
});

const loader = new GLTFLoader();
loader.load('assets/Hand.glb', function (gltf) {
    handModel = gltf.scene;
    scene.add(handModel);
    handModel.position.y = -1.5;
    handModel.rotation.y = -Math.PI / 1.7;

    handModel.traverse((o) => {
        if (o.isMesh) {
            o.material.roughness = 0.7;
            o.material.metalness = 0.0;
        }
        if (o.isBone) {
            boneMap[o.name] = o;
        }
    });

    initSystem();

}, undefined, function (error) {
    console.error(error);
});

function initSystem() {
    fingersConfig.forEach(config => {
        const chainBones = [];
        config.bones.forEach(bName => {
            if (boneMap[bName]) {
                const b = boneMap[bName];
                chainBones.push(b);
                b.rotation[ROTATION_AXIS] = INITIAL_OFFSET;
            }
        });

        if (chainBones.length === 0) return;

        const effectorBone = chainBones[chainBones.length - 1];

        const targetMesh = createTargetMesh(config.name);
        scene.add(targetMesh);
        targetMeshes.push(targetMesh);

        handModel.updateMatrixWorld(true);
        const tipPos = new THREE.Vector3();
        effectorBone.getWorldPosition(tipPos);
        
        const offsetVec = new THREE.Vector3(0, TARGET_OFFSET_DIST, 0);
        offsetVec.applyQuaternion(effectorBone.getWorldQuaternion(new THREE.Quaternion()));
        targetMesh.position.copy(tipPos).add(offsetVec);

        originalPositions[config.name] = targetMesh.position.clone();

        ikChains.push({
            bones: chainBones,      
            effector: effectorBone, 
            target: targetMesh,
            isCracked: false,
            lastCrackTime: 0 
        });
    });
}

function createTargetMesh(name) {
    const geometry = new THREE.SphereGeometry(0.18, 16, 16);
    const material = new THREE.MeshBasicMaterial({ 
        color: 0x00ff00, 
        transparent: true, 
        opacity: 0.5,
        depthTest: false
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { name: name, isTarget: true };
    mesh.renderOrder = 999;
    return mesh;
}

function solveIK() {
    if (!handModel) return;
    handModel.updateMatrixWorld(true);

    ikChains.forEach(chain => {
        const { bones, effector, target } = chain;
        const targetPos = target.position;

        // Iterate 10 times for accuracy
        for (let i = 0; i < 10; i++) {
            for (let j = bones.length - 2; j >= 0; j--) {
                const bone = bones[j];
                // Weight: fingertip (j=1) agile, base (j=0) sluggish
                let weight = (j === 0) ? 0.3 : 1.2; 

                // --- 1. Compute vectors ---
                const effectorPos = new THREE.Vector3();
                effector.getWorldPosition(effectorPos);
                const bonePos = new THREE.Vector3();
                bone.getWorldPosition(bonePos);

                const toEffector = effectorPos.sub(bonePos).normalize();
                const toTarget = targetPos.clone().sub(bonePos).normalize();

                const boneInverseQ = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
                const localToTarget = toTarget.clone().applyQuaternion(boneInverseQ);
                const localToEffector = toEffector.clone().applyQuaternion(boneInverseQ);

                // --- 2. Calculate raw intent ---
                const angleCurrent = Math.atan2(localToEffector.y, localToEffector.z);
                const angleTarget = Math.atan2(localToTarget.y, localToTarget.z);
                
                // This is the actual angle the mouse wants, possibly large
                let rawDiff = (angleTarget - angleCurrent) * BEND_DIRECTION;

                if (Math.abs(rawDiff) < 0.0001) continue;

                // --- 3. ★ Sound trigger (based on intent) ★ ---
                // Compute where the bone would go with no speed cap and use it to trigger sound.
                // Even if physically clamped, dragging far still triggers.
                let virtualAngle = bone.rotation[ROTATION_AXIS] + (rawDiff * weight);
                let virtualRelative = virtualAngle - INITIAL_OFFSET;

                if (!chain.isCracked) {
                    // Backward bend check
                    if (virtualRelative < LIMITS.CRACK_EXT_THRESHOLD && rawDiff < 0) {
                        triggerCrack(chain);
                    }
                    // Forward curl check
                    if (virtualRelative > LIMITS.CRACK_CURL_THRESHOLD && rawDiff > 0) {
                        triggerCrack(chain);
                    }
                }

                // --- 4. ★ Physical motion (hard limits) ★ ---
                
                // (A) Step clamp: prevent jitter
                // Each frame the bone turns at most 0.06 rad.
                // No matter how fast the mouse moves, the bone follows slowly to avoid jitter/stretch.
                let clampedDiff = rawDiff;
                if (clampedDiff > 0.1) clampedDiff = 0.1;
                if (clampedDiff < -0.1) clampedDiff = -0.1;
                
                // Apply weight
                let newAngle = bone.rotation[ROTATION_AXIS] + (clampedDiff * weight);
                let relativeAngle = newAngle - INITIAL_OFFSET;

                // (B) Hard limits: avoid clipping and overextension
                let currentExtLimit = LIMITS.SOFT_EXTENSION; // Default clamp at soft limit
                let currentCurlLimit = LIMITS.SOFT_CURL;

                if (chain.isCracked) {
                    // After cracking, allow hard limits
                    currentExtLimit = LIMITS.HARD_EXTENSION;
                    currentCurlLimit = LIMITS.HARD_CURL;
                }

                // Force clamp to limits
                if (relativeAngle < currentExtLimit) newAngle = INITIAL_OFFSET + currentExtLimit;
                if (relativeAngle > currentCurlLimit) newAngle = INITIAL_OFFSET + currentCurlLimit;

                // --- 5. Reset detection ---
                // Allow next crack only after returning to safe zone
                if (relativeAngle > LIMITS.SOFT_EXTENSION + 0.2 && 
                    relativeAngle < LIMITS.SOFT_CURL - 0.2) {
                    chain.isCracked = false;
                }

                // Apply final safe angle
                bone.rotation[ROTATION_AXIS] = newAngle;
                bone.updateMatrixWorld(true);
            }
        }
    });
}

function triggerCrack(chain) {
    const now = Date.now();
    // ★ Core fix: cooldown set to 1000ms to prevent rapid fire
    if (now - chain.lastCrackTime < 1000) return;
    chain.lastCrackTime = now;

    // Play sound
    if (crackBuffers.length > 0) {
        const idx = Math.floor(Math.random() * crackBuffers.length);
        if (crackSound.isPlaying) crackSound.stop(); // Interrupt previous
        crackSound.setBuffer(crackBuffers[idx]);
        crackSound.setVolume(1.0);
        crackSound.play();
        if (crackSound.source && crackSound.source.detune) {
            crackSound.setDetune((Math.random() - 0.5) * 400);
        }
    }
    chain.isCracked = true;

    // Visual micro jitter
    const rootBone = chain.bones[0];
    const originalY = rootBone.position.y;
    rootBone.position.y += 0.05;
    setTimeout(() => { rootBone.position.y = originalY; }, 80);
}


// --- Interaction system ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const dragPlane = new THREE.Plane(); 
let selectedTarget = null;
let isDragging = false;

window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    
    // ★ Wake AudioContext (important)
    if (listener.context.state === 'suspended') {
        listener.context.resume().then(() => {
            console.log("🔊 AudioContext Resumed");
        });
    }

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(targetMeshes);

    if (intersects.length > 0) {
        controls.enabled = false;
        selectedTarget = intersects[0].object;
        isDragging = true;
        selectedTarget.material.color.setHex(0xffff00);
        camera.getWorldDirection(dragPlane.normal);
        dragPlane.constant = -selectedTarget.position.dot(dragPlane.normal);
    }
});

window.addEventListener('pointermove', (e) => {
    if (isDragging && selectedTarget) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        
        const intersectPoint = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(dragPlane, intersectPoint)) {
            selectedTarget.position.copy(intersectPoint);
        }
        return; 
    }

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(targetMeshes);
    if (intersects.length > 0) {
        document.body.style.cursor = 'grab';
        intersects[0].object.material.opacity = 0.8;
    } else {
        document.body.style.cursor = 'default';
        targetMeshes.forEach(m => m.material.opacity = 0.5);
    }
});

window.addEventListener('pointerup', (e) => {
    if (isDragging) {
        controls.enabled = true;
        if (selectedTarget) selectedTarget.material.color.setHex(0x00ff00);
        selectedTarget = null;
        isDragging = false;
    }
});

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

function animate() {
    requestAnimationFrame(animate);

    if (!isDragging) {
        targetMeshes.forEach(target => {
            const name = target.userData.name;
            const originalPos = originalPositions[name];
            if (originalPos) {
                if (target.position.distanceTo(originalPos) > 0.0001) {
                    target.position.lerp(originalPos, RESTORE_SPEED);
                } else {
                    target.position.copy(originalPos);
                }
            }
        });
    }

    solveIK(); 
    controls.update();
    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
