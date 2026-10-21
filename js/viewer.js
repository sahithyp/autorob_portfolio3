// Replays a recorded loop of the runtime's /xform_world stream with three.js.
//
// The runtime does all the kinematics.  This page only reads the URDF for what each link LOOKS like
// (box / cylinder / sphere + colour), then every frame puts each link's group at the 4x4 matrix the
// runtime published for it.  `three` and `OrbitControls` are loaded as globals by index.html.

import { Music } from "./music.js";
import { parseRobot, Sim, retime } from "./sim.js";

const $ = id => document.getElementById(id);
const PI = Math.PI;
const ASSET = name => "assets/" + name;

// ------------------------------------------------------------------ the dance's sections

const SECTIONS = [
  { re: /^intro/,       label: "Intro",          color: "#5aa02c" },
  { re: /^moonwalk_a/,  label: "Moonwalk",       color: "#4fc3d9" },
  { re: /^hands/,       label: "Jazz hands",     color: "#f2c230" },
  { re: /^spin_a/,      label: "Spin",           color: "#d9534f" },
  { re: /^disco/,       label: "Disco",          color: "#b36bd9" },
  { re: /^moonwalk_b/,  label: "Moonwalk back",  color: "#3c78d8" },
  { re: /^spin_b/,      label: "Spin",           color: "#d9534f" },
  { re: /^finale/,      label: "Finale",         color: "#e8883a" },
];
const sectionOf = name => SECTIONS.find(s => s.re.test(name)) || { label: "Your dance", color: "#8a8a92" };

// ------------------------------------------------------------------ scene

const canvas = $("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
const controls = new THREE.OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = PI * 0.49;          // stay above the floor
controls.minDistance = 1.2;
controls.maxDistance = 9;

scene.add(new THREE.HemisphereLight(0xdff1ff, 0x6b5a3a, 0.95));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(2.5, 5, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 14 });
scene.add(sun);

// URDF is z-up, three.js is y-up: one rotated group converts between them for everything the runtime sends.
const zup = new THREE.Group();
zup.rotation.x = -PI / 2;
scene.add(zup);

// A grass floor made of 16x16 "pixel" tiles, one tile = one Minecraft block (0.64 m = 16 px * 0.04 m).
function grassTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const g = c.getContext("2d");
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const v = rnd();
    g.fillStyle = v < 0.25 ? "#4e8a25" : v < 0.6 ? "#5aa02c" : v < 0.88 ? "#62ad33" : "#6dbb3c";
    g.fillRect(x, y, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 12);
  return t;
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(0.64 * 24, 0.64 * 12), new THREE.MeshLambertMaterial({ map: grassTexture() }));
floor.rotation.x = -PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// blocky clouds that drift past
const clouds = [];
for (let i = 0; i < 7; i++) {
  const w = 1.2 + (i % 3) * 0.7;
  const cloud = new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, 0.7 + (i % 2) * 0.5), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
  cloud.position.set(-7 + i * 2.3, 3.2 + (i % 3) * 0.5, -3.5 - (i % 4));
  scene.add(cloud);
  clouds.push(cloud);
}

// ------------------------------------------------------------------ robot (looks only; poses come from the runtime)

const nums = (s, d) => (s ? s.trim().split(/\s+/).map(Number) : d);
const kids = (el, tag) => [...el.children].filter(c => c.localName === tag);

function parseLooks(urdfText) {
  const doc = new DOMParser().parseFromString(urdfText, "application/xml");
  return kids(doc.documentElement, "link").map(l => {
    const vis = kids(l, "visual")[0];
    if (!vis) return { name: l.getAttribute("name"), visual: null };
    const shape = kids(vis, "geometry")[0].children[0], origin = kids(vis, "origin")[0];
    const material = kids(vis, "material")[0], color = material && kids(material, "color")[0];
    return {
      name: l.getAttribute("name"),
      visual: {
        type: shape.localName, el: shape,
        xyz: nums(origin && origin.getAttribute("xyz"), [0, 0, 0]),
        rpy: nums(origin && origin.getAttribute("rpy"), [0, 0, 0]),
        rgba: color ? nums(color.getAttribute("rgba"), [0.7, 0.7, 0.7, 1]) : [0.7, 0.7, 0.7, 1],
      },
    };
  });
}

