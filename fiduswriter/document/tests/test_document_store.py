"""Regression tests for the document store save paths.

The Rust ProseMirror engine writes the ``content`` column with a raw UPDATE
(``Document.save_content_str``) that does *not* refresh ``doc.content`` in
memory. A save that has no engine-managed content available — the periodic
save after the content was already written, or the shutdown flush — must
therefore never write the content column through the ORM: doing so would
persist the content as it was when the session was opened and silently revert
newer edits.

These tests run against whichever engine is active (``PROSEMIRROR_BACKEND``)
and are executed for both engines in CI.
"""

import json

from asgiref.sync import async_to_sync
from django.test import TestCase

from document.helpers import document_store
from document.models import Document, DocumentTemplate
from user.models import User

CONTENT_V0 = {
    "type": "doc",
    "content": [
        {
            "type": "paragraph",
            "content": [{"type": "text", "text": "hello"}],
        }
    ],
}

CONTENT_V1 = {
    "type": "doc",
    "content": [
        {
            "type": "paragraph",
            "content": [{"type": "text", "text": "hello world"}],
        }
    ],
}


class DocumentStoreSaveTest(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username="store-owner", password="pass"
        )
        self.template = DocumentTemplate.objects.create(
            title="Store Template", content={}
        )
        self.doc = Document.objects.create(
            owner=self.owner,
            template=self.template,
            title="Doc",
            content=CONTENT_V0,
            version=1,
        )

    def _write_newer_content(self, content):
        """Persist *content* the way the active engine does.

        The Rust engine writes the content column with a raw UPDATE and does
        not touch ``doc.content`` in memory; the Python engine keeps the
        model instance in sync. Both cases must survive a subsequent save
        that has no engine-managed content available.
        """
        self.doc.version = 2
        if document_store._USE_RUST:
            async_to_sync(self.doc.asave_content_str)(
                json.dumps(content),
                ["content", "version", "updated"],
            )
        else:
            self.doc.content = content
            self.doc.save(update_fields=["content", "version", "updated"])

    def test_save_without_node_keeps_the_newer_content(self):
        """A save without engine-managed content must not revert the content.

        Regression test for the Rust engine, where ``doc.content`` in memory
        is stale after the raw content write.
        """
        self._write_newer_content(CONTENT_V1)

        saved = async_to_sync(document_store.save_document_async)(
            doc=self.doc, node=None, force=True
        )
        self.assertTrue(saved)

        self.doc.refresh_from_db()
        self.assertEqual(self.doc.content, CONTENT_V1)
        self.assertEqual(self.doc.version, 2)

    def test_save_without_node_keeps_the_newer_content_sync(self):
        """The synchronous save path must not revert the content either."""
        self._write_newer_content(CONTENT_V1)

        saved = document_store.save_document(
            doc=self.doc, node=None, force=True
        )
        self.assertTrue(saved)

        self.doc.refresh_from_db()
        self.assertEqual(self.doc.content, CONTENT_V1)
        self.assertEqual(self.doc.version, 2)

    def test_e2ee_content_is_written_through_the_orm(self):
        """E2EE content is opaque ciphertext managed by Django.

        The in-memory value is authoritative there, so it must still be
        written through the ORM even in Rust mode.
        """
        self.doc.e2ee = True
        self.doc.content = "encrypted-payload"
        self.doc.save(update_fields=["e2ee", "content"])

        saved = async_to_sync(document_store.save_document_async)(
            doc=self.doc, node=None, force=True
        )
        self.assertTrue(saved)

        self.doc.refresh_from_db()
        self.assertEqual(self.doc.content, "encrypted-payload")

    def test_content_update_fields_drop_content_only_for_rust(self):
        """The content column is only protected in Rust mode."""
        fields = ["title", "version", "content", "updated"]
        if document_store._USE_RUST:
            self.assertNotIn(
                "content",
                document_store._content_update_fields(self.doc, fields),
            )
        else:
            self.assertIn(
                "content",
                document_store._content_update_fields(self.doc, fields),
            )
