"""Micro-benchmark of the document save path.

Compares the three ways of writing a document:

* the Django ORM path used by the consumer (``asave_content_str``: a raw
  UPDATE built by the ORM),
* a plain ``asave`` with update_fields (the ORM path),
* a cursor level UPDATE (no ORM).

Usage:
    python bench/save_benchmark.py
"""

import json
import os
import sys
import time

sys.path.insert(0, os.getcwd())

from manage import inner

BENCHMARK = """
import json
import time
from asgiref.sync import async_to_sync
from django.db import connection
from document.models import Document

document = Document.objects.order_by("-id").first()
if document is None:
    print("no document")
    raise SystemExit(1)

content = json.dumps(document.content)
diffs = json.dumps(document.diffs)
iterations = 200


def bench(label, function):
    # warm up
    function()
    start = time.perf_counter()
    for _ in range(iterations):
        function()
    elapsed = (time.perf_counter() - start) / iterations
    print(f"{label}: {elapsed * 1000:.3f} ms per save")


def orm_save():
    async_to_sync(document.asave)(update_fields=["content", "version", "diffs", "updated"])


def raw_save():
    async_to_sync(document.asave_content_str)(
        content,
        ["content", "version", "diffs", "updated"],
    )


def cursor_save():
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE document_document SET content = %s, version = %s, "
            "diffs = %s, updated = %s WHERE id = %s",
            [content, document.version, diffs, document.updated, document.pk],
        )


def cursor_save_atomic():
    from django.db import transaction
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE document_document SET content = %s, version = %s, "
                "diffs = %s, updated = %s WHERE id = %s",
                [content, document.version, diffs, document.updated, document.pk],
            )


bench("ORM save (save_content_str)", raw_save)
bench("ORM save (asave)", orm_save)
bench("cursor execute", cursor_save)
bench("cursor execute in atomic()", cursor_save_atomic)

with connection.cursor() as cursor:
    cursor.execute("PRAGMA synchronous")
    print("synchronous:", cursor.fetchone())
    cursor.execute("PRAGMA journal_mode")
    print("journal_mode:", cursor.fetchone())
"""


def main() -> None:
    os.environ.setdefault("PROJECT_PATH", os.getcwd())
    sys.argv = ["manage.py", "shell", "-c", BENCHMARK]
    inner(os.getcwd())


if __name__ == "__main__":
    main()