function buildMesh(v) {
  const n = a => Number(v.el.getAttribute(a));
  let geo;
  if (v.type === "box") { const s = nums(v.el.getAttribute("size"), [0.05, 0.05, 0.05]); geo = new THREE.BoxGeometry(s[0], s[1], s[2]); }
  else if (v.type === "cylinder") { geo = new THREE.CylinderGeometry(n("radius"), n("radius"), n("length"), 16); geo.rotateX(PI / 2); }
  else geo = new THREE.SphereGeometry(n("radius"), 16, 12);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: new THREE.Color(v.rgba[0], v.rgba[1], v.rgba[2]) }));
  mesh.position.set(...v.xyz);
  mesh.rotation.set(v.rpy[0], v.rpy[1], v.rpy[2], "ZYX");
  mesh.castShadow = true;
  return mesh;
}

// ------------------------------------------------------------------ replay

const linkGroups = {};      // link name -> THREE.Group whose matrix we overwrite every frame
let replay = null, choreo = null;       // the recording, and the dance it came from
let sim = null, simSource = null;       // the playground: a live simulation, and the dance it runs
let mode = "replay";                    // "replay" (recorded frames) or "sim" (try it yourself)

function buildRobot(looks) {
  for (const l of looks) {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;             // the runtime's matrix is the whole transform
    if (l.visual) g.add(buildMesh(l.visual));
    zup.add(g);
    linkGroups[l.name] = g;
  }
}

/**
 * Put every link where the runtime said it was at dance time t (seconds).
 * Frames are ~30 Hz, so we interpolate linearly between the two neighbours; the loop wraps from the last
 * frame back to the first (both are the settled finale pose).
 */
function pose(t) {
  const { times, frames, links, duration } = replay;
  const t0 = times[0];
  const tt = ((t - t0) % duration + duration) % duration + t0;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= tt) lo = mid; else hi = mid - 1; }
  const i = lo, j = (i + 1) % times.length;
  const tj = j === 0 ? times[0] + duration : times[j];
  const u = Math.min(1, Math.max(0, (tt - times[i]) / (tj - times[i])));
  const A = frames[i], B = frames[j];
  const m = new THREE.Matrix4();
  for (let k = 0; k < links.length; k++) {
    const o = k * 12, e = [];
    for (let c = 0; c < 12; c++) e.push(A[o + c] + (B[o + c] - A[o + c]) * u);
    // The runtime sends 4x4 matrices column-major; each column is 3 numbers + (0,0,0,1), stored here without the bottom row.
    m.fromArray([e[0], e[1], e[2], 0,  e[3], e[4], e[5], 0,  e[6], e[7], e[8], 0,  e[9], e[10], e[11], 1]);
    linkGroups[links[k]].matrix.copy(m);
    linkGroups[links[k]].matrixWorldNeedsUpdate = true;
  }
  return linkGroups.torso ? e0(linkGroups.torso.matrix) : 0;
}
const e0 = m => m.elements[12];             // the torso's world x, used by the "follow" camera

/** The playground's version of pose(): advance the simulation to time t and draw its matrices the same way. */
function poseSim(t) {
  sim.step(t);
  const ms = sim.matrices();
  sim.robot.links.forEach((name, i) => {
    linkGroups[name].matrix.fromArray(ms[i]);        // column-major, same layout as /xform_world
    linkGroups[name].matrixWorldNeedsUpdate = true;
  });
  return sim.base.x;
}

// ------------------------------------------------------------------ clock: one dance time shared with the music

const music = new Music(120);
let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
let perfAnchor = performance.now();         // wall-clock time at which dance time was 0
let frozenT = 0;                            // dance time while paused

