#!/bin/bash
# Install the Fidus Writer requirements on PyPy.
#
# Three packages need special care on PyPy:
#
# * lxml has no PyPy 3.12 wheel and does not compile on PyPy 3.12 (it uses
#   the removed PyString_FromFormat API). It is only needed by the HTML
#   import filters of the pure-Python ProseMirror package, not by the
#   collaboration path, so it is skipped.
# * prosemirror (the pure-Python engine) declares lxml as a dependency, so
#   it is installed without its dependencies.
# * autobahn pins cbor2 to a version whose Rust extension does not build on
#   PyPy 3.12 (pyo3-ffi does not support it yet), so an older, CFFI based
#   cbor2 is installed instead and autobahn is installed without its
#   dependencies.
set -u

VENV="${VENV:-/tmp/kilo/pypy-venv}"
REQUIREMENTS=/home/johannes/src/fiduswriter/fiduswriter-server-backend/fiduswriter/requirements.txt

"$VENV/bin/pip" install -q "cbor2==5.6.5"
"$VENV/bin/pip" install -q cffi cryptography hyperlink txaio ujson msgpack
grep -v -e '^autobahn' -e '^prosemirror==' "$REQUIREMENTS" > /tmp/kilo/requirements-pypy.txt
"$VENV/bin/pip" install -q -r /tmp/kilo/requirements-pypy.txt
"$VENV/bin/pip" install -q --no-deps prosemirror==0.6.1
"$VENV/bin/pip" install -q --no-deps autobahn==26.7.1

"$VENV/bin/python" - <<'EOF'
import sys
print("python:", sys.version.split()[0], sys.implementation.name)
import django, channels
print("django:", django.__version__, "channels:", channels.__version__)
from document import prosemirror
print("prosemirror engine:", "ok")
EOF
