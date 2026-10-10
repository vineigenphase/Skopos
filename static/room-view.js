"use strict";

class RoomView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scene = null;
    this.room = null;
    this.reset();
    let drag = null;
    canvas.addEventListener("pointerdown", e => {
      drag = [e.clientX, e.clientY];
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", e => {
      if (!drag) return;
      this.yaw += (e.clientX - drag[0]) * 0.008;
      this.pitch = Math.max(0.18, Math.min(1.4, this.pitch + (e.clientY - drag[1]) * 0.005));
      drag = [e.clientX, e.clientY];
      this.draw();
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
      canvas.addEventListener(event, () => { drag = null; });
    }
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      this.zoom = Math.max(0.55, Math.min(2.2, this.zoom * Math.exp(-e.deltaY * 0.001)));
      this.draw();
    }, {passive: false});
    canvas.addEventListener("keydown", e => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "0"].includes(e.key)) return;
      e.preventDefault();
      if (e.key === "ArrowLeft") this.yaw -= 0.1;
      if (e.key === "ArrowRight") this.yaw += 0.1;
      if (e.key === "ArrowUp") this.pitch = Math.min(1.4, this.pitch + 0.1);
      if (e.key === "ArrowDown") this.pitch = Math.max(0.18, this.pitch - 0.1);
      if (e.key === "+") this.zoom = Math.min(2.2, this.zoom * 1.1);
      if (e.key === "-") this.zoom = Math.max(0.55, this.zoom / 1.1);
      if (e.key === "0") this.reset();
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  reset() {
    this.yaw = -0.65;
    this.pitch = 0.68;
    this.zoom = 1;
    this.draw();
  }

  update(scene, room) {
    this.scene = scene;
    this.room = room;
    this.draw();
  }

  draw() {
    const {canvas, ctx, scene} = this;
    if (!ctx || !scene || !canvas.clientWidth) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#0b1723"); bg.addColorStop(1, "#070d14");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    const floor = this.room?.floor || [[-0.45, -0.45], [3.6, -0.45], [3.6, 2.9], [-0.45, 2.9]];
    const height = this.room?.height || 2.5;
    const xs = floor.map(p => p[0]), ys = floor.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY, height);
    const distance = span * 3;
    const scale = Math.min(w / (span * 1.7), h / (span * 1.35)) * this.zoom;
    const project = ([x, y, z]) => {
      x -= cx; y -= cy; z -= height * 0.22;
      const side = x * Math.cos(this.yaw) - y * Math.sin(this.yaw);
      const depth = x * Math.sin(this.yaw) + y * Math.cos(this.yaw);
      const up = z * Math.cos(this.pitch) - depth * Math.sin(this.pitch);
      const away = depth * Math.cos(this.pitch) + z * Math.sin(this.pitch);
      const perspective = distance / Math.max(distance - away, span * 0.5);
      return [w / 2 + side * scale * perspective, h * 0.55 - up * scale * perspective, away];
    };
    const path = points => {
      ctx.beginPath();
      points.forEach((p, i) => {
        const q = project(p);
        if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
      });
    };
    const line = (a, b, color = "#284455") => {
      path([a, b]); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
    };
    const label = (text, p, color = "#a6c3d6") => {
      const q = project(p);
      ctx.font = "11px ui-monospace,monospace";
      ctx.textAlign = "center";
      const width = ctx.measureText(text).width;
      ctx.fillStyle = "#0b131ee6";
      ctx.fillRect(q[0] - width / 2 - 5, q[1] - 12, width + 10, 18);
      ctx.fillStyle = color; ctx.fillText(text, q[0], q[1]);
    };
    const base = floor.map(([x, y]) => [x, y, 0]);
    path(base); ctx.closePath(); ctx.fillStyle = "#122836"; ctx.fill();
    ctx.save(); ctx.clip();
    const step = span > 10 ? 1 : 0.5;
    for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) line([x, minY, 0], [x, maxY, 0], "#1d3a49");
    for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) line([minX, y, 0], [maxX, y, 0], "#1d3a49");
    ctx.restore();
    floor.forEach(([x, y], i) => {
      const [nx, ny] = floor[(i + 1) % floor.length];
      line([x, y, 0], [nx, ny, 0], "#4d9cad");
      line([x, y, 0], [x, y, height], "#284756");
      line([x, y, height], [nx, ny, height], "#284756");
      label(Math.hypot(nx - x, ny - y).toFixed(2) + " m", [(x + nx) / 2, (y + ny) / 2, 0]);
    });
    const target = scene.items.find(it => it.name === scene.target && it.present !== false);
    if (target) {
      ctx.setLineDash([7, 6]);
      line([...scene.robot, 0.05], [target.x, target.y, 0.05], "#5fceef");
      ctx.setLineDash([]);
    }
    const faces = [], labels = [];
    const box = (x, y, radius, tall, color, title) => {
      const vertices = [
        [x-radius, y-radius, 0], [x+radius, y-radius, 0],
        [x+radius, y+radius, 0], [x-radius, y+radius, 0],
        [x-radius, y-radius, tall], [x+radius, y-radius, tall],
        [x+radius, y+radius, tall], [x-radius, y+radius, tall]
      ];
      for (const indices of [[0,1,5,4], [1,2,6,5], [2,3,7,6], [3,0,4,7], [4,5,6,7]]) {
        const points = indices.map(i => vertices[i]);
        faces.push({points, color, depth: points.reduce((s, p) => s + project(p)[2], 0) / 4});
      }
      labels.push([title, [x, y, tall + 0.15], color]);
    };
    scene.items.filter(it => it.present !== false).forEach(it => {
      const tall = it.name.includes("rug") || it.name.includes("cable") ? 0.04
        : it.name.includes("mug") ? 0.13 : it.name.includes("lamp") ? 1.5
        : it.name.includes("table") ? 0.75 : it.name.includes("sofa") ? 0.9 : 0.65;
      const color = it.name === scene.target ? "#e6b969" : it.reflective ? "#68bfd5"
        : it.low_contrast ? "#9286af" : "#699fa9";
      box(it.x, it.y, it.radius, Math.min(height, tall), color, it.name.replaceAll("_", " "));
    });
    box(...scene.robot, 0.16, 0.25, "#55dcab", "robot start");
    faces.sort((a, b) => a.depth - b.depth).forEach(face => {
      path(face.points); ctx.closePath();
      ctx.fillStyle = "#152b38"; ctx.fill();
      ctx.fillStyle = face.color + "30"; ctx.fill();
      ctx.strokeStyle = face.color; ctx.stroke();
    });
    labels.forEach(args => label(...args));
  }
}

window.RoomView = RoomView;