function danceTime() {
  if (!playing) return frozenT;
  return music.on ? music.time() : (performance.now() - perfAnchor) / 1000;
}
function setDanceTime(t) {                  // jump the clock to t, keeping the music (if any) aligned
  frozenT = t;
  perfAnchor = performance.now() - t * 1000;
  if (music.on) { if (playing) music.start(t); else music.stop(); }
}

function setPlaying(on) {
  const t = danceTime();
  playing = on;
  if (on) { setDanceTime(t); } else { frozenT = t; }
  if (!on && music.on) music.stop();
  syncButtons();
}

// ------------------------------------------------------------------ video: muted, with the synthesized music played alongside

const videoEl = document.querySelector(".video video");
if (videoEl) {
  const videoMusic = new Music(120);
  videoEl.muted = true;
  const sync = () => { if (!videoEl.paused && !videoEl.ended) videoMusic.start(videoEl.currentTime); };
  videoEl.addEventListener("play", sync);
  videoEl.addEventListener("seeked", sync);
  for (const ev of ["pause", "ended", "emptied"]) videoEl.addEventListener(ev, () => videoMusic.stop());
}

// ------------------------------------------------------------------ UI

function syncButtons() {
  $("play").textContent = playing ? "❚❚ Pause" : "▶ Dance";
  $("music").textContent = music.on ? "■ Music off" : "♪ Music on";
  $("music").setAttribute("aria-pressed", String(music.on));
}

let lastKey = null;
function buildTimeline(states) {
  const bar = $("timeline");
  bar.innerHTML = "";
  bar.style.setProperty("--cols", Math.min(states.length, 48));
  states.forEach((st, i) => {
    const sec = sectionOf(st.name);
    const cell = document.createElement("button");
    cell.className = "beat";
    cell.style.setProperty("--c", sec.color);
    cell.title = `beat ${i + 1}: ${st.name}`;
    cell.setAttribute("aria-label", `Beat ${i + 1}, ${sec.label}`);
    cell.onclick = () => {                           // jumping only makes sense in the recording
      if (mode !== "replay") return;
      setDanceTime(i * replay.duration / states.length);
      if (!playing) setPlaying(true);
    };
    bar.appendChild(cell);
  });
  lastKey = null;
}

function buildLegend() {
  const legend = $("legend");
  for (const label of [...new Set(SECTIONS.map(s => s.label))]) {
    const sec = SECTIONS.find(s => s.label === label);
    const li = document.createElement("li");
    li.innerHTML = `<i style="background:${sec.color}"></i>${label}`;
    legend.appendChild(li);
  }
}

function updateHud(t) {
  let name, idx, total;
  if (mode === "sim") {
    name = sim.current || "ready"; idx = sim.current ? sim.stateIndex : -1; total = sim.doc ? sim.doc.states.length : 0;
  } else {
    total = choreo.states.length;
    idx = Math.floor((((t % replay.duration) + replay.duration) % replay.duration) / (replay.duration / total));
    name = choreo.states[idx].name;
  }
  const key = mode + ":" + idx + ":" + name;
  if (key === lastKey) return;
  lastKey = key;
  $("state").textContent = name;
  $("section").textContent = idx >= 0 ? sectionOf(name).label : "Free play";
  $("beatno").textContent = idx >= 0 ? `${idx + 1} / ${total}` : "-";
  [...$("timeline").children].forEach((c, i) => c.classList.toggle("now", i === idx));
}

// ------------------------------------------------------------------ playground ("try it yourself")

const sliders = {};
const bpmNow = () => Number($("tempo").value);

function formatDoc(doc) {                             // one state per line: short enough to read and edit
  return `{ "initial_state": ${JSON.stringify(doc.initial_state)}, "bpm": ${doc.bpm || 120},\n  "states": [\n` +
         doc.states.map(st => "    " + JSON.stringify(st)).join(",\n") + "\n  ] }";
}

