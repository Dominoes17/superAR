import * as THREE from "https://esm.sh/three@0.164.1";
import { GLTFLoader } from "https://esm.sh/three@0.164.1/examples/jsm/loaders/GLTFLoader.js";

const GLASSES_OPTIONS = {
  black: {
    label: "Black",
    path: "assets/black2.glb?v=bottom-selector-20260515",
  },
  gold: {
    label: "Gold",
    path: "assets/gold.glb?v=bottom-selector-20260515",
  },
};

const video = document.getElementById("camera");
const canvas = document.getElementById("ar-canvas");
const loader = document.getElementById("loader");
const statusText = document.getElementById("status");
const debugEnabled = new URLSearchParams(window.location.search).has("debug");
const debugText = document.createElement("pre");

const fitAdjustments = {
  scale: 0.58,
  offsetX: 0,
  offsetY: -26,
  tilt: 180,
};

const ENABLE_FACE_OCCLUDER = false;

let faceMesh = null;
let trackingFrame = null;
let renderFrame = null;
let isDetecting = false;
let lastSeenAt = 0;
let glassesModel = null;
let activeGlassesKey = "black";
let availableGlassesKeys = [];
let hasTrackedFace = false;
const modelCache = new Map();
let modelBaseWidth = 1;

let lastFit = {
  x: 0,
  y: 0,
  width: 280,
  faceWidth: 320,
  angle: 0,
  yaw: 0,
  pitch: 0,
};

if (debugEnabled) {
  debugText.style.cssText =
    "position:absolute;left:8px;top:8px;z-index:4;margin:0;padding:8px;color:#0f0;background:rgb(0 0 0 / .72);font:11px/1.25 monospace;pointer-events:none";
  document.querySelector(".try-on").append(debugText);
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
});
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -1000, 1000);

scene.add(new THREE.AmbientLight(0xffffff, 2.2));

const faceOccluder = new THREE.Mesh(
  new THREE.CircleGeometry(1, 64),
  new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  }),
);
faceOccluder.visible = false;
faceOccluder.renderOrder = 1;
scene.add(faceOccluder);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(0, -1, 3);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xb8d7ff, 0.9);
fillLight.position.set(-2, 1, 2);
scene.add(fillLight);

function controlValue(name) {
  return fitAdjustments[name];
}

function setStatus(message) {
  statusText.textContent = message;
}

function resizeRenderer() {
  const stage = video.getBoundingClientRect();
  const width = Math.max(1, Math.round(stage.width));
  const height = Math.max(1, Math.round(stage.height));
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);

  camera.left = 0;
  camera.right = width;
  camera.top = 0;
  camera.bottom = height;
  camera.updateProjectionMatrix();

  if (!lastFit.x || !lastFit.y) {
    lastFit.x = width / 2;
    lastFit.y = height * 0.42;
  }

  applyFit();
}

function applyFit() {
  if (!glassesModel) {
    return;
  }

  const stage = video.getBoundingClientRect();
  const stageWidth = Math.max(1, stage.width);
  const stageHeight = Math.max(1, stage.height);
  const scale = controlValue("scale");
  const offsetX = controlValue("offsetX");
  const offsetY = controlValue("offsetY");
  const tilt = controlValue("tilt");
  const visibleWidth = clamp(lastFit.width * scale, stageWidth * 0.16, stageWidth * 0.92);
  const modelScale = visibleWidth / modelBaseWidth;
  const fittedX = clamp(lastFit.x + offsetX, stageWidth * 0.08, stageWidth * 0.92);
  const fittedY = clamp(lastFit.y + offsetY, stageHeight * 0.08, stageHeight * 0.74);

  glassesModel.visible = true;
  glassesModel.position.set(fittedX, fittedY, 0);
  glassesModel.rotation.set(
    0,
    0,
    THREE.MathUtils.degToRad(lastFit.angle + tilt),
    "YXZ",
  );
  glassesModel.scale.setScalar(modelScale);

  const turnAmount = Math.abs(lastFit.yaw);
  const turnDirection = Math.sign(lastFit.yaw || 1);

  faceOccluder.visible = ENABLE_FACE_OCCLUDER && hasTrackedFace && turnAmount > 14;
  faceOccluder.position.set(
    fittedX - turnDirection * lastFit.faceWidth * 0.34,
    fittedY + lastFit.faceWidth * 0.1,
    visibleWidth * 0.3,
  );
  faceOccluder.rotation.set(
    THREE.MathUtils.degToRad(lastFit.pitch * 0.65),
    THREE.MathUtils.degToRad(lastFit.yaw * 0.9),
    THREE.MathUtils.degToRad(lastFit.angle),
    "YXZ",
  );
  faceOccluder.scale.set(lastFit.faceWidth * 0.24, lastFit.faceWidth * 0.58, 1);
}

