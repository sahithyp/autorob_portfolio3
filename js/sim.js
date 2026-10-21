// A small in-browser version of the runtime pieces that make Steve move, so visitors can drive him themselves:
//
//   joint servo   each joint eases toward its setpoint (exponential, gain 10 per second, clamped to limits)
//   FSM           a table of states; each state = joint setpoints + optional "hold" (beats) and "base" (glide)
//   kinematics    URDF joint chain -> one 4x4 matrix per link (column-major, like /xform_world)
//
// It is a port of the Python runtime's joint_state_publisher, finite_state_machine and forward kinematics.
// No DOM needed except parseRobot(), so the maths can be checked against the recorded replay.

export const SERVO_GAIN = 10;       // per second
export const BASE_GAIN = 8;         // per second, for a base move that has no "hold"
export const STAND = { x: 0, y: 0, z: 0.72, yaw: 0 };   // standing on the floor (straight legs)
const BASE_KEYS = ["x", "y", "z", "yaw"];

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const finite = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---------------------------------------------------------------- 4x4 maths (column-major arrays of 16)

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a, b) {                // a * b
  const r = new Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++)
    r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
  return r;
}
const translation = (x, y, z) => { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m; };
const fromRotation = R => [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, 0, 0, 0, 1]; // R is row-major 3x3

function rotationRPY(roll, pitch, yaw) {          // URDF: Rz(yaw) * Ry(pitch) * Rx(roll)
  const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  return fromRotation([cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr,
                       sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr,
                       -sp,     cp * sr,                cp * cr]);
}

function rotationAxis(ax, ay, az, angle) {        // Rodrigues' formula; the axis is normalised first
  const n = Math.hypot(ax, ay, az) || 1, x = ax / n, y = ay / n, z = az / n;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return fromRotation([c + x * x * t, x * y * t - z * s, x * z * t + y * s,
                       x * y * t + z * s, c + y * y * t, y * z * t - x * s,
                       x * z * t - y * s, y * z * t + x * s, c + z * z * t]);
}

// ---------------------------------------------------------------- URDF -> kinematic tree

const nums = (s, d) => (s ? s.trim().split(/\s+/).map(Number) : d);
const kids = (el, tag) => [...el.children].filter(c => c.localName === tag);

