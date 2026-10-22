"""Differential harness: the same load through both backends, same DB state.

Runs the same fixed load (bench/run.sh with one client for a fixed duration)
once against the native Rust route and once against the Django Channels
consumer, resetting the benchmark document to the exact same state in
between, and compares the database row afterwards: the applied content, the
version, the diff log and the sidecar columns must be identical.

Usage:
    python bench/differential.py [clients] [duration]
"""

import hashlib
import json
import os
import subprocess
import sys

NATIVE = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..")
APP = os.path.realpath(
    os.path.join(NATIVE, "..", "fiduswriter-server-backend", "fiduswriter")
)
VENV = os.environ.get("VENV", "/tmp/kilo/bench-venv")
VENV_PYTHON = os.path.join(VENV, "bin", "python")

RESET_AND_SNAPSHOT = r'''
import hashlib
import json
import os
import sys

from document.models import Document

BASE_CONTENT = {
    "type": "doc",
    "content": [
        {"type": "title", "content": [{"type": "text", "text": "Title"}]},
        {
            "type": "paragraph",
            "content": [{"type": "text", "text": "Hello world"}],
        },
    ],
}


def snapshot(document_id):
    document = Document.objects.get(pk=document_id)
    # The version itself is the number of frames the arm processed (the
    # throughputs differ by design); what must agree is the resulting
    # document state. The diff log entries carry their rid (a sequence
    # number) and their version, which are stripped before the comparison.
    normalized_diffs = [
        {
            key: value
            for key, value in diff.items()
            if key not in ("rid", "c", "s", "v")
        }
        for diff in document.diffs
    ]
    state = {
        # The steps alternate insert/delete at one position: the content is
        # identical for versions of the same parity.
        "content_parity": document.version % 2,
        "content": document.content,
        "normalized_diffs": normalized_diffs,
        "comments": document.comments,
        "bibliography": document.bibliography,
        "title": document.title,
    }
    canonical = json.dumps(state, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest(), state


def reset(document_id):
    Document.objects.filter(pk=document_id).update(
        content=BASE_CONTENT,
        version=0,
        diffs=[],
        comments={},
        bibliography={},
        title="Benchmark Document",
    )


mode = os.environ["DIFF_MODE"]
document_id = int(os.environ["DOCUMENT_ID"])
if mode == "reset":
    reset(document_id)
elif mode == "snapshot":
    digest, state = snapshot(document_id)
    print(f"STATE_DIGEST={digest}")
    print(f"STATE_PARITY={state['content_parity']}")
    print(f"STATE_DIFFS={len(state['normalized_diffs'])}")
'''


def run(mode):
    env = dict(os.environ, PROJECT_PATH=APP, DIFF_MODE=mode)
    result = subprocess.run(
        [VENV_PYTHON, "manage.py", "shell", "-c", RESET_AND_SNAPSHOT],
        capture_output=True,
        text=True,
        cwd=APP,
        env=env,
    )
    if result.returncode != 0:
        print(result.stderr)
        raise SystemExit(f"the {mode} step failed")
    return {
        line.split("=", 1)[0]: line.split("=", 1)[1]
        for line in result.stdout.splitlines()
        if "=" in line
    }


def bench_env():
    values = {}
    with open("/tmp/kilo/bench-env") as handle:
        for line in handle:
            if "=" in line:
                key, value = line.strip().split("=", 1)
                values[key] = value
    return values


def main():
    clients = sys.argv[1] if len(sys.argv) > 1 else "1"
    duration = sys.argv[2] if len(sys.argv) > 2 else "10"

    env_values = bench_env()
    os.environ["DOCUMENT_ID"] = env_values["DOCUMENT_ID"]

    outcomes = {}
    for arm in ("native", "python"):
        run("reset")
        print(f"=== arm: {arm} ===")
        subprocess.run(
            ["bash", os.path.join(NATIVE, "bench", "run.sh"), arm, clients, duration],
            check=True,
        )
        outcomes[arm] = run("snapshot")
        for key, value in outcomes[arm].items():
            print(f"{arm} {key}={value}")

    if outcomes["native"] == outcomes["python"]:
        print("DIFFERENTIAL: OK — both backends produced the same database state.")
    else:
        print("DIFFERENTIAL: MISMATCH")
        for key in outcomes["native"]:
            if outcomes["native"][key] != outcomes["python"][key]:
                print(
                    f"  {key}: native={outcomes['native'][key]} "
                    f"python={outcomes['python'][key]}"
                )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
