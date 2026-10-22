import logging

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class BaseConfig(AppConfig):
    name = "base"
    default_auto_field = "django.db.models.AutoField"

    def ready(self):
        # Log the performance relevant components in use, so that a site can
        # tell which ProseMirror engine and which JSON implementation it
        # runs with. Both have a pure-Python fallback, so they differ between
        # installations (a PyPy installation always uses the fallbacks).
        try:
            from base.json_util import backend_name
            from document.backend import get_backend
        except ImportError:  # pragma: no cover - defensive
            return
        logger.info(
            "Fidus Writer components: ProseMirror engine %s, JSON backend %s",
            get_backend(),
            backend_name(),
        )
