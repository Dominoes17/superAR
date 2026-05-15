import * as THREE from "https://esm.sh/three@0.164.1";
import { GLTFLoader } from "https://esm.sh/three@0.164.1/examples/jsm/loaders/GLTFLoader.js";
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

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
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  tilt: 180,
};

const ENABLE_FACE_OCCLUDER = false;

let faceLandmarker = null;
let faceMesh = null;
let faceDetection = null;
let trackingFrame = null;
let renderFrame = null;
let isDetecting = false;
let lastSeenAt = 0;
let lastMeshFitAt = 0;
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
    THREE.MathUtils.degToRad(lastFit.pitch),
    THREE.MathUtils.degToRad(lastFit.yaw),
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

function normalizeLandmark(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }

  if (point.x > -0.35 && point.x < 1.35 && point.y > -0.35 && point.y < 1.35) {
    return { x: point.x, y: point.y, space: "normalized" };
  }

  const stage = video.getBoundingClientRect();
  const videoWidth = video.videoWidth || stage.width;
  const videoHeight = video.videoHeight || stage.height;

  if (
    videoWidth &&
    videoHeight &&
    point.x > -videoWidth * 0.35 &&
    point.x < videoWidth * 1.35 &&
    point.y > -videoHeight * 0.35 &&
    point.y < videoHeight * 1.35
  ) {
    return { x: point.x / videoWidth, y: point.y / videoHeight, space: "pixel" };
  }

  return null;
}

function mapLandmark(point) {
  const normalized = normalizeLandmark(point);

  if (!normalized) {
    return null;
  }

  const cover = getVideoCoverRect();

  return {
    x: cover.x + cover.width - normalized.x * cover.width,
    y: cover.y + normalized.y * cover.height,
    space: normalized.space,
  };
}

function isUsableLandmark(point) {
  return Boolean(normalizeLandmark(point));
}

function averageMappedLandmarks(landmarks, indexes) {
  const points = indexes.map((index) => mapLandmark(landmarks[index])).filter(Boolean);

  if (!points.length) {
    return null;
  }

  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    space: points.find((point) => point.space)?.space,
  };
}

function mappedLandmark(landmarks, index) {
  return isUsableLandmark(landmarks[index]) ? mapLandmark(landmarks[index]) : null;
}

function validMappedLandmarks(landmarks) {
  return landmarks.map(mapLandmark).filter(Boolean);
}

function boundingBox(points) {
  if (!points.length) {
    return null;
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function centeredFallbackFit(stage) {
  return {
    x: stage.width * 0.5,
    y: stage.height * 0.36,
    width: stage.width * 0.58,
    faceWidth: stage.width * 0.72,
    angle: 0,
    yaw: 0,
    pitch: 0,
  };
}

function mapRelativePoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }

  const cover = getVideoCoverRect();

  return {
    x: cover.x + cover.width - point.x * cover.width,
    y: cover.y + point.y * cover.height,
  };
}

function detectionLocation(detection) {
  return detection?.locationData || detection?.location_data || null;
}

function detectionBox(detection, location) {
  return detection?.boundingBox || location?.relativeBoundingBox || location?.relative_bounding_box || null;
}

function detectionKeypoints(detection, location) {
  return Array.from(detection?.landmarks || location?.relativeKeypoints || location?.relative_keypoints || []);
}

