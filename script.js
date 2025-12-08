import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ================= 🔧 核心调优区 =================

const INITIAL_OFFSET = 0; 
const BEND_DIRECTION = -1; 
const ROTATION_AXIS = 'x';
const TARGET_OFFSET_DIST = 0.15; 

// 5. 物理限制 (弧度) - 参数微调版
const LIMITS = {
    // 向后掰
    SOFT_EXTENSION: -0.3,       // 阻力点 (轻微后弯)
    CRACK_EXT_THRESHOLD: -0.5,  // ★ 声音触发点 (介于软硬之间)
    HARD_EXTENSION: -0.8,       // ★ 硬极限 (掰响后最多弯到这，防止太恐怖)

    // 向前握拳
    SOFT_CURL: 1.3,
    CRACK_CURL_THRESHOLD: 1.45,
    HARD_CURL: 1.5              // ★ 握拳极限 (防止穿模插进手掌)
};

const RESTORE_SPEED = 0.2;

// ===============================================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x333333);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 2, 4);

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

// --- 音频系统 ---
const listener = new THREE.AudioListener();
camera.add(listener);
const crackSound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();
const crackBuffers = [];

// 加载音频并打印日志
['assets/crack_1.mp3', 'assets/crack_2.mp3', 'assets/crack_3.mp3', 'assets/crack_4.mp3'].forEach(file => {
    audioLoader.load(file, (buffer) => {
        crackBuffers.push(buffer);
        console.log(`✅ 音频加载成功: ${file}`);
    }, undefined, (err) => {
        console.error(`❌ 音频加载失败: ${file}`, err);
    });
});

const loader = new GLTFLoader();
loader.load('assets/Hand.glb', function (gltf) {
    handModel = gltf.scene;
    scene.add(handModel);
    handModel.position.y = 0;
    handModel.rotation.y = -Math.PI / 12;

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

        // 迭代 10 次保证精度
        for (let i = 0; i < 10; i++) {
            for (let j = bones.length - 2; j >= 0; j--) {
                const bone = bones[j];
                // 权重：指尖(j=1)灵活，根部(j=0)迟钝
                let weight = (j === 0) ? 0.3 : 1.2; 

                // --- 1. 计算向量 ---
                const effectorPos = new THREE.Vector3();
                effector.getWorldPosition(effectorPos);
                const bonePos = new THREE.Vector3();
                bone.getWorldPosition(bonePos);

                const toEffector = effectorPos.sub(bonePos).normalize();
                const toTarget = targetPos.clone().sub(bonePos).normalize();

                const boneInverseQ = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
                const localToTarget = toTarget.clone().applyQuaternion(boneInverseQ);
                const localToEffector = toEffector.clone().applyQuaternion(boneInverseQ);

                // --- 2. 计算原始意图 (Raw Intent) ---
                const angleCurrent = Math.atan2(localToEffector.y, localToEffector.z);
                const angleTarget = Math.atan2(localToTarget.y, localToTarget.z);
                
                // 这是鼠标真正想让骨头转的角度，可能非常大
                let rawDiff = (angleTarget - angleCurrent) * BEND_DIRECTION;

                if (Math.abs(rawDiff) < 0.0001) continue;

                // --- 3. ★ 声音触发 (基于意图) ★ ---
                // 我们计算如果"不限制速度"，骨头会去哪里。用这个值来判断是否响。
                // 这样即使骨头被物理限制卡住了，只要你鼠标拉得远，照样响。
                let virtualAngle = bone.rotation[ROTATION_AXIS] + (rawDiff * weight);
                let virtualRelative = virtualAngle - INITIAL_OFFSET;

                if (!chain.isCracked) {
                    // 向后掰检测
                    if (virtualRelative < LIMITS.CRACK_EXT_THRESHOLD && rawDiff < 0) {
                        triggerCrack(chain);
                    }
                    // 向前握拳检测
                    if (virtualRelative > LIMITS.CRACK_CURL_THRESHOLD && rawDiff > 0) {
                        triggerCrack(chain);
                    }
                }

                // --- 4. ★ 物理运动 (强力限制) ★ ---
                
                // (A) 步长钳制：防止鬼畜
                // 每一帧，骨头最多转 0.06 弧度。
                // 无论鼠标甩多快，骨头只能慢慢跟过去，这就消除了鬼畜和变长。
                let clampedDiff = rawDiff;
                if (clampedDiff > 0.1) clampedDiff = 0.1;
                if (clampedDiff < -0.1) clampedDiff = -0.1;
                
                // 应用权重
                let newAngle = bone.rotation[ROTATION_AXIS] + (clampedDiff * weight);
                let relativeAngle = newAngle - INITIAL_OFFSET;

                // (B) 极限限制：防止穿模和后弯太大
                let currentExtLimit = LIMITS.SOFT_EXTENSION; // 默认卡在软极限
                let currentCurlLimit = LIMITS.SOFT_CURL;

                if (chain.isCracked) {
                    // 响过之后，允许去硬极限
                    currentExtLimit = LIMITS.HARD_EXTENSION;
                    currentCurlLimit = LIMITS.HARD_CURL;
                }

                // 强制卡在极限内
                if (relativeAngle < currentExtLimit) newAngle = INITIAL_OFFSET + currentExtLimit;
                if (relativeAngle > currentCurlLimit) newAngle = INITIAL_OFFSET + currentCurlLimit;

                // --- 5. 复位检测 ---
                // 只有完全回到安全区，才允许下一次响
                if (relativeAngle > LIMITS.SOFT_EXTENSION + 0.2 && 
                    relativeAngle < LIMITS.SOFT_CURL - 0.2) {
                    chain.isCracked = false;
                }

                // 应用最终计算出的安全角度
                bone.rotation[ROTATION_AXIS] = newAngle;
                bone.updateMatrixWorld(true);
            }
        }
    });
}

function triggerCrack(chain) {
    const now = Date.now();
    // ★ 核心修复：冷却时间设为 1000ms，彻底杜绝连发
    if (now - chain.lastCrackTime < 1000) return;
    chain.lastCrackTime = now;

    // 播放声音
    if (crackBuffers.length > 0) {
        const idx = Math.floor(Math.random() * crackBuffers.length);
        if (crackSound.isPlaying) crackSound.stop(); // 打断上一次
        crackSound.setBuffer(crackBuffers[idx]);
        crackSound.setVolume(1.0);
        crackSound.play();
        if (crackSound.source && crackSound.source.detune) {
            crackSound.setDetune((Math.random() - 0.5) * 400);
        }
    }
    chain.isCracked = true;

    // 视觉微抖动
    const rootBone = chain.bones[0];
    const originalY = rootBone.position.y;
    rootBone.position.y += 0.003;
    setTimeout(() => { rootBone.position.y = originalY; }, 80);
}


// --- 交互系统 ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const dragPlane = new THREE.Plane(); 
let selectedTarget = null;
let isDragging = false;

window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    
    // ★ 唤醒 AudioContext (重要)
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
