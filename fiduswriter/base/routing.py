from importlib import import_module

from asgiref.sync import sync_to_async
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from channels.security.websocket import AllowedHostsOriginValidator
from django.urls import path
from django.core.asgi import get_asgi_application
from django.conf import settings

websocket_routes = []

for app in settings.INSTALLED_APPS:
    app_name = app.rsplit(".", 1).pop()
    # add ws consumers
    try:
        ws_urls = import_module("%s.ws_urls" % app)
    except ImportError:
        pass
    else:
        websocket_routes += [
            path(f"ws/{app_name}/", URLRouter(ws_urls.urlpatterns)),
        ]


async def lifespan_handler(scope, receive, send):
    """
    ASGI Lifespan handler for server startup/shutdown lifecycle events.

    On shutdown, saves all open documents and removes all Presence records
    before confirming completion so that Granian waits until the flush is
    done before terminating the process.
    """
    while True:
        message = await receive()
        if message["type"] == "lifespan.startup":
            await send({"type": "lifespan.startup.complete"})
        elif message["type"] == "lifespan.shutdown":
            from document.consumers import WebsocketConsumer

            await sync_to_async(WebsocketConsumer.save_all_docs)()

            # The native websockets route keeps its sessions in Rust: flush
            # them like the Python consumer does. A no-op when the module
            # is absent (stock Granian, or no native module installed).
            try:
                from granian import _granian as native_ws

                native_flush = getattr(native_ws, "flush", None)
            except ImportError:
                native_flush = None
            if native_flush is not None:
                await sync_to_async(native_flush)()

            from base.consumers import remove_all_presences

            await sync_to_async(remove_all_presences)()

            await send({"type": "lifespan.shutdown.complete"})
            return


application = ProtocolTypeRouter(
    {
        "http": get_asgi_application(),
        "lifespan": lifespan_handler,
        "websocket": AllowedHostsOriginValidator(
            AuthMiddlewareStack(URLRouter(websocket_routes))
        ),
    }
)