function boxValue(box, ...names) {
  for (const name of names) {
    if (Number.isFinite(box?.[name])) {
      return box[name];
    }
  }

  return null;
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
  const stage = video.getBoundingClientRect();
  const validPoints = validMappedLandmarks(landmarks);
  const faceBox = boundingBox(validPoints);
  const eyeOne = averageMappedLandmarks(landmarks, [33, 133, 159, 145, 160, 144]);
  const eyeTwo = averageMappedLandmarks(landmarks, [263, 362, 386, 374, 385, 380]);
  const faceOne = mappedLandmark(landmarks, 234);
  const faceTwo = mappedLandmark(landmarks, 454);
  const noseBridge = mappedLandmark(landmarks, 168);
  const noseTip = mappedLandmark(landmarks, 1);

  if (!eyeOne || !eyeTwo) {
    if (faceBox && faceBox.width > stage.width * 0.16 && faceBox.height > stage.height * 0.18) {
      const fallbackFit = {
        x: clamp((faceBox.minX + faceBox.maxX) / 2, stage.width * 0.06, stage.width * 0.94),
        y: clamp(faceBox.minY + faceBox.height * 0.36, stage.height * 0.04, stage.height * 0.72),
        width: clamp(faceBox.width * 0.62, stage.width * 0.16, stage.width * 0.72),
        faceWidth: faceBox.width,
        angle: 0,
        yaw: 0,
        pitch: 0,
      };

      if (debugEnabled) {
        debugText.textContent = [
          `stage ${Math.round(stage.width)}x${Math.round(stage.height)}`,
          `valid ${validPoints.length}/${landmarks.length}`,
          `fallback face ${Math.round(faceBox.width)}x${Math.round(faceBox.height)}`,
          `fit ${Math.round(fallbackFit.x)},${Math.round(fallbackFit.y)} w=${Math.round(fallbackFit.width)}`,
        ].join("\n");
      }

      smoothFit(fallbackFit);
      applyFit();
      lastMeshFitAt = performance.now();
      return true;
    }

    if (debugEnabled) {
      debugText.textContent = [
        `stage ${Math.round(stage.width)}x${Math.round(stage.height)}`,
        `valid ${validPoints.length}/${landmarks.length}`,
        "mesh invalid, waiting for detector",
      ].join("\n");
    }
    return false;
  }

  const leftEye = eyeOne.x <= eyeTwo.x ? eyeOne : eyeTwo;
  const rightEye = eyeOne.x <= eyeTwo.x ? eyeTwo : eyeOne;
  const eyeDistance = distance(leftEye, rightEye);
  const faceWidth = faceOne && faceTwo ? distance(faceOne, faceTwo) : eyeDistance * 2.85;

  if (!Number.isFinite(eyeDistance) || eyeDistance < 8 || !Number.isFinite(faceWidth) || faceWidth < 16) {
    return;
  }
  const eyeCenter = {
    x: (leftEye.x + rightEye.x) / 2,
    y: (leftEye.y + rightEye.y) / 2,
  };
  const stableNoseBridge = noseBridge || eyeCenter;
  const stableNoseTip = noseTip || stableNoseBridge;
  const angle = (Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180) / Math.PI;
  const yawFromNose = ((stableNoseTip.x - eyeCenter.x) / eyeDistance) * -36;
  const pitch = ((stableNoseTip.y - stableNoseBridge.y) / eyeDistance - 0.42) * -20;
  const widthFromEyes = eyeDistance * 3.05;
  const widthFromFace = faceWidth * 0.68;
  const fittedWidth = mix(widthFromEyes, widthFromFace, faceWidth > eyeDistance ? 0.18 : 0);
  const fittedCenter = {
    x: mix(eyeCenter.x, stableNoseBridge.x, 0.12),
    y: eyeCenter.y + eyeDistance * 0.38,
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
      `valid ${validPoints.length}/${landmarks.length}`,
      `eye ${Math.round(eyeCenter.x)},${Math.round(eyeCenter.y)} d=${Math.round(eyeDistance)}`,
      `fit ${Math.round(nextFit.x)},${Math.round(nextFit.y)} w=${Math.round(nextFit.width)}`,
      `angle ${nextFit.angle.toFixed(1)} yaw ${nextFit.yaw.toFixed(1)} pitch ${nextFit.pitch.toFixed(1)}`,
      `space ${leftEye.space || "unknown"}`,
    ].join("\n");
  }

  smoothFit(nextFit);

  applyFit();
  lastMeshFitAt = performance.now();
  return true;
}

function onFaceMeshResults(results) {
  const landmarks = results.multiFaceLandmarks?.[0];

  if (landmarks) {
    if (updateFromLandmarks(landmarks)) {
      lastSeenAt = performance.now();
      setStatus("3D face tracking active. Move your head and the model should follow.");
    } else if (!faceDetection) {
      setStatus("Face mesh landmarks are not usable on this device.");
    }
    return;
  }

  if (performance.now() - lastSeenAt > 700) {
    hasTrackedFace = false;
    setStatus("No face detected. Face the camera or use the sliders to adjust.");
  }
}

