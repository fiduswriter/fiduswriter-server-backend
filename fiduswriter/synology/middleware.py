import hmac
import logging

from django.conf import settings
from django.contrib.auth import get_user_model, login, logout
from django.utils.deprecation import MiddlewareMixin

logger = logging.getLogger(__name__)

# Name of the session flag marking logins performed by this middleware, so
# that sessions it created can be invalidated when the identity headers
# disappear, without touching sessions from regular username/password logins.
SESSION_FLAG = "synology_bridge_auth"

# The bridge (https://github.com/moritzfl/synology-docker-bridge) forwards
# the signed-in DSM user to the app with these headers when the app config
# sets "identityHeaders": true.
HEADER_USER = "HTTP_REMOTE_USER"
HEADER_EMAIL = "HTTP_REMOTE_EMAIL"
HEADER_NAME = "HTTP_REMOTE_NAME"
HEADER_GROUPS = "HTTP_REMOTE_GROUPS"
HEADER_SECRET = "HTTP_X_BRIDGE_SECRET"

ADMIN_GROUP = "administrators"


def bridge_auth_enabled():
    return bool(getattr(settings, "SYNOLOGY_BRIDGE_AUTH", False))


def secret_path():
    return getattr(
        settings,
        "SYNOLOGY_BRIDGE_SECRET_PATH",
        "/data/.bridge-secret",
    )


def read_bridge_secret():
    """Read the shared secret the bridge keeps in the app data folder.

    The app must only trust the identity headers when the request carries
    this secret — otherwise any local process could pose as any user by
    sending the headers itself.
    """
    try:
        with open(secret_path(), "rb") as f:
            return f.read().strip()
    except OSError:
        return None


def _groups(request):
    raw = request.headers.get("Remote-Groups") or ""
    return [group.strip() for group in raw.split(",") if group.strip()]


class SynologyBridgeAuthMiddleware(MiddlewareMixin):
    """Authenticate requests coming through the Synology Docker bridge.

    When SYNOLOGY_BRIDGE_AUTH is enabled and the request carries the shared
    bridge secret plus a Remote-User header, the corresponding user is
    logged in — created on first sight with the email, name and group
    information from the DSM account. Membership of the DSM
    "administrators" group maps to Django staff/superuser status and is
    re-checked on every request, so removing a user from the DSM
    administrators group revokes the rights on the next request.

    Requests without identity headers end sessions this middleware created
    (the user signed out of DSM or lost the app privilege), but leave
    username/password sessions alone.
    """

    def process_request(self, request):
        if not bridge_auth_enabled():
            return None
        username = request.META.get(HEADER_USER)
        if not username:
            if request.session.get(SESSION_FLAG):
                # The DSM session ended or the app privilege was revoked.
                logout(request)
            return None
        if not self._secret_valid(request):
            logger.warning(
                "Ignoring Synology identity headers for %r: "
                "missing or incorrect X-Bridge-Secret.",
                username,
            )
            return None
        user = self._provision_user(request, username)
        if user is None:
            return None
        if (
            request.user.is_authenticated
            and request.user.pk == user.pk
            and request.session.get(SESSION_FLAG)
        ):
            # Already logged in as this user through the bridge.
            return None
        user.backend = "django.contrib.auth.backends.ModelBackend"
        login(request, user)
        request.session[SESSION_FLAG] = True
        request.session.set_expiry(0)
        return None

    def _secret_valid(self, request):
        provided = request.META.get(HEADER_SECRET)
        if not provided:
            return False
        expected = read_bridge_secret()
        if not expected:
            return False
        return hmac.compare_digest(
            provided.encode(), expected.decode().encode()
        )

    def _provision_user(self, request, username):
        User = get_user_model()
        email = request.META.get(HEADER_EMAIL, "")
        full_name = request.META.get(HEADER_NAME, "")
        is_admin = ADMIN_GROUP in _groups(request)
        try:
            user = User.objects.get(username=username)
        except User.DoesNotExist:
            if not getattr(settings, "SYNOLOGY_BRIDGE_AUTO_CREATE_USERS", True):
                return None
            user = User(username=username, email=email)
            user.set_unusable_password()
        needs_save = user.pk is None
        if user.email != email:
            user.email = email
            needs_save = True
        name_parts = full_name.split(None, 1)
        first_name = name_parts[0] if name_parts else ""
        last_name = name_parts[1] if len(name_parts) > 1 else ""
        if user.first_name != first_name:
            user.first_name = first_name
            needs_save = True
        if user.last_name != last_name:
            user.last_name = last_name
            needs_save = True
        if user.is_staff != is_admin:
            user.is_staff = is_admin
            needs_save = True
        if user.is_superuser != is_admin:
            user.is_superuser = is_admin
            needs_save = True
        if needs_save:
            user.save()
        return user