const EXAMPLE = {
  initial_state: "ready", bpm: 120,
  states: [
    { name: "ready",  target: { joint_names: ["r_shoulder", "r_elbow", "neck_yaw", "antenna"], positions: [0, 0, 0, 0] },
      epsilon: 0.08, hold: 1, on_arrival: "next", transitions: [{ name: "next", next_state: "arm_up" }] },
    { name: "arm_up", target: { joint_names: ["r_shoulder", "r_elbow", "neck_yaw"], positions: [-2.6, 0.4, 0.4] },
      epsilon: 0.08, hold: 1, on_arrival: "next", transitions: [{ name: "next", next_state: "wave_a" }] },
    { name: "wave_a", target: { joint_names: ["r_elbow", "antenna"], positions: [1.6, 0.3] },
      epsilon: 0.08, hold: 0.5, on_arrival: "next", transitions: [{ name: "next", next_state: "wave_b" }] },
    { name: "wave_b", target: { joint_names: ["r_elbow", "antenna"], positions: [0.2, 0] },
      epsilon: 0.08, hold: 0.5, on_arrival: "next", transitions: [{ name: "next", next_state: "wave_a" }] },   // loops here forever
  ],
};

function message(text, kind) { const m = $("editor-msg"); m.textContent = text; m.className = kind || ""; }

function buildSliders() {
  const box = $("joints");
  box.innerHTML = "";
  for (const j of sim.movable) {
    const lo = Number.isFinite(j.lower) ? j.lower : -2 * PI, hi = Number.isFinite(j.upper) ? j.upper : 2 * PI;
    const row = document.createElement("label");
    row.className = "joint";
    row.innerHTML = `<span class="jn">${j.name}</span><output></output>`;
    const input = document.createElement("input");
    Object.assign(input, { type: "range", min: lo, max: hi, step: 0.01, value: sim.pos[j.name] });
    input.setAttribute("aria-label", j.name);
    const out = row.querySelector("output");
    out.textContent = Number(input.value).toFixed(2);
    input.addEventListener("input", () => {           // posing by hand takes over from the dance
      sim.stop(); sim.current = null;
      sim.setJoint(j.name, Number(input.value));
      out.textContent = Number(input.value).toFixed(2);
    });
    row.appendChild(input);
    box.appendChild(row);
    sliders[j.name] = { input, out };
  }
}

function syncSliders() {                              // show where each joint actually is, except the one being dragged
  for (const [name, sl] of Object.entries(sliders)) {
    if (document.activeElement === sl.input) continue;
    sl.input.value = sim.pos[name];
    sl.out.textContent = sim.pos[name].toFixed(2);
  }
}

/** Load `doc` at the current tempo and run it from the top. Returns false (and says why) if it is not a valid dance. */
function runDance(doc) {
  const retimed = retime(doc, bpmNow());
  const error = sim.load(retimed);
  if (error) { message("Not a valid dance: " + error, "err"); return false; }
  simSource = doc;
  music.bpm = bpmNow();                               // the beat length follows the tempo
  buildTimeline(retimed.states);
  if (!playing) setPlaying(true);
  setDanceTime(0);                                    // restarts the music on the bar line if it is playing
  sim.start(0);
  message(`Running "${doc.initial_state}" (${doc.states.length} states, ${bpmNow()} BPM).`, "ok");
  return true;
}

function setMode(next) {
  mode = next;
  const sec = $("robot");
  sec.classList.toggle("mode-sim", next === "sim");
  $("panel-try").hidden = next !== "sim";
  $("tab-replay").setAttribute("aria-selected", String(next === "replay"));
  $("tab-try").setAttribute("aria-selected", String(next === "sim"));
  if (next === "sim") {
    sim.resetPose();
    simSource = simSource || choreo;
    sim.load(retime(simSource, bpmNow()));
    music.bpm = bpmNow();
    buildTimeline(sim.doc.states);
  } else {
    music.bpm = choreo.bpm || 120;
    buildTimeline(choreo.states);
  }
  setDanceTime(0);
  syncButtons();
}