/** Read only what forward kinematics needs: links, and each joint's parent, child, origin, axis, type, limits. */
export function parseRobot(urdfText) {
  const doc = new DOMParser().parseFromString(urdfText, "application/xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName !== "robot") throw new Error("not a <robot> URDF");
  const robot = doc.documentElement;
  const links = kids(robot, "link").map(l => l.getAttribute("name"));
  const joints = kids(robot, "joint").map(j => {
    const type = j.getAttribute("type"), origin = kids(j, "origin")[0], axis = kids(j, "axis")[0], limit = kids(j, "limit")[0];
    return {
      name: j.getAttribute("name"), type,
      parent: kids(j, "parent")[0].getAttribute("link"), child: kids(j, "child")[0].getAttribute("link"),
      xyz: nums(origin && origin.getAttribute("xyz"), [0, 0, 0]), rpy: nums(origin && origin.getAttribute("rpy"), [0, 0, 0]),
      axis: nums(axis && axis.getAttribute("xyz"), [1, 0, 0]),
      lower: type === "continuous" ? -Infinity : Number(limit ? limit.getAttribute("lower") || 0 : 0),
      upper: type === "continuous" ? Infinity : Number(limit ? limit.getAttribute("upper") || 0 : 0),
    };
  });
  const childNames = new Set(joints.map(j => j.child));
  const root = links.find(n => !childNames.has(n));
  const order = [], queue = [root];            // joints in parent-before-child order
  while (queue.length) {
    const p = queue.shift();
    for (const j of joints) if (j.parent === p) { order.push(j); queue.push(j.child); }
  }
  return { links, joints, root, order };
}

// ---------------------------------------------------------------- choreography documents

/** Returns an error message, or null if the document is a valid choreography. */
export function validate(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.states) || !doc.states.length) return "needs a non-empty \"states\" list";
  const names = new Set();
  for (const s of doc.states) {
    if (!s || typeof s.name !== "string") return "every state needs a string \"name\"";
    if (names.has(s.name)) return `duplicate state name "${s.name}"`;
    names.add(s.name);
  }
  for (const s of doc.states) {
    const t = s.target;
    if (!t || !Array.isArray(t.joint_names) || !Array.isArray(t.positions) || t.joint_names.length !== t.positions.length
        || !t.joint_names.every(n => typeof n === "string") || !t.positions.every(finite)) return `state "${s.name}" has an invalid target`;
    if (s.epsilon !== undefined && (!finite(s.epsilon) || s.epsilon < 0)) return `state "${s.name}": epsilon must be >= 0`;
    if (s.hold !== undefined && (!finite(s.hold) || s.hold < 0)) return `state "${s.name}": hold must be >= 0`;
    if (s.base !== undefined && (typeof s.base !== "object" || !Object.entries(s.base).every(([k, v]) => BASE_KEYS.includes(k) && finite(v))))
      return `state "${s.name}": base may only hold numbers x, y, z, yaw`;
    const tn = new Set();
    for (const tr of s.transitions || []) {
      if (!tr || typeof tr.name !== "string" || tn.has(tr.name)) return `state "${s.name}": transitions need unique names`;
      tn.add(tr.name);
      if (!names.has(tr.next_state)) return `state "${s.name}": transition "${tr.name}" goes to an unknown state`;
    }
    if (s.on_arrival !== undefined && !tn.has(s.on_arrival)) return `state "${s.name}": on_arrival "${s.on_arrival}" is not one of its transitions`;
  }
  if (!names.has(doc.initial_state)) return "initial_state does not name a state";
  return null;
}

/** A copy of the dance retimed to a new tempo: every hold (and so every glide) is scaled. */
export function retime(doc, bpm) {
  const k = (doc.bpm || 120) / bpm, out = JSON.parse(JSON.stringify(doc));
  out.bpm = bpm;
  for (const s of out.states) if (s.hold) s.hold = Math.round(s.hold * k * 10000) / 10000;
  return out;
}

// ---------------------------------------------------------------- the simulation

export class Sim {
  constructor(robot) {
    this.robot = robot;
    this.movable = robot.joints.filter(j => j.type !== "fixed");
    this.doc = null;
    this.states = {};
    this.resetPose();
  }

  resetPose() {
    this.pos = {}; this.setpoint = {};
    for (const j of this.movable) this.pos[j.name] = clamp(0, j.lower, j.upper);
    this.base = { ...STAND };
    this.current = null; this.running = false; this.baseTo = null; this.baseFrom = null;
    this.lastT = null; this.now = 0; this.due = 0; this.entered = 0;
  }

  /** Manual control: point a joint at `v` (clamped to its limits). */
  setJoint(name, v) {
    const j = this.movable.find(m => m.name === name);
    if (j) this.setpoint[name] = clamp(v, j.lower, j.upper);
  }

  /** Install a choreography. Returns an error message, or null. */
  load(doc) {
    const error = validate(doc);
    if (error) return error;
    this.doc = doc;
    this.states = Object.fromEntries(doc.states.map(s => [s.name, s]));
    return null;
  }

  /** Begin the choreography at sim time t, from wherever the robot currently is. */
  start(t) {
    if (!this.doc) return;
    this.running = true;
    this.lastT = t; this.now = t;
    this._enter(this.doc.initial_state, t);
  }

  stop() { this.running = false; }

  get stateIndex() { return this.doc && this.current ? this.doc.states.findIndex(s => s.name === this.current) : -1; }

