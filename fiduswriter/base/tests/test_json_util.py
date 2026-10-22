"""Tests for the JSON compatibility wrapper.

The wrapper prefers orjson (the Rust implementation) and falls back to the
standard library. The fallback is what a PyPy installation uses, so it must
keep working — this test forces it.
"""

from django.test import SimpleTestCase

from base import json_util


class JsonUtilTest(SimpleTestCase):
    def test_roundtrip(self):
        payload = {"a": 1, "b": [1, 2, 3], "c": "text"}
        self.assertEqual(
            json_util.json.loads(json_util.json.dumps(payload)), payload
        )

    def test_stdlib_fallback(self):
        """The pure-Python fallback must behave the same."""
        original = json_util._HAS_ORJSON
        json_util._HAS_ORJSON = False
        try:
            self.assertEqual(json_util.backend_name(), "json")
            payload = {"a": 1, "b": [1, 2, 3], "c": "text"}
            self.assertEqual(
                json_util.json.loads(json_util.json.dumps(payload)), payload
            )
            self.assertEqual(
                json_util.json.dumps(payload),
                '{"a": 1, "b": [1, 2, 3], "c": "text"}',
            )
        finally:
            json_util._HAS_ORJSON = original

    def test_backend_name(self):
        self.assertIn(json_util.backend_name(), ("orjson", "json"))
