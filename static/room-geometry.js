"use strict";

const RoomGeometry = {
  normalizeCorners(points) {
    if (points.length < 3 || points.length > 32) throw new Error("Capture 3–32 floor corners.");
    if (points.some(p => p.length !== 3 || p.some(v => !Number.isFinite(v)))) {
      throw new Error("Tracking returned an invalid point. Try the scan again.");
    }
    if (Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1])) > 0.2) {
      throw new Error("Aim at corners on the same floor level, not furniture.");
    }
    const origin = points[0], dx = points[1][0] - origin[0], dz = points[1][2] - origin[2];
    const length = Math.hypot(dx, dz);
    if (length < 0.1) throw new Error("The first two corners must be at least 10 cm apart.");
    const floor = points.map(p => [
      ((p[0] - origin[0]) * dx + (p[2] - origin[2]) * dz) / length,
      (-(p[0] - origin[0]) * dz + (p[2] - origin[2]) * dx) / length
    ]);
    const minX = Math.min(...floor.map(p => p[0])), minY = Math.min(...floor.map(p => p[1]));
    const normalized = floor.map(([x, y]) => [Number((x - minX).toFixed(3)), Number((y - minY).toFixed(3))]);
    RoomGeometry.validateFloor(normalized);
    return normalized;
  },

  validateFloor(floor) {
    if (floor.length < 3 || floor.length > 32) throw new Error("Capture 3–32 floor corners.");
    if (floor.some(p => p.length !== 2 || p.some(v => !Number.isFinite(v) || v < 0 || v > 30))) {
      throw new Error("Room coordinates must be between 0 and 30 metres.");
    }
    const edges = floor.map((p, i) => [p, floor[(i + 1) % floor.length]]);
    const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
    const on = (p, a, b) => Math.abs(cross(a, b, p)) < 1e-6
      && p[0] >= Math.min(a[0], b[0])-1e-6 && p[0] <= Math.max(a[0], b[0])+1e-6
      && p[1] >= Math.min(a[1], b[1])-1e-6 && p[1] <= Math.max(a[1], b[1])+1e-6;
    for (let i = 0; i < edges.length; i++) {
      const [a, b] = edges[i];
      if (Math.hypot(a[0]-b[0], a[1]-b[1]) < 0.1) throw new Error("Corners must be at least 10 cm apart.");
      for (let j = i + 2; j < edges.length; j++) {
        if (i === 0 && j === edges.length - 1) continue;
        const [c, d] = edges[j];
        if ((cross(a,b,c)*cross(a,b,d) < 0 && cross(c,d,a)*cross(c,d,b) < 0)
          || on(a,c,d) || on(b,c,d) || on(c,a,b) || on(d,a,b)) {
          throw new Error("Floor edges cross. Capture corners in order around the room.");
        }
      }
    }
    const area = Math.abs(edges.reduce((sum, [a,b]) => sum + a[0]*b[1] - b[0]*a[1], 0)) / 2;
    if (area < 0.5) throw new Error("Floor area must be at least 0.5 m².");
    return area;
  }
};

if (typeof module !== "undefined") module.exports = RoomGeometry;
else window.RoomGeometry = RoomGeometry;
