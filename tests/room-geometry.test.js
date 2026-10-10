"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const geometry = require("../static/room-geometry.js");

test("AR corners preserve metric distances after translation and rotation", () => {
  const angle = 0.7, origin = [12, -1.5, -8];
  const rectangle = [[0,0], [5,0], [5,3], [0,3]];
  const points = rectangle.map(([x,z]) => [
    origin[0] + Math.cos(angle)*x - Math.sin(angle)*z,
    origin[1],
    origin[2] + Math.sin(angle)*x + Math.cos(angle)*z
  ]);
  assert.deepEqual(geometry.normalizeCorners(points), rectangle);
  assert.equal(geometry.validateFloor(rectangle), 15);
});

test("clockwise captures and a concave floor stay usable", () => {
  const points = [[-3,-1,-4], [-3,-1,-2], [-1,-1,-2], [-1,-1,-4]];
  assert.equal(geometry.validateFloor(geometry.normalizeCorners(points)), 4);
  assert.equal(geometry.validateFloor([[0,0], [4,0], [4,1], [1,1], [1,4], [0,4]]), 7);
});

test("tracking errors, furniture-height hits and duplicate corners are rejected", () => {
  for (const points of [
    [[0,0,0], [3,0,0]],
    [[0,0,0], [3,0.7,0], [3,0,3]],
    [[0,0,0], [0.001,0,0], [3,0,3]],
    [[0,0,0], [3,0,0], [3,0,Infinity]],
    [[0,0,0], [3,0,0], [3,0,3], [0,0,0]],
  ]) assert.throws(() => geometry.normalizeCorners(points));
});

test("crossing edges, touching edges, unbounded coordinates and tiny floors fail", () => {
  for (const floor of [
    [[0,0], [4,4], [0,4], [3,0]],
    [[0,0], [4,0], [4,4], [2,0], [0,4]],
    [[0,0], [31,0], [31,3], [0,3]],
    [[0,0], [0.2,0], [0.2,0.2]],
    [[0,0], [NaN,0], [3,3]],
  ]) assert.throws(() => geometry.validateFloor(floor));
});
