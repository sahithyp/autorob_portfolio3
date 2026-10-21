#!/usr/bin/env python3
"""Record one loop of the moonwalk from the running Project 3 runtime into assets/replay.json.

    (cd submission && make demo) &            # runtime on 127.0.0.1:9095
    python3 tools/record_replay.py

It loads the robot, starts the choreography, waits out the first loop (so the recorded loop starts
from the finale pose and ends there too: it repeats seamlessly), then stores every /xform_world
message of the second loop.  Each message holds one column-major 4x4 matrix per link; the bottom
row is always 0 0 0 1, so only 12 numbers per link are kept.
"""
import json
import socket
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
REPO = HERE.parent                                   # .../p3
URDF = HERE / "assets" / "minecraft_steve.urdf"
CHOREO = REPO / "viewer" / "choreographies" / "moonwalk.json"
OUT = HERE / "assets" / "replay.json"
HOST, PORT = "127.0.0.1", 9095
STANDING_Z = 0.72           # straight legs; the choreography's first state is a squat from here
SEAM = 0.05                 # s: stop this early so the wrap interpolates between two settled finale poses
LATENCY = 0.06              # s: pose -> /joint_states -> /tf -> /xform_world takes about two ticks


class Runtime:
    def __init__(self):
        self.sock = socket.create_connection((HOST, PORT), timeout=5)
        self.sock.settimeout(None)
        self.file = self.sock.makefile("rb")
        self.n = 0

    def send(self, msg):
        self.sock.sendall((json.dumps(msg) + "\n").encode())

    def read(self):
        return json.loads(self.file.readline())

    def call(self, service, args):
        self.n += 1
        cid = "rec%d" % self.n
        self.send({"op": "call_service", "service": service, "id": cid, "args": args})
        while True:
            m = self.read()
            if m.get("op") == "service_response" and m.get("id") == cid:
                return m


def main():
    rt = Runtime()
    rt.send({"op": "advertise", "topic": "/global_pose", "type": "geometry_msgs/Pose"})
    rt.send({"op": "subscribe", "topic": "/xform_world", "type": "xform_world/MatrixTransformArray"})

    reply = rt.call("/param_server/set_param", {"name": "robot_description", "value": URDF.read_text()})
    assert reply.get("result"), reply
    rt.send({"op": "publish", "topic": "/global_pose", "msg": {
        "position": {"x": 0, "y": 0, "z": STANDING_Z}, "orientation": {"x": 0, "y": 0, "z": 0, "w": 1}}})
    time.sleep(0.5)

    doc = json.loads(CHOREO.read_text())
    period = sum(s["hold"] for s in doc["states"])
    t_start = time.monotonic()
    reply = rt.call("/fsm/update_logic", doc)
    assert reply.get("result"), reply
    loop_start = t_start + (time.monotonic() - t_start) / 2 + period      # second pass through intro_1
    print("loop is %.2f s; recording the second pass, starting in %.1f s" % (period, loop_start - time.monotonic()))

    links, times, frames = None, [], []
    while True:
        m = rt.read()
        now = time.monotonic()
        if m.get("topic") != "/xform_world" or now < loop_start - 1.0:
            continue                      # first pass (we keep reading so the socket doesn't back up)
        t = now - loop_start - LATENCY
        if t >= period - SEAM:
            break                         # the next loop's first move is already starting; stop before it
        entries = m["msg"]["transforms"]
        names = [e["child_frame_id"] for e in entries]
        if links is None:
            links = names
        assert names == links, "link order changed"
        flat = []
        for e in entries:
            M = e["matrix"]
            assert M[3] == M[7] == M[11] == 0 and M[15] == 1
            flat += [M[i] for i in (0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14)]
        times.append(round(t, 4))
        frames.append([round(v, 4) for v in flat])
    rt.call("/fsm/set_running", {"data": False})

    # drop the lead-in (< 0 after the latency shift) but keep one frame before 0 for interpolation
    first = max(i for i, t in enumerate(times) if t <= 0) if any(t <= 0 for t in times) else 0
    times, frames = times[first:], frames[first:]
    out = {"duration": period, "bpm": doc["bpm"], "links": links, "times": times, "frames": frames}
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print("wrote %s: %d frames of %d links, %.0f fps, %.1f MB" % (
        OUT.name, len(frames), len(links), len(frames) / period, OUT.stat().st_size / 1e6))


if __name__ == "__main__":
    sys.exit(main())
