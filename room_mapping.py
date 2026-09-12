"""Geometry-only room capture; the engine still scores object positions."""
from __future__ import annotations

import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from engine import Item, SceneGraph

Coordinate = Annotated[float, Field(ge=0, le=30, allow_inf_nan=False, strict=True)]
Point = tuple[Coordinate, Coordinate]
Name = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")]


def cross(a: Point, b: Point, c: Point) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segment_distance(p: Point, a: Point, b: Point) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length2 = dx * dx + dy * dy
    t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) if length2 else 0
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


class FloorPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["manual", "webxr"]
    floor: Annotated[list[Point], Field(min_length=3, max_length=32)]
    height: Annotated[float, Field(ge=1, le=6, allow_inf_nan=False, strict=True)]

    @model_validator(mode="after")
    def validate_floor(self) -> FloorPlan:
        edges = list(zip(self.floor, self.floor[1:] + self.floor[:1]))
        if any(math.dist(a, b) < 0.1 for a, b in edges):
            raise ValueError("Floor corners must be at least 10 cm apart.")
        area = abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in edges)) / 2
        if area < 0.5:
            raise ValueError("Floor area must be at least 0.5 square metres.")
        for i, (a, b) in enumerate(edges):
            for j, (c, d) in enumerate(edges):
                if j <= i + 1 or (i == 0 and j == len(edges) - 1):
                    continue
                touching = min(segment_distance(a, c, d), segment_distance(b, c, d),
                               segment_distance(c, a, b), segment_distance(d, a, b)) < 1e-6
                crossing = cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0
                if touching or crossing:
                    raise ValueError("Floor edges cross. Capture corners in order around the room.")
        return self

    def contains(self, point: Point, inset: float = 0) -> bool:
        inside = False
        distance = math.inf
        x, y = point
        for a, b in zip(self.floor, self.floor[1:] + self.floor[:1]):
            distance = min(distance, segment_distance(point, a, b))
            if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
        return (inside or distance < 1e-6) and distance + 1e-6 >= inset


class MappedItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    x: Coordinate
    y: Coordinate
    radius: Annotated[float, Field(ge=0.03, le=3, allow_inf_nan=False, strict=True)]
    reflective: bool = False
    low_contrast: bool = False
    movable: bool = True


class RoomCapture(FloorPlan):
    items: Annotated[list[MappedItem], Field(min_length=1, max_length=32)]
    robot: Point
    target: Name

    @model_validator(mode="after")
    def validate_scene(self) -> RoomCapture:
        names = [it.name for it in self.items]
        if len(set(names)) != len(names):
            raise ValueError("Object names must be unique.")
        if self.target not in names:
            raise ValueError("Place the fetch target in the room.")
        if not self.contains(self.robot):
            raise ValueError("Robot start must be inside the floor outline.")
        for item in self.items:
            if not self.contains((item.x, item.y)):
                raise ValueError(f"{item.name.replace('_', ' ')} must be inside the floor outline.")
        return self

    def scene(self) -> SceneGraph:
        return SceneGraph(
            items=tuple(Item(**it.model_dump()) for it in self.items),
            robot=self.robot, target=self.target,
        )

    def plan(self) -> FloorPlan:
        return FloorPlan(source=self.source, floor=self.floor, height=self.height)
