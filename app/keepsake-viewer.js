import * as THREE from "../vendor/three/three.module.js";
import { GLTFLoader } from "../vendor/three/addons/loaders/GLTFLoader.js";

/* Full-screen keepsake showroom: soft studio lighting, contact shadow, drag to orbit,
   wheel/pinch to zoom, gentle turntable when idle. */

let renderer = null;
let scene = null;
let camera = null;
let pivot = null;
let model = null;
let frame = null;
let dragging = false;
let lastX = 0;
let lastY = 0;
let yaw = 0;
let pitch = 0.06;
let distance = 4.6;
let idleSpin = true;
let loadToken = 0;

function disposeObject(root) {
  root?.traverse?.(node => {
    if (node.isMesh) {
      node.geometry?.dispose?.();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(material => {
        for (const key of Object.keys(material || {})) {
          const value = material[key];
          if (value && value.isTexture) value.dispose();
        }
        material?.dispose?.();
      });
    }
  });
}

function makeShadowTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(60,40,20,.5)");
  g.addColorStop(0.55, "rgba(60,40,20,.18)");
  g.addColorStop(1, "rgba(60,40,20,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function setup() {
  const canvas = document.getElementById("keepsakeCanvas");
  const host = document.getElementById("ksStage");
  if (!canvas || !host) return false;
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);

    scene.add(new THREE.HemisphereLight(0xfff6e0, 0x6a4a2c, 1.5));
    const key = new THREE.DirectionalLight(0xfff2d8, 3.4);
    key.position.set(3.4, 5.2, 4.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 4;
    key.shadow.bias = -0.0015;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd4ff, 1.5);
    rim.position.set(-4, 2.2, -3.4);
    scene.add(rim);
    const fill = new THREE.PointLight(0xffe6b8, 12, 12);
    fill.position.set(-1.4, -1.6, 3.2);
    scene.add(fill);

    // contact shadow
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.28;
    scene.add(ground);

    pivot = new THREE.Group();
    scene.add(pivot);

    host.addEventListener("pointerdown", event => {
      dragging = true; idleSpin = false; lastX = event.clientX; lastY = event.clientY;
      host.setPointerCapture?.(event.pointerId);
    });
    host.addEventListener("pointermove", event => {
      if (!dragging) return;
      yaw += (event.clientX - lastX) * 0.008;
      pitch = Math.max(-0.6, Math.min(0.9, pitch + (event.clientY - lastY) * 0.005));
      lastX = event.clientX; lastY = event.clientY;
    });
    const stop = () => { dragging = false; window.setTimeout(() => { if (!dragging) idleSpin = true; }, 1800); };
    host.addEventListener("pointerup", stop);
    host.addEventListener("pointercancel", stop);
    host.addEventListener("wheel", event => {
      event.preventDefault();
      distance = Math.max(2.6, Math.min(8.5, distance + event.deltaY * 0.0022));
    }, { passive: false });

    const render = () => {
      // yaw is the single source of truth: idle spin advances it, dragging sets it,
      // so the model never snaps back when a drag starts.
      if (pivot && idleSpin && !dragging) yaw += 0.006;
      if (pivot) pivot.rotation.y = yaw;
      camera.position.set(0, 0.55 + pitch * 1.6, distance);
      camera.lookAt(0, 0.02, 0);
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();
  }
  const width = host.clientWidth || 320;
  const height = host.clientHeight || 320;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  return true;
}

function loadModel(url) {
  if (!setup()) return;
  const loading = document.getElementById("ksLoading");
  const fallback = document.getElementById("keepsakeFallback");
  if (loading) loading.hidden = false;
  const token = ++loadToken;
  if (model) {
    pivot.remove(model);
    disposeObject(model);
    model = null;
  }
  new GLTFLoader().load(url, gltf => {
    if (token !== loadToken) {
      disposeObject(gltf.scene);
      return;
    }
    model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const max = Math.max(size.x, size.y, size.z) || 1;
    model.scale.setScalar(2.35 / max);
    model.traverse(node => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.material) {
          node.material.envMapIntensity = 1.1;
          if ("roughness" in node.material) node.material.roughness = Math.min(0.95, (node.material.roughness ?? 0.8));
        }
      }
    });
    pivot.rotation.set(0, yaw, 0);
    pivot.add(model);
    if (fallback) fallback.hidden = true;
    if (loading) loading.hidden = true;
    idleSpin = true;
  }, undefined, () => {
    if (token !== loadToken) return;
    if (fallback) fallback.hidden = false;
    if (loading) loading.hidden = true;
  });
}

window.addEventListener("keepsake:show", event => loadModel(event.detail.url));
window.addEventListener("keepsake:hide", () => { idleSpin = false; });
window.addEventListener("resize", () => {
  const host = document.getElementById("ksStage");
  if (renderer && host && !document.getElementById("keepsakeModal")?.hidden) {
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
    camera.updateProjectionMatrix();
  }
});
window.addEventListener("beforeunload", () => { if (frame) cancelAnimationFrame(frame); });
