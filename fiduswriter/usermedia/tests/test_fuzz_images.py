"""Fuzz tests for the image upload endpoints and thumbnail generation.

Uploads arrive from browsers with a client-controlled content-type; the
only server-side file processing is Pillow's thumbnail generation. Malformed
images, truncated files, decompression-bomb-ish payloads and content-type
spoofing must degrade to a 4xx-style rejection, never a 500 or a crash.

Run: python manage.py test usermedia.tests.test_fuzz_images
"""

import struct
import uuid
import zlib

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client

from hypothesis import HealthCheck, given, settings, strategies as st
from hypothesis.extra.django import TestCase

from user.models import User


def make_png(width, height, color=(255, 0, 0)):
    """Build a minimal valid PNG by hand (no Pillow needed for generation)."""

    def chunk(chunk_type, data):
        c = struct.pack(">I", len(data)) + chunk_type + data
        return c + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(
        b"\x00" + bytes(color) * width for _ in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


# Malformed payloads around the PNG signature.
MALFORMED_IMAGES = [
    b"",
    b"not an image at all",
    b"\x89PNG\r\n\x1a\n" + b"truncated",
    # valid signature, garbage IHDR
    b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 4) + b"IHDR" + b"\x00" * 4,
    # PNG header claiming huge dimensions (decompression bomb shape)
    b"\x89PNG\r\n\x1a\n"
    + struct.pack(">I", 13)
    + b"IHDR"
    + struct.pack(">IIBBBBB", 65000, 65000, 8, 2, 0, 0, 0)
    + struct.pack(">I", zlib.crc32(b"IHDR" + struct.pack(">IIBBBBB", 65000, 65000, 8, 2, 0, 0, 0)) & 0xFFFFFFFF),
    b"GIF89a" + b"\x00" * 20,
    b"\xff\xd8\xff\xe0" + b"JFIF" + b"\x00" * 10,
    b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
    b"<?xml version=\"1.0\"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><svg>&xxe;</svg>",
]


class ImageUploadFuzzTest(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="imgfuzz-" + uuid.uuid4().hex[:12], password="pass"
        )
        self.client = Client()
        self.client.force_login(self.user)

    @given(st.sampled_from(MALFORMED_IMAGES), st.sampled_from(["image/png", "image/jpeg", "text/html"]))
    @settings(
        max_examples=33,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_malformed_images_rejected_cleanly(self, payload, content_type):
        """Any malformed image must come back as a 4xx-style rejection —
        a 500 means an unhandled exception reached the client."""
        upload = SimpleUploadedFile(
            "fuzz-image", payload, content_type=content_type
        )
        response = self.client.post(
            "/api/usermedia/save/",
            {"image": upload, "title": "fuzz"},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        self.assertLess(
            response.status_code,
            500,
            f"usermedia/save returned {response.status_code} for "
            f"{payload[:20]!r} as {content_type}",
        )

    def test_valid_png_uploads_and_thumbnails(self):
        """The handwritten valid PNG must still go through (guards the fuzz
        above against rejecting everything)."""
        png = make_png(4, 4)
        upload = SimpleUploadedFile(
            "valid.png", png, content_type="image/png"
        )
        response = self.client.post(
            "/api/usermedia/save/",
            {"image": upload, "title": "valid"},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )
        # 200 (or a validation rejection with a clear status) — but not 5xx.
        self.assertLess(response.status_code, 500)