function updateFromDetection(detection) {
  const stage = video.getBoundingClientRect();
  const location = detectionLocation(detection);
  const box = detectionBox(detection, location);

  if (!box) {
    if (debugEnabled) {
      debugText.textContent = `stage ${Math.round(stage.width)}x${Math.round(stage.height)}\nsource face-detection\nno readable box`;
    }
    return false;
  }

  const keypoints = detectionKeypoints(detection, location).map(mapRelativePoint).filter(Boolean);
  const eyeA = keypoints[0];
  const eyeB = keypoints[1];
  let fit = null;

  if (eyeA && eyeB) {
    const leftEye = eyeA.x <= eyeB.x ? eyeA : eyeB;
    const rightEye = eyeA.x <= eyeB.x ? eyeB : eyeA;
    const eyeDistance = distance(leftEye, rightEye);

    if (Number.isFinite(eyeDistance) && eyeDistance > 8) {
      const eyeCenter = {
        x: (leftEye.x + rightEye.x) / 2,
        y: (leftEye.y + rightEye.y) / 2,
      };
      const angle = (Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180) / Math.PI;

      fit = {
        x: clamp(eyeCenter.x, stage.width * 0.06, stage.width * 0.94),
        y: clamp(eyeCenter.y + eyeDistance * 0.42, stage.height * 0.04, stage.height * 0.72),
        width: clamp(eyeDistance * 2.75, stage.width * 0.16, stage.width * 0.72),
        faceWidth: eyeDistance * 2.85,
        angle,
        yaw: 0,
        pitch: 0,
      };
    }
  }

  if (!fit) {
    const cover = getVideoCoverRect();
    const centerNormX = boxValue(box, "xCenter", "xcenter", "centerX");
    const centerNormY = boxValue(box, "yCenter", "ycenter", "centerY");
    const xmin = boxValue(box, "xmin", "xMin", "x");
    const ymin = boxValue(box, "ymin", "yMin", "y");
    const boxWidth = boxValue(box, "width", "w");
    const boxHeight = boxValue(box, "height", "h");

    if ((centerNormX === null && xmin === null) || (centerNormY === null && ymin === null) || boxWidth === null || boxHeight === null) {
      if (debugEnabled) {
        debugText.textContent = `stage ${Math.round(stage.width)}x${Math.round(stage.height)}\nsource face-detection\nunreadable box fields`;
      }
      return false;
    }

    const centerX = cover.x + cover.width - (centerNormX ?? xmin + boxWidth / 2) * cover.width;
    const topY = cover.y + (ymin ?? centerNormY - boxHeight / 2) * cover.height;
    const width = boxWidth * cover.width;
    const height = boxHeight * cover.height;

    fit = {
      x: clamp(centerX, stage.width * 0.06, stage.width * 0.94),
      y: clamp(topY + height * 0.36, stage.height * 0.04, stage.height * 0.72),
      width: clamp(width * 0.64, stage.width * 0.16, stage.width * 0.72),
      faceWidth: width,
      angle: 0,
      yaw: 0,
      pitch: 0,
    };
  }

  if (debugEnabled) {
    debugText.textContent = [
      `stage ${Math.round(stage.width)}x${Math.round(stage.height)}`,
      "source face-detection",
      `keys ${keypoints.length}`,
      `fit ${Math.round(fit.x)},${Math.round(fit.y)} w=${Math.round(fit.width)}`,
      `angle ${fit.angle.toFixed(1)}`,
    ].join("\n");
  }

  smoothFit(fit);
  applyFit();
  lastSeenAt = performance.now();
  setStatus("Face detector tracking active. Move your head and the model should follow.");
  return true;
}

function onFaceDetectionResults(results) {
  const detection = results.detections?.[0];

  if (detection) {
    updateFromDetection(detection);
    return;
  }

  if (debugEnabled && performance.now() - lastMeshFitAt > 250) {
    const stage = video.getBoundingClientRect();
    debugText.textContent = `stage ${Math.round(stage.width)}x${Math.round(stage.height)}\nsource face-detection\nno detections`;
  }
}

async function detectFrame() {
  if (!faceLandmarker || video.readyState < 2 || isDetecting) {
    trackingFrame = requestAnimationFrame(detectFrame);
    return;
  }

  isDetecting = true;
  const now = performance.now();
  const results = faceLandmarker.detectForVideo(video, now);
  const landmarks = results.faceLandmarks?.[0];

  if (landmarks) {
    if (updateFromLandmarks(landmarks)) {
      lastSeenAt = now;
      setStatus("MediaPipe Tasks tracking active. Move your head and the model should follow.");
    }
  } else if (debugEnabled) {
    const stage = video.getBoundingClientRect();
    debugText.textContent = `stage ${Math.round(stage.width)}x${Math.round(stage.height)}\nsource tasks-vision\nno landmarks`;
  }

  isDetecting = false;
  trackingFrame = requestAnimationFrame(detectFrame);
}

async function createFaceLandmarker() {
  try {
    const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm");

    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  } catch (error) {
    console.error(error);
    setStatus("Could not load the new face tracker on this device.");
    if (debugEnabled) {
      debugText.textContent = `tasks-vision init failed\n${error.message || error}`;
    }
    return false;
  }

  return true;
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
    refineLandmarks: false,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
  faceMesh.onResults(onFaceMeshResults);
  return true;
}

function createFaceDetection() {
  if (!window.FaceDetection) {
    return false;
  }

  faceDetection = new FaceDetection({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`,
  });

  faceDetection.setOptions({
    model: "short",
    minDetectionConfidence: 0.55,
  });
  faceDetection.onResults(onFaceDetectionResults);
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

    setStatus("Camera ready. Loading face tracker.");
    if (await createFaceLandmarker()) {
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
