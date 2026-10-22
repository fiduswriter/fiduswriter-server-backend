import json as jsonlib
import logging
import os
import sys
from importlib import import_module
import django

from channels.routing import get_default_application

logger = logging.getLogger(__name__)


# os.environ["DJANGO_ALLOW_ASYNC_UNSAFE"] = "true"

SRC_PATH = os.path.dirname(os.path.realpath(__file__))
os.environ.setdefault("SRC_PATH", SRC_PATH)

sys.path.append(SRC_PATH)
sys_argv = sys.argv
PROJECT_PATH = os.environ.get("PROJECT_PATH", os.getcwd())
# Add PROJECT_PATH to sys.path for consistency with manage.py
# Note: In production, PYTHONPATH should include both /etc/fiduswriter
# (for configuration.py) and /var/lib/fiduswriter (for project files)
if PROJECT_PATH and PROJECT_PATH not in sys.path:
    sys.path.insert(0, PROJECT_PATH)
os.environ.setdefault("PROJECT_PATH", PROJECT_PATH)
SETTINGS_MODULE = "configuration"
mod = False
# There are three levels of settings, each overiding the previous one:
# global_settings.py, settings.py and configuration.py
from django.conf import global_settings as CONFIGURATION  # noqa
from base import settings as SETTINGS  # noqa

SETTINGS_PATHS = [SETTINGS.__file__]
for setting in dir(SETTINGS):
    setting_value = getattr(SETTINGS, setting)
    setattr(CONFIGURATION, setting, setting_value)
try:
    mod = import_module(SETTINGS_MODULE)
except ModuleNotFoundError:
    SETTINGS_MODULE = None
if mod:
    SETTINGS_PATHS.append(mod.__file__)
    for setting in dir(mod):
        if setting.isupper():
            setattr(CONFIGURATION, setting, getattr(mod, setting))
INSTALLED_APPS = CONFIGURATION.BASE_INSTALLED_APPS + list(
    CONFIGURATION.INSTALLED_APPS
)
for app in CONFIGURATION.REMOVED_APPS:
    if app in INSTALLED_APPS:
        INSTALLED_APPS.remove(app)

# Ensure each app is only listed once while preserving order
INSTALLED_APPS = list(dict.fromkeys(INSTALLED_APPS))

# Add appropriate admin app based on whether django_otp is enabled.
# This mirrors the same logic in manage.py.
if "django_otp" in INSTALLED_APPS:
    INSTALLED_APPS.insert(
        INSTALLED_APPS.index("django.contrib.admindocs"),
        "base.twofactor_admin.OTPAdminConfig",
    )
else:
    INSTALLED_APPS.insert(
        INSTALLED_APPS.index("django.contrib.admindocs"),
        "django.contrib.admin",
    )

# Check if axes is enabled (not in REMOVED_APPS)
axes_enabled = "axes" in INSTALLED_APPS

# Merge MIDDLEWARE - conditionally add AXES_BASE_MIDDLEWARE
middleware_list = list(CONFIGURATION.BASE_MIDDLEWARE)
if axes_enabled and hasattr(CONFIGURATION, "AXES_BASE_MIDDLEWARE"):
    middleware_list.extend(CONFIGURATION.AXES_BASE_MIDDLEWARE)
middleware_list.extend(CONFIGURATION.MIDDLEWARE)

# Merge AUTHENTICATION_BACKENDS - conditionally add AXES_AUTHENTICATION_BACKENDS
if axes_enabled:
    if hasattr(CONFIGURATION, "AXES_AUTHENTICATION_BACKENDS") and hasattr(
        CONFIGURATION, "BASE_AUTHENTICATION_BACKENDS"
    ):
        auth_backends = tuple(
            CONFIGURATION.AXES_AUTHENTICATION_BACKENDS
            + CONFIGURATION.BASE_AUTHENTICATION_BACKENDS
        )
    else:
        auth_backends = CONFIGURATION.AUTHENTICATION_BACKENDS
else:
    if hasattr(CONFIGURATION, "BASE_AUTHENTICATION_BACKENDS"):
        auth_backends = tuple(CONFIGURATION.BASE_AUTHENTICATION_BACKENDS)
    else:
        auth_backends = CONFIGURATION.AUTHENTICATION_BACKENDS

from django.conf import settings  # noqa

settings.configure(
    CONFIGURATION,
    SETTINGS_MODULE=SETTINGS_MODULE,
    SETTINGS_PATHS=SETTINGS_PATHS,
    INSTALLED_APPS=INSTALLED_APPS,
    MIDDLEWARE=middleware_list,
    AUTHENTICATION_BACKENDS=auth_backends,
)
django.setup()