  /** Advance to absolute sim time t. */
  step(t) {
    const dt = this.lastT === null ? 0 : clamp(t - this.lastT, 0, 0.1);
    this.lastT = t; this.now = t;
    const alpha = 1 - Math.exp(-SERVO_GAIN * dt);                    // joint_state_publisher
    for (const j of this.movable) {
      const goal = clamp(this.setpoint[j.name] ?? this.pos[j.name], j.lower, j.upper);
      this.pos[j.name] += (goal - this.pos[j.name]) * alpha;
    }
    if (!this.running || !this.current) return;
    const state = this.states[this.current];                         // finite_state_machine
    this._stepBase(state, dt);
    if (state.on_arrival && t >= this.due && this._arrived(state) && this._baseArrived(state)) {
      const onBeat = (state.hold || 0) > 0 && t - this.due < 0.25;   // schedule from the beat so holds don't drift
      this._take(state, state.on_arrival, onBeat ? this.due : t);
    }
  }

  /** World matrix of every link, in robot.links order (each a column-major array of 16). */
  matrices() {
    const b = this.base, world = { [this.robot.root]: mul(translation(b.x, b.y, b.z), rotationAxis(0, 0, 1, b.yaw)) };
    for (const j of this.robot.order) {
      let m = mul(translation(...j.xyz), rotationRPY(...j.rpy));
      const q = this.pos[j.name] ?? 0;
      if (j.type === "revolute" || j.type === "continuous") m = mul(m, rotationAxis(...j.axis, q));
      else if (j.type === "prismatic") { const n = Math.hypot(...j.axis) || 1; m = mul(m, translation(j.axis[0] / n * q, j.axis[1] / n * q, j.axis[2] / n * q)); }
      world[j.child] = mul(world[j.parent], m);
    }
    return this.robot.links.map(n => world[n]);
  }

  // ---- finite state machine internals ----

  _enter(name, at) {
    const s = this.states[name];
    this.current = name; this.entered = at; this.due = at + (s.hold || 0);
    for (let i = 0; i < s.target.joint_names.length; i++) this.setJoint(s.target.joint_names[i], s.target.positions[i]);
    if (s.base) {
      this.baseFrom = { ...this.base };
      this.baseTo = Object.fromEntries(BASE_KEYS.map(k => [k, s.base[k] ?? this.base[k]]));
      this.baseTo.yaw = this.base.yaw + wrap(this.baseTo.yaw - this.base.yaw);   // shortest way round, cumulative
    } else this.baseTo = null;
  }

  _take(state, transition, at) {
    const tr = (state.transitions || []).find(x => x.name === transition);
    if (tr) this._enter(tr.next_state, at);
  }

  _arrived(state) {
    const eps = state.epsilon ?? 0.02, t = state.target;
    return t.joint_names.every((n, i) => !(n in this.pos) || Math.abs(this.pos[n] - clamp(t.positions[i], this._lo(n), this._hi(n))) <= eps);
  }
  _lo(n) { return this.movable.find(m => m.name === n).lower; }
  _hi(n) { return this.movable.find(m => m.name === n).upper; }

  _baseArrived(state) {
    if (!this.baseTo || (state.hold || 0) > 0) return true;
    const eps = state.epsilon ?? 0.02;
    return BASE_KEYS.every(k => Math.abs(this.baseTo[k] - this.base[k]) <= eps);
  }

  _stepBase(state, dt) {
    if (!this.baseTo) return;
    const hold = state.hold || 0;
    if (hold > 0) {                                  // constant-speed glide (the moonwalk); height eases out like the legs
      const s = Math.min(1, (this.now - this.entered) / hold);
      for (const k of BASE_KEYS) {
        const sk = k === "z" ? 1 - Math.pow(1 - s, 3) : s;
        this.base[k] = this.baseFrom[k] + (this.baseTo[k] - this.baseFrom[k]) * sk;
      }
    } else {
      const a = 1 - Math.exp(-BASE_GAIN * dt);
      for (const k of BASE_KEYS) this.base[k] += (this.baseTo[k] - this.base[k]) * a;
    }
  }
}
