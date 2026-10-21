# Minecraft Steve moonwalks: EECS 367 Project 3 portfolio

A static page (no build step) with a video of my Minecraft robot performing a finite-state-machine
choreography, plus an interactive replay drawn with three.js from the runtime's `/xform_world` matrices.

    python3 -m http.server 8000      # then open http://localhost:8000

| Path | What |
|---|---|
| `index.html`, `css/`, `js/` | the page and the replay viewer |
| `assets/minecraft_steve.urdf` | the robot the viewer draws |
| `assets/replay.json` | one loop of recorded `/xform_world` frames (made by `tools/record_replay.py`) |
| `media/` | the demo video |