const VIEWS = {
  side:  () => place([0, 0.6, 4.2], [0, 0.45, 0]),
  front: () => place([4.2, 0.9, 0], [0, 0.45, 0]),
  three: () => place([2.6, 1.3, 3.0], [0, 0.45, 0]),
};
function place(pos, target) {
  camera.position.set(...pos);
  controls.target.set(...target);
  controls.update();
}

function resize() {
  const box = canvas.parentElement, w = box.clientWidth, h = box.clientHeight;
  const crisp = $("crisp").checked;
  renderer.setPixelRatio(crisp ? 0.5 : Math.min(devicePixelRatio, 2));   // chunky low-res pixels, scaled up
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ------------------------------------------------------------------ boot

async function boot() {
  const [urdf, rep, cho] = await Promise.all([
    fetch(ASSET("minecraft_steve.urdf")).then(r => r.text()),
    fetch(ASSET("replay.json")).then(r => r.json()),
    fetch(ASSET("moonwalk.json")).then(r => r.json()),
  ]);
  replay = rep; choreo = cho;
  buildRobot(parseLooks(urdf));
  sim = new Sim(parseRobot(urdf));
  buildTimeline(choreo.states);
  buildLegend();
  buildSliders();
  $("editor").value = formatDoc(choreo);

  $("play").onclick = () => setPlaying(!playing);
  $("restart").onclick = () => {
    if (mode === "sim") runDance(simSource || choreo);
    else { setDanceTime(0); if (!playing) setPlaying(true); }
  };
  $("music").onclick = () => {
    if (music.on) { const t = danceTime(); music.stop(); setDanceTime(t); }   // read the audio clock before stopping it
    else { if (!playing) setPlaying(true); music.start(danceTime()); }
    syncButtons();
  };
  $("volume").oninput = e => { music.setVolume(Number(e.target.value)); $("volv").textContent = Math.round(e.target.value * 100) + "%"; };
  $("crisp").onchange = resize;
  for (const [id, view] of Object.entries(VIEWS)) $("view-" + id).onclick = view;

  $("tab-replay").onclick = () => setMode("replay");
  $("tab-try").onclick = () => setMode("sim");
  $("run").onclick = () => { simSource = choreo; $("editor").value = formatDoc(choreo); runDance(choreo); };
  $("stopdance").onclick = () => { sim.stop(); message("Stopped. Steve holds his last pose; drag a slider or press Run.", ""); };
  $("resetpose").onclick = () => { sim.resetPose(); message("", ""); };
  $("tempo").oninput = () => { $("tempov").textContent = bpmNow() + " BPM"; };
  $("tempo").onchange = () => { if (sim.running) runDance(simSource || choreo); };      // retime a dance that is running
  $("apply").onclick = () => {
    let doc;
    try { doc = JSON.parse($("editor").value); } catch (e) { message("That is not valid JSON: " + e.message, "err"); return; }
    runDance(doc);
  };
  $("example").onclick = () => { $("editor").value = formatDoc(EXAMPLE); runDance(EXAMPLE); };
  $("restore").onclick = () => { $("editor").value = formatDoc(choreo); simSource = choreo; runDance(choreo); };

  addEventListener("resize", resize);
  new ResizeObserver(resize).observe(canvas.parentElement);

  VIEWS.three();
  resize();
  setDanceTime(0);                           // start the clock now, not when the page began loading
  syncButtons();
  $("loading").hidden = true;

  renderer.setAnimationLoop(() => {
    const t = danceTime();
    const x = mode === "sim" ? poseSim(t) : pose(t);
    if (mode === "sim") syncSliders();
    if ($("follow").checked) {              // glide the camera along with the robot
      const dx = (x - controls.target.x) * 0.12;
      controls.target.x += dx; camera.position.x += dx;
    }
    clouds.forEach((c, i) => { c.position.x += 0.0015 * (1 + i % 3); if (c.position.x > 8) c.position.x = -8; });
    updateHud(t);
    controls.update();
    renderer.render(scene, camera);
  });
}

boot().catch(err => {
  $("loading").hidden = false;
  $("loading").textContent = "Could not load the replay (" + err.message + "). Serve this folder over http, e.g. python3 -m http.server.";
});
