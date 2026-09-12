"use strict";

class RoomCaptureUI {
  constructor({getState, submit, show3d}) {
    this.getState = getState;
    this.submit = submit;
    this.show3d = show3d;
    this.el = id => document.getElementById(id);
    this.dialog = this.el("room-dialog");
    this.preview = new RoomView(this.el("capture-preview"));
    this.stream = null;
    this.cameraRequest = 0;
    this.xrSession = null;
    this.points = [];
    this.floor = [];
    this.source = "manual";
    this.pending = false;
    this.el("map-room").onclick = () => this.open();
    this.el("capture-close").onclick = () => this.dialog.close();
    this.dialog.addEventListener("close", () => this.stopCamera());
    this.dialog.addEventListener("cancel", e => { if (this.pending) e.preventDefault(); });
    this.el("capture-camera").onclick = () => this.toggleCamera();
    this.el("capture-ar").onclick = () => this.startAR();
    this.el("capture-dimensions").onclick = () => this.setDimensions();
    this.el("capture-add").onclick = () => { this.addObject(); this.draw(); };
    this.el("capture-form").addEventListener("input", () => this.draw());
    this.el("capture-form").addEventListener("submit", e => { e.preventDefault(); this.save(); });
    this.el("ar-place").onclick = () => this.placeCorner();
    this.el("ar-undo").onclick = () => { this.points.pop(); this.arStatus(); };
    this.el("ar-finish").onclick = () => this.xrSession?.end();
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.stopCamera(); });
    window.addEventListener("pagehide", () => this.stopCamera());
    this.checkAR();
  }

  message(text) { this.el("capture-status").textContent = text; }

  async checkAR() {
    let supported = false;
    try { supported = !!navigator.xr && await navigator.xr.isSessionSupported("immersive-ar"); }
    catch { /* Device capability probes can be blocked by browser permissions. */ }
    this.el("capture-ar").disabled = !supported;
    this.el("capture-capability").textContent = supported
      ? "AR available. Aim at each floor corner in order, then place it. Furniture and ceiling height are entered separately."
      : "AR floor measurement is unavailable in this browser. Try Chrome on an AR-capable Android phone, or enter your room measurements below.";
  }

  open() {
    if (this.pending) return;
    const state = this.getState();
    this.source = state?.room?.source || "manual";
    this.floor = state?.room ? state.room.floor.map(p => [...p]) : [];
    this.el("capture-summary").textContent = "No room captured yet";
    this.el("capture-outline").textContent = "";
    this.el("capture-objects").replaceChildren();
    const scene = state?.room ? state.scene : null;
    const target = scene?.items.find(it => it.name === scene.target);
    for (const [id, value] of [
      ["capture-width", ""], ["capture-depth", ""], ["capture-height", state?.room?.height || 2.5],
      ["robot-x", scene?.robot[0] ?? ""], ["robot-y", scene?.robot[1] ?? ""],
      ["target-x", target?.x ?? ""], ["target-y", target?.y ?? ""]
    ]) this.el(id).value = value;
    scene?.items.filter(it => it.name !== scene.target).forEach(it => this.addObject(it));
    this.message("Start with your floor outline. No camera images are sent or saved. This is a shared demo: applying a room updates connected viewers.");
    this.dialog.showModal();
    this.draw();
  }

  setDimensions() {
    const width = this.el("capture-width").valueAsNumber;
    const depth = this.el("capture-depth").valueAsNumber;
    if (![width, depth].every(v => Number.isFinite(v) && v >= 1 && v <= 30)) {
      this.message("Enter a width and depth between 1 and 30 metres.");
      return;
    }
    this.floor = [[0,0], [width,0], [width,depth], [0,depth]];
    this.source = "manual";
    this.message("Rectangular floor from your measurements. Enter robot, target and furniture positions in metres from the lower-left corner.");
    this.draw();
  }

  addObject(item = null) {
    if (this.el("capture-objects").children.length >= 31) {
      this.message("Up to 31 furniture objects plus the fetch target are supported.");
      return;
    }
    const row = document.createElement("div");
    row.className = "capture-object";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Object type");
    const kinds = ["sofa", "glass_table", "dark_rug", "floor_lamp", "cable_coil", "chair", "cabinet"];
    const kind = item?.name.replace(/_\d+$/, "");
    if (kind && !kinds.includes(kind)) kinds.push(kind);
    for (const value of kinds) select.add(new Option(value.replaceAll("_", " "), value));
    if (kind) select.value = kind;
    row.append(select);
    for (const [key, text, max, value] of [
      ["x", "X (m)", 30, item?.x ?? ""], ["y", "Y (m)", 30, item?.y ?? ""],
      ["radius", "Radius (m)", 3, item?.radius ?? 0.3]
    ]) {
      const label = document.createElement("label");
      label.textContent = text;
      const input = document.createElement("input");
      input.type = "number"; input.min = key === "radius" ? "0.03" : "0";
      input.max = String(max); input.step = "0.01"; input.required = true;
      input.dataset.key = key; input.value = value;
      label.append(input); row.append(label);
    }
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "Remove";
    remove.onclick = () => { row.remove(); this.draw(); };
    row.append(remove);
    this.el("capture-objects").append(row);
  }

  payload() {
    const items = [...this.el("capture-objects").children].map((row, i) => {
      const kind = row.querySelector("select").value;
      const number = key => row.querySelector(`[data-key="${key}"]`).valueAsNumber;
      return {name: kind + "_" + (i+1), x: number("x"), y: number("y"), radius: number("radius"),
        reflective: kind === "glass_table", low_contrast: kind === "dark_rug",
        movable: !["sofa", "cabinet", "dark_rug"].includes(kind)};
    });
    items.push({name: "mug", x: this.el("target-x").valueAsNumber,
      y: this.el("target-y").valueAsNumber, radius: 0.06});
    return {source: this.source, floor: this.floor, height: this.el("capture-height").valueAsNumber,
      robot: [this.el("robot-x").valueAsNumber, this.el("robot-y").valueAsNumber], target: "mug", items};
  }

  draw() {
    const room = this.payload();
    this.el("capture-empty").hidden = this.floor.length >= 3;
    this.el("capture-preview").hidden = this.floor.length < 3;
    if (this.floor.length < 3) return;
    const area = RoomGeometry.validateFloor(this.floor);
    const valid = p => p.every(Number.isFinite);
    const scene = {items: room.items.filter(it => valid([it.x, it.y, it.radius])),
      robot: valid(room.robot) ? room.robot : this.floor[0], target: "mug"};
    this.preview.update(scene, {...room, height: Number.isFinite(room.height) ? room.height : 2.5});
    this.el("capture-summary").textContent = `${this.source === "webxr" ? "AR-estimated" : "Entered"} floor · ${area.toFixed(2)} m² · ${this.floor.length} corners`;
    this.el("capture-outline").textContent = this.floor.map((p, i) => `${i+1}: (${p[0].toFixed(2)}, ${p[1].toFixed(2)})`).join(" · ");
  }

  save() {
    if (this.pending) return;
    try { RoomGeometry.validateFloor(this.floor); }
    catch (error) { this.message(error.message); return; }
    if (!this.submit(this.payload())) {
      this.message("Demo disconnected. Wait for it to reconnect, then apply your room again.");
      return;
    }
    this.pending = true;
    this.el("capture-apply").disabled = true;
    this.el("capture-close").disabled = true;
    this.message("Applying geometry to the live demo…");
  }

  received(error = null) {
    this.pending = false;
    this.el("capture-apply").disabled = false;
    this.el("capture-close").disabled = false;
    if (error) this.message(error);
    else { this.dialog.close(); this.show3d(); }
  }

  stopCamera() {
    this.cameraRequest++;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.el("capture-video").srcObject = null;
    this.el("capture-video").hidden = true;
    this.el("capture-camera").textContent = "Open camera reference";
  }

  async toggleCamera() {
    if (this.stream) { this.stopCamera(); return; }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.message("Camera needs an HTTPS page with camera permission. Open the preview in a browser tab, or enter measurements.");
      return;
    }
    const request = ++this.cameraRequest;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: "environment"}}, audio: false});
      if (request !== this.cameraRequest || !this.dialog.open) {
        stream.getTracks().forEach(track => track.stop()); return;
      }
      this.stream = stream;
      const video = this.el("capture-video");
      video.srcObject = stream; video.hidden = false;
      await video.play();
      this.el("capture-camera").textContent = "Stop camera";
      this.message("Camera reference is live on this device only. It does not recover depth or detect furniture; enter measurements or use AR floor capture.");
    } catch (error) {
      this.stopCamera();
      this.message(error.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access in your browser, or continue with entered measurements."
        : "Camera unavailable. Check that it is connected and not in use, or enter measurements.");
    }
  }

  arStatus() {
    this.el("ar-count").textContent = `${this.points.length} / 32 corners`;
    this.el("ar-undo").disabled = this.points.length === 0;
    this.el("ar-finish").textContent = this.points.length >= 3 ? "Finish floor" : "Exit AR";
  }

  placeCorner() {
    if (!this.latestHit || this.points.length >= 32) return;
    const p = this.latestHit;
    if (this.points.length && Math.abs(p[1] - this.points[0][1]) > 0.2) {
      this.el("ar-status").textContent = "Aim at the same floor level as the first corner."; return;
    }
    if (this.points.some(q => Math.hypot(q[0]-p[0], q[2]-p[2]) < 0.1)) {
      this.el("ar-status").textContent = "That corner is already placed. Move to the next one."; return;
    }
    this.points.push([...p]);
    this.arStatus();
  }

  async startAR() {
    this.stopCamera();
    this.el("capture-ar").disabled = true;
    this.points = []; this.latestHit = null;
    this.arStatus();
    const overlay = this.el("ar-overlay");
    let session = null;
    try {
      session = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["local", "hit-test", "dom-overlay"],
        domOverlay: {root: overlay}
      });
      this.xrSession = session;
      this.dialog.close();
      overlay.hidden = false;
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl", {xrCompatible: true, alpha: true});
      if (!gl) throw new Error("WebGL is unavailable on this device.");
      await gl.makeXRCompatible();
      const layer = new XRWebGLLayer(session, gl);
      session.updateRenderState({baseLayer: layer});
      const space = await session.requestReferenceSpace("local");
      const viewer = await session.requestReferenceSpace("viewer");
      const source = await session.requestHitTestSource({space: viewer});
      const renderer = this.arRenderer(gl);
      session.addEventListener("end", () => {
        source.cancel(); renderer.dispose();
        this.xrSession = null; this.latestHit = null;
        overlay.hidden = true;
        this.dialog.showModal();
        try {
          if (this.points.length < 3) throw new Error("Capture ended before 3 corners were placed. Your previous outline is unchanged.");
          this.floor = RoomGeometry.normalizeCorners(this.points);
          this.source = "webxr";
          this.draw();
          this.message("Floor captured from device tracking. Check the outline, enter ceiling height and object positions, then apply it to the demo.");
        } catch (error) { this.message(error.message); }
        this.checkAR();
      }, {once: true});
      space.addEventListener("reset", () => {
        this.points = []; this.latestHit = null; this.arStatus();
        this.el("ar-status").textContent = "Tracking origin changed. Start placing corners again.";
      });
      const frame = (_time, xrFrame) => {
        if (this.xrSession !== session) return;
        session.requestAnimationFrame(frame);
        this.latestHit = null;
        const pose = xrFrame.getViewerPose(space);
        const hit = xrFrame.getHitTestResults(source)[0]?.getPose(space);
        if (pose && hit && Math.abs(hit.transform.matrix[5]) > 0.9) {
          const p = hit.transform.position;
          this.latestHit = [p.x, p.y, p.z];
        }
        this.el("ar-place").disabled = !this.latestHit || this.points.length >= 32;
        this.el("ar-status").textContent = this.latestHit
          ? "Floor found. Aim the green ring at a floor corner, then place."
          : "Move slowly and point down until a floor surface is detected.";
        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (pose) {
          for (const view of pose.views) {
            const viewport = layer.getViewport(view);
            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
            renderer.draw(view, this.points, this.latestHit);
          }
        }
      };
      session.requestAnimationFrame(frame);
    } catch (error) {
      if (session) await session.end().catch(() => {});
      this.xrSession = null;
      overlay.hidden = true;
      if (!this.dialog.open) this.dialog.showModal();
      this.message("Could not start AR: " + error.message + " Use an AR-capable browser with hit-test and DOM overlay support, or enter measurements.");
      this.checkAR();
    }
  }

  arRenderer(gl) {
    const shader = (type, code) => {
      const result = gl.createShader(type);
      gl.shaderSource(result, code); gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error("Could not compile AR overlay.");
      return result;
    };
    const vertex = shader(gl.VERTEX_SHADER, "attribute vec3 position; uniform mat4 projection; uniform mat4 view; void main(){gl_Position=projection*view*vec4(position,1.0);}");
    const fragment = shader(gl.FRAGMENT_SHADER, "precision mediump float; void main(){gl_FragColor=vec4(0.25,1.0,0.65,1.0);}");
    const program = gl.createProgram();
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Could not link AR overlay.");
    const buffer = gl.createBuffer(), position = gl.getAttribLocation(program, "position");
    const projection = gl.getUniformLocation(program, "projection"), viewMatrix = gl.getUniformLocation(program, "view");
    return {
      draw(view, points, hit) {
        const vertices = [];
        const ring = (p, radius) => {
          for (let i = 0; i < 32; i++) {
            for (const j of [i, i+1]) {
              const angle = j / 32 * Math.PI * 2;
              vertices.push(p[0]+Math.cos(angle)*radius, p[1]+0.01, p[2]+Math.sin(angle)*radius);
            }
          }
        };
        points.forEach(p => ring(p, 0.04));
        if (hit) ring(hit, 0.09);
        for (let i = 1; i < points.length; i++) vertices.push(...points[i-1], ...points[i]);
        if (points.length >= 3) vertices.push(...points[points.length-1], ...points[0]);
        gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(projection, false, view.projectionMatrix);
        gl.uniformMatrix4fv(viewMatrix, false, view.transform.inverse.matrix);
        gl.drawArrays(gl.LINES, 0, vertices.length / 3);
      },
      dispose() { gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment); }
    };
  }
}

window.RoomCaptureUI = RoomCaptureUI;
