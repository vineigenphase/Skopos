import json
import math
import unittest
from unittest.mock import patch
from xml.etree import ElementTree

from fastapi.testclient import TestClient
from pydantic import ValidationError

import app
from engine import DEMO_ROOM
from providers.base import RenderRequest
from providers.mock import H, W, _svg, degradation
from room_mapping import FloorPlan, MappedItem, RoomCapture


def room() -> RoomCapture:
    return RoomCapture(
        source="manual", floor=[(0, 0), (6, 0), (6, 4), (0, 4)], height=2.7,
        robot=(0.4, 0.5), target="mug",
        items=[MappedItem(name="mug", x=5, y=3, radius=0.06),
               MappedItem(name="glass_table_1", x=3, y=2, radius=0.5, reflective=True)],
    )


class GeometryTests(unittest.TestCase):
    def test_capture_preserves_metric_positions_and_semantics(self):
        capture = room()
        scene = capture.scene()
        self.assertEqual(scene.robot, (0.4, 0.5))
        self.assertEqual(scene.target, "mug")
        self.assertEqual(scene.items[0].x, 5)
        self.assertTrue(scene.items[1].reflective)
        self.assertEqual(capture.plan().height, 2.7)
        self.assertEqual(RoomCapture.model_validate_json(capture.model_dump_json()), capture)

    def test_concave_floor_containment_and_inset(self):
        floor = FloorPlan(source="webxr", height=2.5,
                         floor=[(0, 0), (4, 0), (4, 1), (1, 1), (1, 4), (0, 4)])
        self.assertTrue(floor.contains((0.5, 3)))
        self.assertFalse(floor.contains((2, 2)))
        self.assertTrue(floor.contains((0, 0)))
        self.assertFalse(floor.contains((0.1, 0.5), 0.2))
        self.assertTrue(floor.contains((0.5, 0.5), 0.2))

    def test_rejects_crossing_touching_and_degenerate_outlines(self):
        for floor in [
            [(0, 0), (4, 4), (0, 4), (3, 0)],
            [(0, 0), (4, 0), (4, 4), (2, 0), (0, 4)],
            [(0, 0), (0.01, 0), (4, 4), (0, 4)],
            [(0, 0), (0.2, 0), (0.2, 0.2)],
            [(0, 0), (4, 0), (4, 4), (0, 0)],
        ]:
            with self.subTest(floor=floor), self.assertRaises(ValidationError):
                FloorPlan(source="webxr", height=2.5, floor=floor)

    def test_rejects_unsafe_and_non_geometry_payloads(self):
        for field, value in [
            ("height", math.inf), ("height", math.nan), ("height", 0),
            ("source", "automatic_slam"), ("robot", [20, 20]),
            ("target", "<script>"), ("image", "camera-pixels"),
            ("floor", [[0, 0], [40, 0], [0, 4]]),
        ]:
            data = room().model_dump()
            data[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValidationError):
                RoomCapture.model_validate(data)
        for name in ["<svg onload=alert(1)>", "two words", "A" * 100]:
            data = room().model_dump()
            data["items"][0]["name"] = name
            with self.subTest(name=name), self.assertRaises(ValidationError):
                RoomCapture.model_validate(data)

    def test_requires_unique_objects_and_present_target_inside_floor(self):
        for change in ["duplicate", "missing_target", "outside", "too_many"]:
            data = room().model_dump()
            if change == "duplicate":
                data["items"].append(data["items"][0])
            elif change == "missing_target":
                data["target"] = "absent"
            elif change == "outside":
                data["items"][0]["x"] = 10
            else:
                data["items"] *= 20
            with self.subTest(change=change), self.assertRaises(ValidationError):
                RoomCapture.model_validate(data)

    def test_moving_clearing_reset_and_geometry_payload(self):
        capture = room()
        demo = app.Demo(room=capture.plan(), scene=capture.scene(), m=100)
        self.assertFalse(demo.move_item("mug", 10, 3))
        self.assertTrue(demo.move_item("mug", 5.5, 3.5))
        payload = json.loads(demo.scene_payload())
        self.assertEqual(payload["room"]["floor"][1], [6, 0])
        demo.report = {"attribution": [{"object": "glass_table_1"}]}
        moved = demo.clear_top_hazard()
        self.assertIsNotNone(moved)
        item = demo.scene.get("glass_table_1")
        self.assertIsNotNone(item)
        self.assertTrue(demo.room.contains((item.x, item.y), item.radius))
        demo.reset_scene()
        self.assertIsNone(demo.room)
        self.assertEqual(demo.scene, DEMO_ROOM)
        self.assertIsNone(demo.report)

    def test_provider_render_fits_mapped_objects_beyond_the_sample_extent(self):
        svg = ElementTree.fromstring(_svg(room().scene(), RenderRequest(), degradation(0)))
        circles = svg.findall(".//{http://www.w3.org/2000/svg}circle")
        self.assertEqual(len(circles), 3)
        for circle in circles:
            self.assertTrue(0 < float(circle.attrib["cx"]) < W)
            self.assertTrue(0 < float(circle.attrib["cy"]) < H)


class ProtocolTests(unittest.TestCase):
    def test_import_rejection_campaign_and_connected_viewer(self):
        with patch("app.DEMO", app.Demo(m=100)), TestClient(app.app) as client:
            with client.websocket_connect("/ws") as ws, client.websocket_connect("/ws") as viewer:
                self.assertEqual(ws.receive_json()["type"], "hello")
                self.assertIsNone(ws.receive_json()["room"])
                self.assertEqual(viewer.receive_json()["type"], "hello")
                self.assertIsNone(viewer.receive_json()["room"])
                ws.send_json({"type": "set_room", "room": {"image": "not-geometry"}})
                while True:
                    message = ws.receive_json()
                    if message["type"] == "room_error":
                        break
                self.assertEqual(app.DEMO.scene, DEMO_ROOM)
                ws.send_json({"type": "set_room", "room": room().model_dump()})
                received = []
                while True:
                    message = ws.receive_json()
                    received.append(message["type"])
                    if message["type"] == "campaign_done":
                        self.assertEqual(message["scene"]["items"][0]["x"], 5)
                        self.assertEqual(message["report"]["samples"], 100)
                        self.assertEqual(json.loads(message["scene_payload"])["room"]["height"], 2.7)
                        break
                self.assertIn("room_saved", received)
                self.assertIn("scene_changed", received)
                self.assertEqual(app.DEMO.campaign.scene, room().scene())
                while True:
                    message = viewer.receive_json()
                    if message["type"] == "state" and message["room"]:
                        self.assertEqual(message["room"]["source"], "manual")
                        self.assertEqual(message["scene"]["robot"], [0.4, 0.5])
                        break
                response = client.get("/api/scene")
                self.assertEqual(response.json()["room"]["floor"][2], [6, 4])
                ws.send_json({"type": "reset_scene", "rerun": False})
                while True:
                    message = ws.receive_json()
                    if message["type"] == "scene_changed":
                        self.assertIsNone(message["room"])
                        break


if __name__ == "__main__":
    unittest.main()
