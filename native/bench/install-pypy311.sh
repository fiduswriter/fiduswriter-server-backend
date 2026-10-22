#!/bin/bash
# Set up the PyPy benchmark environment.
#
# PyPy 3.12 is the current release, but the Fidus Writer stack cannot be
# installed on it:
#
# * lxml (needed by the pure-Python ProseMirror engine) has no PyPy 3.12
#   wheel and does not compile (it uses the removed PyString_FromFormat).
# * autobahn pins cbor2 to a version whose Rust extension does not build
#   (pyo3-ffi does not support PyPy 3.12).
#
# PyPy 3.11 is used instead, with Django 5.2 (the last version supporting
# Python 3.11). Everything else is the same stack.
set -u

PYPY=/home/johannes/.pyenv/versions/pypy3.11-7.3.22/bin/pypy3
VENV=/tmp/kilo/pypy311-venv
REQUIREMENTS=/home/johannes/src/fiduswriter/fiduswriter-server-backend/fiduswriter/requirements.txt

"$PYPY" -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip

# Django 5.2 instead of 6.0, and autobahn without its dependencies.
grep -v -e '^autobahn' -e '^prosemirror' "$REQUIREMENTS" \
    | sed 's/^Django==6.0.8/Django==5.2.7/' > /tmp/kilo/requirements-pypy311.txt
"$VENV/bin/pip" install -q -r /tmp/kilo/requirements-pypy311.txt
"$VENV/bin/pip" install -q --no-deps prosemirror==0.6.1
"$VENV/bin/pip" install -q "cbor2==5.6.5"
"$VENV/bin/pip" install -q cffi cryptography hyperlink txaio ujson msgpack
"$VENV/bin/pip" install -q --no-deps autobahn==26.7.1

# The same Granian as the other arms (the local build with the native route
# support), built for PyPy.
"$VENV/bin/pip" install -q maturin
cd /home/johannes/src/granian
PATH="$VENV/bin:$PATH" PYO3_PYTHON="$VENV/bin/python" \
    "$VENV/bin/pip" install -q --no-build-isolation --force-reinstall . 2>&1 | tail -2

"$VENV/bin/python" - <<'EOF'
import sys
print("python:", sys.version.split()[0], sys.implementation.name)
import django, channels
print("django:", django.__version__, "channels:", channels.__version__)
import lxml.etree
print("lxml: ok")
EOF
