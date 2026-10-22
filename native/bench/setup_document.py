"""Prepare the document used by the websocket benchmarks.

Creates a user, a document with a fixed content (the same one the native
route starts from) and a session for the user, so that the load generator
can authenticate with a plain cookie.

Usage:
    python bench/setup_document.py
"""

import os
import sys

sys.path.insert(0, os.getcwd())

from manage import inner

SETUP = """
from django.contrib.auth import get_user_model
from django.contrib.sessions.backends.db import SessionStore
from document.models import Document, DocumentTemplate

username = "benchmark"
password = "benchmark"

user_model = get_user_model()
user, created = user_model.objects.get_or_create(
    username=username, defaults={"email": f"{username}@example.org"}
)
if created:
    user.set_password(password)
    user.save()

template, _ = DocumentTemplate.objects.get_or_create(
    title="Benchmark Template", defaults={"content": {}}
)

content = {
    "type": "doc",
    "content": [
        {"type": "title", "content": [{"type": "text", "text": "Title"}]},
        {
            "type": "paragraph",
            "content": [{"type": "text", "text": "Hello world"}],
        },
    ],
}

document, _ = Document.objects.get_or_create(
    owner=user,
    title="Benchmark Document",
    defaults={
        "template": template,
        "content": content,
        "version": 0,
    },
)
document.content = content
document.version = 0
document.save()

session = SessionStore()
session["_auth_user_id"] = str(user.pk)
session["_auth_user_backend"] = "django.contrib.auth.backends.ModelBackend"
session["_auth_user_hash"] = user.get_session_auth_hash()
session.save()

print(f"DOCUMENT_ID={document.pk}")
print(f"COOKIE=sessionid={session.session_key}")
"""


def main() -> None:
    os.environ.setdefault("PROJECT_PATH", os.getcwd())
    sys.argv = ["manage.py", "shell", "-c", SETUP]
    inner(os.getcwd())


if __name__ == "__main__":
    main()
