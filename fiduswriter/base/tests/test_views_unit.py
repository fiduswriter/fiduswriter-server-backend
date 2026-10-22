"""Unit tests for base views."""

import json
from django.test import TestCase, Client
from django.conf import settings
from django.contrib.sites.models import Site
from django.contrib.flatpages.models import FlatPage
from django.test.utils import skipUnless

from user.models import User


AJAX_HEADERS = {"HTTP_X_REQUESTED_WITH": "XMLHttpRequest"}


def json_post(client, url, data):
    return client.post(
        url,
        json.dumps(data),
        content_type="application/json",
        **AJAX_HEADERS,
    )


def ajax_get(client, url, params=None):
    return client.get(url, params or {}, **AJAX_HEADERS)


# ---------------------------------------------------------------------------
# flatpage view
# ---------------------------------------------------------------------------


class FlatpageViewTest(TestCase):
    def setUp(self):
        self.client = Client()
        self.site = Site.objects.get_current()

    def test_unknown_url_returns_404(self):
        response = json_post(
            self.client,
            "/api/base/flatpage/",
            {"url": "/nonexistent-flatpage/"},
        )
        self.assertEqual(response.status_code, 404)

    def test_known_url_returns_200_with_content(self):
        page = FlatPage.objects.create(
            url="/about/",
            title="About Us",
            content="<p>Hello from the about page.</p>",
        )
        page.sites.add(self.site)
        response = json_post(
            self.client,
            "/api/base/flatpage/",
            {"url": "/about/"},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["title"], "About Us")
        self.assertIn("Hello from the about page", data["content"])

    def test_flatpage_on_different_site_not_visible(self):
        other_site = Site.objects.create(
            domain="other.example.com", name="Other"
        )
        page = FlatPage.objects.create(
            url="/other-only/",
            title="Other Site Only",
            content="secret",
        )
        page.sites.add(other_site)
        response = json_post(
            self.client,
            "/api/base/flatpage/",
            {"url": "/other-only/"},
        )
        self.assertEqual(response.status_code, 404)


# ---------------------------------------------------------------------------
# configuration view
# ---------------------------------------------------------------------------


class ConfigurationViewTest(TestCase):
    def setUp(self):
        self.client = Client()
        self.user = User.objects.create_user(
            username="configuser",
            email="configuser@example.com",
            password="pass",
            first_name="Config",
            last_name="User",
        )

    def test_anonymous_user_configuration(self):
        response = ajax_get(self.client, "/api/base/configuration/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("user", data)
        self.assertFalse(data["user"]["is_authenticated"])
        self.assertIn("language", data)
        self.assertIn("ws_url_base", data)

    def test_authenticated_user_configuration(self):
        self.client.force_login(self.user)
        response = ajax_get(self.client, "/api/base/configuration/")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["user"]["is_authenticated"])
        self.assertEqual(data["user"]["username"], "configuser")
        self.assertEqual(data["user"]["first_name"], "Config")
        self.assertEqual(data["user"]["last_name"], "User")
        self.assertIn("emails", data["user"])
        self.assertIn("socialaccounts", data["user"])

    def test_configuration_includes_social_providers(self):
        response = ajax_get(self.client, "/api/base/configuration/")
        data = response.json()
        self.assertIn("socialaccount_providers", data)
        self.assertIsInstance(data["socialaccount_providers"], list)

    def test_authenticated_user_has_waiting_invites_field(self):
        self.client.force_login(self.user)
        response = ajax_get(self.client, "/api/base/configuration/")
        data = response.json()
        self.assertIn("waiting_invites", data["user"])


# ---------------------------------------------------------------------------
# frontend settings hook
# ---------------------------------------------------------------------------


class FrontendSettingsHookTest(TestCase):
    def test_plugins_can_add_frontend_settings(self):
        from base.views import FRONTEND_SETTINGS, get_frontend_settings

        FRONTEND_SETTINGS["PLUGIN_TEST_KEY"] = "plugin-test-value"
        try:
            settings = get_frontend_settings()
            self.assertEqual(settings["PLUGIN_TEST_KEY"], "plugin-test-value")
        finally:
            del FRONTEND_SETTINGS["PLUGIN_TEST_KEY"]

    def test_plugins_can_override_frontend_settings(self):
        from base.views import FRONTEND_SETTINGS, get_frontend_settings

        FRONTEND_SETTINGS["E2EE_MODE"] = "overridden"
        try:
            settings = get_frontend_settings()
            self.assertEqual(settings["E2EE_MODE"], "overridden")
        finally:
            del FRONTEND_SETTINGS["E2EE_MODE"]

    @skipUnless("llm" in settings.INSTALLED_APPS, "llm app not installed")
    def test_llm_plugin_adds_frontend_settings_via_hook(self):
        from base.views import get_frontend_settings

        frontend_settings = get_frontend_settings()
        self.assertIn("LLM_URL", frontend_settings)
        self.assertIn("LLM_MODEL", frontend_settings)
        self.assertIn("LLM_API_KEY_CONFIGURED", frontend_settings)


# ---------------------------------------------------------------------------
# access change notification fan-out
# ---------------------------------------------------------------------------


class NotifyAccessChangeTest(TestCase):
    """notify_access_change fans the access_changed payload out to the
    local relay clients (the native websockets service) and the other
    servers, beside the channel layer group."""

    def test_fanout_reaches_local_relays_and_other_servers(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, patch

        from base.models import Presence
        from document.views import notify_access_change

        user = User.objects.create_user(username="notify-user")
        Presence.objects.create(
            user=user,
            server_url="ws://127.0.0.1:9999/ws/base/",
        )

        relay = SimpleNamespace(
            is_broadcast_relay=True, send_message=AsyncMock()
        )
        browser = SimpleNamespace(
            is_broadcast_relay=False, send_message=AsyncMock()
        )
        with patch(
            "base.consumers.SystemMessageConsumer.clients", [relay, browser]
        ):
            with patch("base.views.send_to_server") as send_to_server:
                notify_access_change(42)

        # The local relay clients receive the system message envelope.
        relay.send_message.assert_awaited_once()
        envelope = relay.send_message.await_args.args[0]
        self.assertEqual(envelope["type"], "system_message")
        self.assertEqual(
            envelope["message"],
            {"type": "access_changed", "document_id": 42},
        )
        # Plain browser connections are not relay clients: no fan-out.
        browser.send_message.assert_not_awaited()
        # The other servers receive the payload through send_to_server.
        send_to_server.assert_called_once()
        args = send_to_server.call_args.args
        self.assertEqual(args[0], "ws://127.0.0.1:9999/ws/base/")
        self.assertEqual(
            args[1], {"type": "access_changed", "document_id": 42}
        )

    def test_presence_with_unsafe_url_is_dropped(self):
        from unittest.mock import AsyncMock, patch
        from types import SimpleNamespace

        from base.models import Presence
        from document.views import notify_access_change

        user = User.objects.create_user(username="notify-user-2")
        Presence.objects.create(
            user=user,
            server_url="ws://evil.example.org/ws/base/",
        )
        relay = SimpleNamespace(
            is_broadcast_relay=True, send_message=AsyncMock()
        )
        with patch(
            "base.consumers.SystemMessageConsumer.clients", [relay]
        ):
            with patch("base.views.send_to_server") as send_to_server:
                notify_access_change(43)

        send_to_server.assert_not_called()
        self.assertEqual(
            Presence.objects.filter(
                server_url="ws://evil.example.org/ws/base/"
            ).count(),
            0,
        )