def _configure_native_websockets():
    """Hand the configuration to the native websockets route, when the
    Granian extension module provides one.

    The native route replaces the Django Channels consumer for
    /ws/document/<id>/ on deployments that run Granian. It is strictly
    optional: when the module is absent (stock Granian, or another ASGI
    server entirely) this is a no-op, and when the deployment cannot be
    served natively (E2EE enabled, a session engine that is not database
    backed, an Oracle database) the route is not registered and the Python
    consumer keeps serving the path unchanged.
    """
    try:
        native_module = import_module("granian._granian")
    except ImportError:
        return
    configure = getattr(native_module, "configure", None)
    if configure is None:
        return
    try:
        payload = _native_websockets_payload()
        configure(jsonlib.dumps(payload))
    except Exception:
        # The native route must never break the application startup.
        logger.exception("Could not configure the native websockets route.")


def _native_websockets_payload():
    """Build the configuration of the native websockets route from the
    same settings the Python consumer uses."""
    from django.conf import settings
    from django.contrib.auth import get_user_model
    from django.db import DEFAULT_DB_ALIAS, router

    from base.helpers.ws import get_broadcast_secret
    from document.models import (
        AccessRight,
        Document,
        DocumentTemplate,
        ShareToken,
    )

    database = None
    db_alias = DEFAULT_DB_ALIAS
    try:
        db_alias = router.db_for_read(Document) or DEFAULT_DB_ALIAS
    except Exception:
        pass
    db_settings = settings.DATABASES.get(db_alias) or settings.DATABASES[DEFAULT_DB_ALIAS]
    options = {
        key: value
        for key, value in (db_settings.get("OPTIONS") or {}).items()
        if isinstance(value, (str, int, float, bool))
    }
    database = {
        "engine": db_settings.get("ENGINE", ""),
        "name": str(db_settings.get("NAME", "")),
        "user": str(db_settings.get("USER") or ""),
        "password": str(db_settings.get("PASSWORD") or ""),
        "host": str(db_settings.get("HOST") or ""),
        "port": db_settings.get("PORT") or None,
        "options": options,
    }

    session_backend = getattr(settings, "SESSION_ENGINE", "django.contrib.sessions.backends.db")
    session_table = "django_session"
    if session_backend == "django.contrib.sessions.backends.db":
        try:
            from django.contrib.sessions.models import Session

            session_table = Session._meta.db_table
        except Exception:
            pass

    user_content_type_id = None
    try:
        from django.contrib.contenttypes.models import ContentType

        user_content_type_id = ContentType.objects.get_for_model(
            get_user_model()
        ).pk
    except Exception:
        pass

    # The local system message relay, like base.consumers.SystemMessageConsumer
    # builds it from server-known information only.
    relay_url = None
    template = getattr(settings, "INTERNAL_WS_BROADCAST_URL", None)
    port = None
    ports = getattr(settings, "LOCAL_PORTS", None) or getattr(settings, "PORTS", []) or []
    if len(ports) == 1:
        first = ports[0]
        if isinstance(first, dict):
            first = first.get("internal")
        try:
            port = int(first)
        except (TypeError, ValueError, KeyError):
            port = None
    if template:
        relay_url = template.replace("{port}", str(port or "")).replace(
            "{path}", "/ws/base/"
        )
    elif port is not None:
        relay_url = f"ws://127.0.0.1:{port}/ws/base/"

    relay_origin = None
    if relay_url:
        from base.views import _relay_origin_header

        relay_origin = _relay_origin_header(relay_url)

    schema_path = os.environ.get("FIDUSWRITER_SCHEMA_PATH") or os.path.join(
        settings.PROJECT_PATH, "static-libs", "json", "schema.json"
    )
    if not os.path.isfile(schema_path):
        schema_path = None

    fw_document_version = str(Document._meta.get_field("doc_version").default)

    # The native route serves plaintext documents only; with E2EE enabled it
    # stays off entirely and the Python consumer handles everything.
    enabled = (
        getattr(settings, "E2EE_MODE", "disabled") == "disabled"
        and session_backend == "django.contrib.sessions.backends.db"
        and database["engine"] != "django.db.backends.oracle"
        and user_content_type_id is not None
        and schema_path is not None
    )

    return {
        "enabled": enabled,
        "database": database,
        "session_cookie": settings.SESSION_COOKIE_NAME,
        "session_backend": session_backend,
        "session_table": session_table,
        "user_content_type_id": user_content_type_id or 0,
        "document_table": Document._meta.db_table,
        "accessright_table": AccessRight._meta.db_table,
        "sharetoken_table": ShareToken._meta.db_table,
        "documenttemplate_table": DocumentTemplate._meta.db_table,
        "user_table": get_user_model()._meta.db_table,
        "save_interval": int(getattr(settings, "DOC_SAVE_INTERVAL", 30) or 0),
        "rights_recheck_seconds": 5,
        "broadcast_secret": get_broadcast_secret(),
        "secret_keys": [settings.SECRET_KEY]
        + [str(key) for key in getattr(settings, "SECRET_KEY_FALLBACKS", [])],
        "relay_url": relay_url,
        "relay_origin": relay_origin or "http://localhost",
        "schema_path": schema_path,
        "allowed_hosts": [str(host) for host in getattr(settings, "ALLOWED_HOSTS", [])],
        "fw_document_version": fw_document_version,
    }


_configure_native_websockets()

application = get_default_application()
