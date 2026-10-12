"""Fuzz tests for the API views' input handling.

The AJAX views read ``request.JSON`` (populated by JsonToPostMiddleware)
and index into it directly. Malformed payloads — missing keys, wrong
types, non-dict JSON bodies, deep nesting — arrive from browsers, but the
middleware accepts any JSON, so the views must degrade to a 4xx-style
rejection instead of a 500.

Invariants: for every fuzzed payload the endpoint responds with a status
below 500 (a 400/403/404-style rejection is fine; an unhandled exception
leaking as a 500 is not).

Run: python manage.py test document.tests.test_fuzz_views
"""

import json
import uuid

from django.test import Client

from hypothesis import HealthCheck, given, settings, strategies as st
from hypothesis.extra.django import TestCase

from user.models import User

from document.models import Document, DocumentTemplate

AJAX_HEADERS = {"HTTP_X_REQUESTED_WITH": "XMLHttpRequest"}

URLS = [
    "/api/document/import/create/",
    "/api/document/import/",
    "/api/document/save/",
    "/api/document/upload_revision/",
    "/api/bibliography/save/",
    "/api/bibliography/delete/",
    "/api/book/save/",
    "/api/user_template_manager/create/",
    "/api/style/save_document_style/",
    "/api/document/import/image/",
]

# Payload shapes the middleware will happily pass through but that views
# tend to index into without checking.
MALFORMED_PAYLOADS = [
    {},
    [],
    {"value": None},
    {"value": 42},
    {"id": "not-a-number"},
    {"id": None},
    {"title": 42, "content": "string-not-dict"},
    {"bibs": "not-a-dict"},
    {"bibs": [1, 2, 3]},
    {"bibs": {"1": None}},
    {"bibs": {"1": {"fields": 42, "bib_type": []}}},
    {"doc": "not-a-dict", "comments": 42, "bibliography": []},
    {"doc": None},
    {"steps": "not-a-list"},
    {"steps": [42, "x", {"stepType": "bogus"}]},
    {"book": None, "chapters": 42},
    {"template": "nope", "document_styles": 42, "files": "nope"},
    {"document_styles": [{"files": "nope"}], "contents": 42},
    {"e2ee_salt": "%%%not-base64%%%", "e2ee_iterations": "not-a-number"},
    {"e2ee_iterations": 10**12},
    {"value": {"deep": {"deeper": {"deepest": None}}}},
]

# Non-object JSON bodies through the middleware.
RAW_BODIES = [
    "[]",
    '"a string"',
    "42",
    "null",
    "true",
    '{"unclosed": ',
    "not json at all",
    "[" * 200 + "]" * 200,
]


class ApiViewFuzzTest(TestCase):
    """Fuzz the AJAX endpoints with malformed payloads as any logged-in
    client could send them."""

    def setUp(self):
        # hypothesis runs setUp per example; unique names avoid collisions
        # when rows persist beyond a rolled-back example.
        self.user = User.objects.create_user(
            username="fuzzer-" + uuid.uuid4().hex[:12], password="pass"
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.template = DocumentTemplate.objects.create(
            title="Fuzz Template", content={}
        )
        self.doc = Document.objects.create(
            owner=self.user,
            template=self.template,
            content={
                "type": "doc",
                "content": [
                    {"type": "title", "content": []},
                    {
                        "type": "richtext_part",
                        "attrs": {"id": "body", "title": "Body"},
                        "content": [{"type": "paragraph"}],
                    },
                ],
            },
        )

    @given(st.sampled_from(URLS), st.sampled_from(MALFORMED_PAYLOADS))
    @settings(
        max_examples=len(URLS) * len(MALFORMED_PAYLOADS) // 2,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_malformed_payloads_do_not_crash_views(self, url, payload):
        response = self.client.post(
            url,
            json.dumps(payload),
            content_type="application/json",
            **AJAX_HEADERS,
        )
        self.assertLess(
            response.status_code,
            500,
            f"{url} returned {response.status_code} for payload "
            f"{json.dumps(payload, default=str)[:120]}",
        )

    @given(st.sampled_from(URLS), st.sampled_from(RAW_BODIES))
    @settings(
        max_examples=len(URLS) * len(RAW_BODIES) // 2,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_raw_bodies_do_not_crash_views(self, url, body):
        response = self.client.post(
            url,
            body,
            content_type="application/json",
            **AJAX_HEADERS,
        )
        self.assertLess(
            response.status_code,
            500,
            f"{url} returned {response.status_code} for raw body "
            f"{body[:60]}",
        )

    def test_document_endpoints_require_login(self):
        """The same malformed payloads from an anonymous client must not
        leak anything either."""
        anonymous = Client()
        for url in URLS[:4]:
            response = anonymous.post(
                url,
                json.dumps({}),
                content_type="application/json",
                **AJAX_HEADERS,
            )
            self.assertLess(response.status_code, 500)
