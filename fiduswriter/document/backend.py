"""Resolution of the ProseMirror engine used by the document consumer.

Fidus Writer can run the ProseMirror step engine in two ways:

``rust``
    The `prosemirror-rs <https://pypi.org/project/prosemirror-rs/>`_ extension
    keeps the document tree in Rust memory. Steps are applied and the document
    is serialised in Rust, so Python never builds a full object tree.

``python``
    The pure-Python `prosemirror <https://pypi.org/project/prosemirror/>`_
    package (a port of ProseMirror) does the same work in Python.

The engine is selected with the ``PROSEMIRROR_BACKEND`` setting:

``auto`` (default)
    Use the Rust engine when ``prosemirror-rs`` is installed, the pure-Python
    engine otherwise. This is what makes the PyPy installation profile work:
    ``prosemirror-rs`` publishes no PyPy wheels, so a PyPy install falls back
    to the pure-Python engine without any configuration.

``rust`` / ``python``
    Force one engine. ``rust`` falls back to ``python`` (with a warning) when
    the extension is not installed, so a missing optional wheel can never take
    the server down.

The ``PROSEMIRROR_BACKEND`` environment variable takes precedence over the
setting of the same name. That makes it possible to run a one-off command (or
a CI job) with a specific engine without editing the site configuration.

This module is the single place where that decision is made; the consumer and
the document store both resolve the engine through it.
"""

import logging
import os

from django.conf import settings

logger = logging.getLogger(__name__)

RUST = "rust"
PYTHON = "python"
AUTO = "auto"

# Cached result of the prosemirror-rs availability check.
_rust_available: bool | None = None


def rust_available() -> bool:
    """Return True if the ``prosemirror-rs`` extension can be imported."""
    global _rust_available
    if _rust_available is None:
        try:
            import prosemirror_rs  # noqa: F401
        except Exception:  # pragma: no cover - depends on the installation
            _rust_available = False
        else:
            _rust_available = True
    return _rust_available


def get_backend() -> str:
    """Return the ProseMirror engine to use: ``"rust"`` or ``"python"``."""
    configured = (
        os.environ.get("PROSEMIRROR_BACKEND")
        or getattr(settings, "PROSEMIRROR_BACKEND", AUTO)
        or AUTO
    )
    configured = str(configured).strip().lower()
    if configured == RUST:
        if not rust_available():
            logger.warning(
                "PROSEMIRROR_BACKEND is set to 'rust', but the prosemirror-rs "
                "package is not available. Falling back to the pure-Python "
                "engine."
            )
            return PYTHON
        return RUST
    if configured == PYTHON:
        return PYTHON
    # "auto" (or an unknown value): use the Rust engine when it is available.
    return RUST if rust_available() else PYTHON