function getVideoCoverRect() {
  const stage = video.getBoundingClientRect();
  const videoRatio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : stage.width / stage.height;
  const stageRatio = stage.width / stage.height;

  let width = stage.width;
  let height = stage.height;
  let x = 0;
  let y = 0;

  if (videoRatio > stageRatio) {
    width = stage.height * videoRatio;
    x = (stage.width - width) / 2;
  } else {
    height = stage.width / videoRatio;
    y = (stage.height - height) / 2;
  }

  return { x, y, width, height };
}

function mapLandmark(point) {
  const stage = video.getBoundingClientRect();

  return {
    x: (1 - point.x) * stage.width,
    y: point.y * stage.height,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shortestAngleDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function mix(a, b, amount) {
  return a * (1 - amount) + b * amount;
}

function holdSmallChange(current, next, threshold) {
  return Math.abs(next - current) < threshold ? current : next;
}

function smoothFit(nextFit) {
  if (!hasTrackedFace) {
    lastFit = nextFit;
    hasTrackedFace = true;
    return;
  }

  const stableFit = {
    x: holdSmallChange(lastFit.x, nextFit.x, 2.2),
    y: holdSmallChange(lastFit.y, nextFit.y, 2.2),
    width: holdSmallChange(lastFit.width, nextFit.width, 3.5),
    faceWidth: holdSmallChange(lastFit.faceWidth, nextFit.faceWidth, 3.5),
    angle: Math.abs(shortestAngleDelta(lastFit.angle, nextFit.angle)) < 1.1 ? lastFit.angle : nextFit.angle,
    yaw: holdSmallChange(lastFit.yaw, nextFit.yaw, 1.6),
    pitch: holdSmallChange(lastFit.pitch, nextFit.pitch, 1.4),
  };
  const positionTake = 0.38;
  const scaleTake = 0.34;
  const rotationTake = 0.3;
  const nextAngle = lastFit.angle + shortestAngleDelta(lastFit.angle, stableFit.angle) * rotationTake;

  lastFit = {
    x: mix(lastFit.x, stableFit.x, positionTake),
    y: mix(lastFit.y, stableFit.y, positionTake),
    width: mix(lastFit.width, stableFit.width, scaleTake),
    faceWidth: mix(lastFit.faceWidth, stableFit.faceWidth, scaleTake),
    angle: nextAngle,
    yaw: mix(lastFit.yaw, stableFit.yaw, rotationTake),
    pitch: mix(lastFit.pitch, stableFit.pitch, rotationTake),
  };
}

function updateFromLandmarks(landmarks) {
  const leftOuterEye = mapLandmark(landmarks[263]);
  const rightOuterEye = mapLandmark(landmarks[33]);
  const leftFace = mapLandmark(landmarks[454]);
  const rightFace = mapLandmark(landmarks[234]);
  const noseBridge = mapLandmark(landmarks[168]);
  const noseTip = mapLandmark(landmarks[1]);
  const eyeDistance = distance(leftOuterEye, rightOuterEye);
  const faceWidth = distance(leftFace, rightFace);
  const stage = video.getBoundingClientRect();

  if (!Number.isFinite(eyeDistance) || eyeDistance < 8 || !Number.isFinite(faceWidth) || faceWidth < 16) {
    return;
  }
  const eyeCenter = {
    x: (leftOuterEye.x + rightOuterEye.x) / 2,
    y: (leftOuterEye.y + rightOuterEye.y) / 2,
  };
  const angle = (Math.atan2(rightOuterEye.y - leftOuterEye.y, rightOuterEye.x - leftOuterEye.x) * 180) / Math.PI;
  const yawFromNose = ((noseTip.x - eyeCenter.x) / eyeDistance) * -45;
  const pitch = ((noseTip.y - noseBridge.y) / eyeDistance - 0.42) * -28;
  const widthFromEyes = eyeDistance * 2.12;
  const widthFromFace = faceWidth * 0.68;
  const fittedWidth = mix(widthFromEyes, widthFromFace, faceWidth > eyeDistance ? 0.18 : 0);
  const fittedCenter = {
    x: mix(eyeCenter.x, noseBridge.x, 0.16),
    y: eyeCenter.y - eyeDistance * 0.36,
  };
  const nextFit = {
    x: clamp(fittedCenter.x, stage.width * 0.06, stage.width * 0.94),
    y: clamp(fittedCenter.y, stage.height * 0.04, stage.height * 0.68),
    width: clamp(fittedWidth, stage.width * 0.12, stage.width * 0.68),
    faceWidth,
    angle,
    yaw: clamp(yawFromNose, -16, 16),
    pitch: clamp(pitch, -8, 8),
  };

  if (debugEnabled) {
    debugText.textContent = [
      `stage ${Math.round(stage.width)}x${Math.round(stage.height)}`,
      `eye ${Math.round(eyeCenter.x)},${Math.round(eyeCenter.y)} d=${Math.round(eyeDistance)}`,
      `fit ${Math.round(nextFit.x)},${Math.round(nextFit.y)} w=${Math.round(nextFit.width)}`,
      `angle ${nextFit.angle.toFixed(1)} yaw ${nextFit.yaw.toFixed(1)} pitch ${nextFit.pitch.toFixed(1)}`,
    ].join("\n");
  }

  smoothFit(nextFit);

  applyFit();
}

function onFaceMeshResults(results) {
  const landmarks = results.multiFaceLandmarks?.[0];

  if (landmarks) {
    lastSeenAt = performance.now();
    updateFromLandmarks(landmarks);
    setStatus("3D face tracking active. Move your head and the model should follow.");
    return;
  }

  if (performance.now() - lastSeenAt > 700) {
    hasTrackedFace = false;
    setStatus("No face detected. Face the camera or use the sliders to adjust.");
  }
}

async function detectFrame() {
  if (!faceMesh || video.readyState < 2 || isDetecting) {
    trackingFrame = requestAnimationFrame(detectFrame);
    return;
  }

  isDetecting = true;
  await faceMesh.send({ image: video });
  isDetecting = false;
  trackingFrame = requestAnimationFrame(detectFrame);
}

function createFaceMesh() {
  if (!window.FaceMesh) {
    setStatus("Face tracking library failed to load. Check internet access, then reload.");
    return false;
  }

  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
  faceMesh.onResults(onFaceMeshResults);
  return true;
}

function frameModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();

  box.getSize(size);
  box.getCenter(center);

  model.position.sub(center);
  modelBaseWidth = Math.max(size.x, 0.001);
}

function isolateGlassesVariant(sceneRoot, roots) {
  if (!roots?.length) {
    return sceneRoot;
  }

  const variant = new THREE.Group();

  roots.forEach((name) => {
    const object = sceneRoot.getObjectByName(name);

    if (object) {
      variant.add(object.clone(true));
    }
  });

  return variant.children.length ? variant : sceneRoot;
}

function tuneGlassesMaterials(model) {
  model.traverse((child) => {
    if (!child.isMesh) {
      return;
    }

    const materials = Array.isArray(child.material) ? child.material : [child.material];

    materials.forEach((material) => {
      if (!material) {
        return;
      }

      const name = material.name.toLowerCase();

      if (name.includes("plastic")) {
        material.color.setRGB(0.015, 0.015, 0.015);
        material.roughness = Math.max(material.roughness ?? 0, 0.38);
        material.metalness = 0;
        material.depthTest = true;
        material.depthWrite = true;
      }

      if (name.includes("gold")) {
        material.color.setRGB(1, 0.72, 0.25);
        material.roughness = Math.max(material.roughness ?? 0, 0.22);
        material.metalness = Math.max(material.metalness ?? 0, 0.65);
        material.depthTest = true;
        material.depthWrite = true;
      }

      if (name.includes("glass")) {
        if (name.includes("pink")) {
          material.color.setRGB(0.26, 0.08, 0.12);
        } else {
          material.color.setRGB(0.02, 0.02, 0.02);
        }
        material.opacity = 0.72;
        material.transparent = true;
        material.depthTest = true;
        material.depthWrite = false;
      }

      material.needsUpdate = true;
    });
  });
}

async function assetExists(path) {
  try {
    const response = await fetch(path, { cache: "no-store" });

    return response.ok;
  } catch {
    return false;
  }
}

async function prepareGlassesOptions() {
  const checks = await Promise.all(
    Object.entries(GLASSES_OPTIONS).map(async ([key, option]) => [key, await assetExists(option.path)]),
  );

  availableGlassesKeys = checks.filter(([, exists]) => exists).map(([key]) => key);

  document.querySelectorAll("[data-glasses]").forEach((button) => {
    const isAvailable = availableGlassesKeys.includes(button.dataset.glasses);
    button.hidden = !isAvailable;
    button.disabled = !isAvailable;
  });

  if (!availableGlassesKeys.includes(activeGlassesKey)) {
    activeGlassesKey = availableGlassesKeys[0];
  }

  if (!activeGlassesKey) {
    throw new Error("No GLB sunglasses assets found.");
  }
}

async function loadGlassesModel() {
  const option = GLASSES_OPTIONS[activeGlassesKey];
  const gltfLoader = new GLTFLoader();
  const gltf = await gltfLoader.loadAsync(option.path);
  const model = isolateGlassesVariant(gltf.scene, option.roots);
  model.visible = false;

  model.traverse((child) => {
    if (child.isMesh) {
      child.frustumCulled = false;
      child.castShadow = false;
      child.receiveShadow = false;
      child.renderOrder = 2;
    }
  });
  tuneGlassesMaterials(model);

  frameModel(model);
  model.userData.baseWidth = modelBaseWidth;
  modelCache.set(activeGlassesKey, model);
  return model;
}

async function showGlassesModel(key) {
  if (!GLASSES_OPTIONS[key] || !availableGlassesKeys.includes(key)) {
    return;
  }

  activeGlassesKey = key;
  setActiveModelButton(key);
  setStatus(`Loading ${GLASSES_OPTIONS[key].label.toLowerCase()} sunglasses.`);

  if (glassesModel) {
    scene.remove(glassesModel);
    glassesModel = null;
  }

  glassesModel = modelCache.get(key) || (await loadGlassesModel());
  modelBaseWidth = glassesModel.userData.baseWidth || 1;
  scene.add(glassesModel);
  applyFit();

  setStatus(`${GLASSES_OPTIONS[key].label} sunglasses ready. Face the camera for tracking.`);
}

function setActiveModelButton(key) {
  document.querySelectorAll("[data-glasses]").forEach((button) => {
    const isActive = button.dataset.glasses === key;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function renderLoop() {
  renderer.render(scene, camera);
  renderFrame = requestAnimationFrame(renderLoop);
}

async function startCamera() {
  try {
    setStatus("Loading 3D sunglasses model.");
    await prepareGlassesOptions();
    await showGlassesModel(activeGlassesKey);

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    video.srcObject = stream;
    await video.play();
    resizeRenderer();
    renderLoop();
    loader.classList.add("hidden");

    if (createFaceMesh()) {
      setStatus("Camera ready. Loading face tracker.");
      detectFrame();
    }
  } catch (error) {
    console.error(error);
    loader.classList.add("hidden");
    setStatus("Could not start AR. Check camera permissions, internet access, and the GLB file.");
  }
}

document.querySelectorAll("[data-glasses]").forEach((button) => {
  button.addEventListener("click", async () => {
    const key = button.dataset.glasses;

    if (!key || key === activeGlassesKey) {
      return;
    }

    try {
      await showGlassesModel(key);
    } catch (error) {
      console.error(error);
      setStatus("Could not load that sunglasses model. Check the GLB file in the assets folder.");
    }
  });
});

window.addEventListener("resize", resizeRenderer);
window.addEventListener("beforeunload", () => {
  if (trackingFrame) {
    cancelAnimationFrame(trackingFrame);
  }
  if (renderFrame) {
    cancelAnimationFrame(renderFrame);
  }
});

startCamera();
