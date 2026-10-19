from base.json_util import json
from django.conf import settings
from asgiref.sync import iscoroutinefunction, markcoroutinefunction


class ConditionalMessageMiddleware:
    """Strips the messages cookie from responses for non-admin URLs.

    ``django.contrib.messages.middleware.MessageMiddleware`` still runs
    (the admin app requires it), but this middleware removes the
    ``messages`` cookie from every response whose path does not start with
    ``/admin/``, avoiding unnecessary overhead on all other page loads.
    """

    async_capable = True
    sync_capable = True

    def __init__(self, get_response):
        self.get_response = get_response
        if iscoroutinefunction(self.get_response):
            markcoroutinefunction(self)

    def __call__(self, request):
        if iscoroutinefunction(self.get_response):
            return self.__acall__(request)
        response = self.get_response(request)
        if not request.path.startswith("/admin/"):
            response.cookies.pop("messages", None)
        return response

    async def __acall__(self, request):
        response = await self.get_response(request)
        if not request.path.startswith("/admin/"):
            response.cookies.pop("messages", None)
        return response


class JsonToPostMiddleware:
    async_capable = True
    sync_capable = True

    def __init__(self, get_response):
        self.get_response = get_response
        if iscoroutinefunction(self.get_response):
            markcoroutinefunction(self)

    def __call__(self, request):
        if iscoroutinefunction(self.get_response):
            return self.__acall__(request)
        self._process_request(request)
        return self.get_response(request)

    async def __acall__(self, request):
        self._process_request(request)
        return await self.get_response(request)

    def process_exception(self, request, exception):
        # AJAX views index into request.JSON directly (request.JSON["id"],
        # value["key"], int(value) ...). A payload that is missing keys,
        # has the wrong shape, or carries unparseable scalars therefore
        # surfaces as KeyError/TypeError/ValueError — a
        # client error that should not produce a 500 (which would also
        # take down the request pipeline for websocket-adjacent paths and
        # flood error reporting). Convert it to a 400 for AJAX views and
        # let everything else propagate.
        if not isinstance(
            exception, (KeyError, TypeError, AttributeError, ValueError)
        ):
            return None
        if request.path.startswith("/api/") or request.META.get(
            "HTTP_X_REQUESTED_WITH"
        ):
            import logging

            logging.getLogger("django.request").warning(
                "Malformed JSON request shape at %s: %s: %s",
                request.path,
                type(exception).__name__,
                exception,
            )
            from django.http import JsonResponse

            return JsonResponse({"error": "Invalid request data."}, status=400)
        return None

    def _process_request(self, request):
        # Always initialise request.JSON so that views can rely on it
        # existing regardless of content-type.  It will be overwritten below
        # with the parsed body when the request actually carries JSON.
        request.JSON = {}
        content_type = request.META.get("CONTENT_TYPE", "")

        # Only intercept JSON payloads for write methods
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            if "application/json" in content_type:
                try:
                    if request.body:
                        data = json.loads(request.body)
                    else:
                        data = {}
                    if not isinstance(data, dict):
                        # Views index into request.JSON as a dict. Arrays,
                        # scalars and strings are malformed request shapes —
                        # treat them like an empty payload.
                        data = {}
                    request.JSON = data
                    csrftoken = data.get("csrfmiddlewaretoken", None)
                    if csrftoken:
                        request.META[settings.CSRF_HEADER_NAME] = csrftoken
                except json.JSONDecodeError:
                    pass  # Let downstream handle invalid JSON gracefully
            elif (
                request.method == "POST"
                and "multipart/form-data" in content_type
            ):
                # Hybrid requests: JSON payload embedded in multipart form
                # data (used when files need to be uploaded alongside JSON).
                json_data = request.POST.get("json", None)
                if json_data:
                    try:
                        data = json.loads(json_data)
                        if not isinstance(data, dict):
                            data = {}
                        request.JSON = data
                        csrftoken = data.get("csrfmiddlewaretoken", None)
                        if csrftoken:
                            request.META[settings.CSRF_HEADER_NAME] = csrftoken
                    except json.JSONDecodeError:
                        pass  # Let downstream handle invalid JSON gracefully
