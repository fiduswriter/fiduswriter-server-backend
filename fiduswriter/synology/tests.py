"""Tests for the Synology Docker bridge authentication middleware."""

import os
import tempfile

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import Client, TestCase, override_settings

from synology.middleware import ADMIN_GROUP, SESSION_FLAG

User = get_user_model()

BRIDGE_MIDDLEWARE = "synology.middleware.SynologyBridgeAuthMiddleware"


class SynologyBridgeAuthTest(TestCase):
    def setUp(self):
        self.client = Client()
        self.tmpdir = tempfile.mkdtemp()
        self.secret_file = os.path.join(self.tmpdir, ".bridge-secret")
        with open(self.secret_file, "w") as f:
            f.write("test-secret\n")

    def tearDown(self):
        if os.path.exists(self.secret_file):
            os.unlink(self.secret_file)
        os.rmdir(self.tmpdir)

    def bridge_request(self, path="/", **headers):
        defaults = {
            "HTTP_X_REQUESTED_WITH": "XMLHttpRequest",
            "HTTP_REMOTE_USER": "nasuser",
            "HTTP_REMOTE_EMAIL": "nasuser@example.com",
            "HTTP_REMOTE_NAME": "Nas User",
            "HTTP_X_BRIDGE_SECRET": "test-secret",
        }
        defaults.update(headers)
        return self.client.get(path, **defaults)

    def enabled(self, **extra):
        options = {
            "SYNOLOGY_BRIDGE_AUTH": True,
            "SYNOLOGY_BRIDGE_SECRET_PATH": self.secret_file,
            "MIDDLEWARE": list(settings.MIDDLEWARE) + [BRIDGE_MIDDLEWARE],
        }
        options.update(extra)
        return override_settings(**options)

    def test_disabled_by_default(self):
        with override_settings(
            MIDDLEWARE=list(settings.MIDDLEWARE) + [BRIDGE_MIDDLEWARE]
        ):
            response = self.bridge_request("/api/base/configuration/")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.wsgi_request.user.is_authenticated)
        self.assertFalse(User.objects.filter(username="nasuser").exists())

    def test_valid_headers_create_and_log_in_user(self):
        with self.enabled():
            response = self.bridge_request("/api/base/configuration/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.wsgi_request.user.is_authenticated)
        user = User.objects.get(username="nasuser")
        self.assertEqual(user.email, "nasuser@example.com")
        self.assertEqual(user.first_name, "Nas")
        self.assertEqual(user.last_name, "User")
        self.assertFalse(user.has_usable_password())
        self.assertFalse(user.is_staff)

    def test_administrators_group_maps_to_staff_and_superuser(self):
        with self.enabled():
            response = self.bridge_request(
                "/api/base/configuration/",
                HTTP_REMOTE_GROUPS=f"users,{ADMIN_GROUP}",
            )
        self.assertTrue(response.wsgi_request.user.is_authenticated)
        user = User.objects.get(username="nasuser")
        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)

    def test_admin_removal_in_dsm_revokes_rights(self):
        with self.enabled():
            self.bridge_request(
                "/api/base/configuration/",
                HTTP_REMOTE_GROUPS=ADMIN_GROUP,
            )
            user = User.objects.get(username="nasuser")
            self.assertTrue(user.is_superuser)
            # The user is removed from the administrators group in DSM.
            response = self.bridge_request("/api/base/configuration/")
        self.assertTrue(response.wsgi_request.user.is_authenticated)
        user.refresh_from_db()
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)

    def test_wrong_secret_is_rejected(self):
        with self.enabled():
            response = self.bridge_request(
                "/api/base/configuration/",
                HTTP_X_BRIDGE_SECRET="wrong",
            )
        self.assertFalse(response.wsgi_request.user.is_authenticated)
        self.assertFalse(User.objects.filter(username="nasuser").exists())

    def test_missing_secret_is_rejected(self):
        with self.enabled():
            response = self.bridge_request(
                "/api/base/configuration/",
                HTTP_X_BRIDGE_SECRET="",
            )
        self.assertFalse(response.wsgi_request.user.is_authenticated)

    def test_missing_secret_file_rejects_all(self):
        os.unlink(self.secret_file)
        with self.enabled():
            response = self.bridge_request("/api/base/configuration/")
        self.assertFalse(response.wsgi_request.user.is_authenticated)

    def test_bridge_session_ends_when_headers_disappear(self):
        with self.enabled():
            first = self.bridge_request("/api/base/configuration/")
        self.assertTrue(first.wsgi_request.user.is_authenticated)
        with self.enabled():
            second = self.client.get("/api/base/configuration/")
        self.assertFalse(second.wsgi_request.user.is_authenticated)

    def test_password_session_survives_missing_headers(self):
        user = User.objects.create_user(
            username="localuser", password="pass", email="l@example.com"
        )
        self.client.force_login(user)
        with self.enabled():
            response = self.client.get("/api/base/configuration/")
        self.assertTrue(response.wsgi_request.user.is_authenticated)
        self.assertEqual(response.wsgi_request.user.username, "localuser")

    def test_auto_create_can_be_disabled(self):
        with self.enabled(SYNOLOGY_BRIDGE_AUTO_CREATE_USERS=False):
            response = self.bridge_request("/api/base/configuration/")
        self.assertFalse(response.wsgi_request.user.is_authenticated)
        self.assertFalse(User.objects.filter(username="nasuser").exists())

    def test_existing_user_is_updated(self):
        user = User.objects.create_user(
            username="nasuser",
            email="old@example.com",
            first_name="Old",
            last_name="Name",
        )
        with self.enabled():
            self.bridge_request("/api/base/configuration/")
        user.refresh_from_db()
        self.assertEqual(user.email, "nasuser@example.com")
        self.assertEqual(user.first_name, "Nas")
        self.assertEqual(user.last_name, "User")

    def test_session_is_flagged_as_bridge_session(self):
        with self.enabled():
            self.bridge_request("/api/base/configuration/")
        self.assertIn(SESSION_FLAG, self.client.session)
