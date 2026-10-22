"""Tests for the access rights refresh of the document consumer.

By default the access rights of a participant are re-read from the database
before every mutating frame, so that a revocation takes effect immediately.
With AUTHORIZATION_REFRESH_INTERVAL the rights may be cached for a number of
seconds; an explicit change notification always re-reads them.
"""

import json

from asgiref.sync import async_to_sync, sync_to_async
from channels.testing import WebsocketCommunicator
from django.test import TransactionTestCase, override_settings

from document.consumers import WebsocketConsumer
from document.models import AccessRight, Document, DocumentTemplate
from user.models import User


def consumer_app(user, document_id):
    """Wrap the consumer in an ASGI app that injects scope["user"] and
    the URL route kwargs a real URLRouter would provide."""
    inner = WebsocketConsumer.as_asgi()

    async def app(scope, receive, send):
        scope["user"] = user
        scope["url_route"] = {
            "path": f"/ws/document/{document_id}/",
            "kwargs": {"document_id": str(document_id)},
        }
        await inner(scope, receive, send)

    return app


class AuthorizationRefreshTest(TransactionTestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username="authz-owner", password="pass"
        )
        self.writer = User.objects.create_user(
            username="authz-writer", password="pass"
        )
        self.template = DocumentTemplate.objects.create(
            title="Authz Template", content={}
        )
        self.doc = Document.objects.create(
            owner=self.owner, template=self.template, title="Doc"
        )
        self.access_right = AccessRight.objects.create(
            document=self.doc, holder_obj=self.writer, rights="write"
        )

    def tearDown(self):
        WebsocketConsumer.remove_session(self.doc.id)

    async def _subscribe(self):
        """Connect as the writer and subscribe.

        Returns the communicator and the server's message counter, which the
        client has to echo in its next message.
        """
        communicator = WebsocketCommunicator(
            consumer_app(self.writer, self.doc.id),
            f"/ws/document/{self.doc.id}/",
        )
        connected, _ = await communicator.connect()
        assert connected
        await communicator.receive_from(5)  # welcome
        await communicator.send_json_to(
            {
                "type": "subscribe",
                "c": 1,
                "s": 1,
                "connection": 0,
                "v": self.doc.version,
            }
        )
        # Drain the bootstrap messages (session info, participant list).
        seen = set()
        server_counter = 1
        while not {"connections", "session_info"}.issubset(seen):
            message = json.loads(await communicator.receive_from(5))
            seen.add(message.get("type"))
            server_counter = message.get("s", server_counter)
        return communicator, server_counter

    def _consumer(self):
        session = WebsocketConsumer.runtime_sessions[self.doc.id]
        return list(session["participants"].values())[0]

    async def _participant_update(self, communicator, counter, server_counter):
        """Send a mutating frame and return the type of the response."""
        counter[0] += 1
        await communicator.send_json_to(
            {
                "type": "participant_update",
                "c": counter[0],
                "s": server_counter,
            }
        )
        message = json.loads(await communicator.receive_from(5))
        return message.get("type"), message.get("s", server_counter)

    def test_rights_are_reread_before_every_mutating_frame(self):
        """Without an interval, a revocation takes effect immediately."""

        async def run():
            communicator, server_counter = await self._subscribe()
            counter = [1]
            # First frame: the rights are read from the database.
            _, server_counter = await self._participant_update(
                communicator, counter, server_counter
            )
            await sync_to_async(self.access_right.delete)()
            # Second frame: the rights are read again, so the revocation
            # takes effect immediately.
            message_type, _ = await self._participant_update(
                communicator, counter, server_counter
            )
            await communicator.disconnect()
            return message_type

        message_type = async_to_sync(run)()
        self.assertEqual(message_type, "access_denied")

    @override_settings(AUTHORIZATION_REFRESH_INTERVAL=60)
    def test_rights_are_cached_within_the_interval(self):
        """With an interval, the cached rights are used until it expires."""

        async def run():
            communicator, server_counter = await self._subscribe()
            counter = [1]
            # First frame: the rights are read from the database and cached.
            _, server_counter = await self._participant_update(
                communicator, counter, server_counter
            )
            await sync_to_async(self.access_right.delete)()
            # Second frame: the cached rights are used, so the participant
            # is not disconnected right away.
            message_type, _ = await self._participant_update(
                communicator, counter, server_counter
            )
            await communicator.disconnect()
            return message_type

        message_type = async_to_sync(run)()
        self.assertEqual(message_type, "connections")

    @override_settings(AUTHORIZATION_REFRESH_INTERVAL=60)
    def test_access_changed_always_rereads_the_rights(self):
        """An explicit notification is never served from the cache."""

        async def run():
            communicator, _ = await self._subscribe()
            await sync_to_async(self.access_right.delete)()
            await self._consumer().access_changed()
            message = json.loads(await communicator.receive_from(5))
            await communicator.disconnect()
            return message

        message = async_to_sync(run)()
        self.assertEqual(message.get("type"), "access_denied")
