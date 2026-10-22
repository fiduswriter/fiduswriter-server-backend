"""Exercise the full native websocket protocol over HTTP/2 (RFC 8441).

Resets the benchmark document to version 0, then over one HTTP/2 stream:
welcome, subscribe, session_info, confirm_version, one diff, confirm_diff,
plus the participant list. Requires a server started with `--http 2`.

Usage (with a server running on 8099):
    python bench/h2_full.py
"""

import asyncio
import json
import os
import socket
import struct
import subprocess
import sys

from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, ResponseReceived, StreamEnded

NATIVE = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..")
APP = os.path.realpath(
    os.path.join(NATIVE, "..", "fiduswriter-server-backend", "fiduswriter")
)
VENV_PYTHON = os.environ.get("VENV", "/tmp/kilo/bench-venv") + "/bin/python"

OPCODE_TEXT = 0x1

DIFF = {
    "type": "diff",
    "v": 0,
    "rid": "h2-1",
    "ds": [
        {
            "stepType": "replace",
            "from": 4,
            "to": 4,
            "slice": {"content": [{"type": "text", "text": "H2"}]},
        }
    ],
}

RESET = """
from document.models import Document
Document.objects.filter(pk=int(os.environ["DOCUMENT_ID"])).update(
    content={"type": "doc", "content": [
        {"type": "title", "content": [{"type": "text", "text": "Title"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "Hello world"}]},
    ]},
    version=0,
    diffs=[],
    title="Benchmark Document",
)
"""


def bench_env():
    values = {}
    with open("/tmp/kilo/bench-env") as file:
        for line in file:
            if "=" in line:
                key, value = line.strip().split("=", 1)
                values[key] = value
    return values


def client_frame(payload: bytes, opcode: int = OPCODE_TEXT) -> bytes:
    mask = os.urandom(4)
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    length = len(payload)
    header = bytes([0x80 | opcode])
    if length < 126:
        header += bytes([0x80 | length])
    elif length < 65536:
        header += bytes([0x80 | 126]) + struct.pack(">H", length)
    else:
        header += bytes([0x80 | 127]) + struct.pack(">Q", length)
    return header + mask + masked


def server_frames(buffer: bytes):
    frames = []
    while len(buffer) >= 2:
        length = buffer[1] & 0x7F
        offset = 2
        if length == 126:
            if len(buffer) < 4:
                break
            length = struct.unpack(">H", buffer[2:4])[0]
            offset = 4
        elif length == 127:
            if len(buffer) < 10:
                break
            length = struct.unpack(">Q", buffer[2:10])[0]
            offset = 10
        if len(buffer) < offset + length:
            break
        frames.append(buffer[offset : offset + length])
        buffer = buffer[offset + length :]
    return frames, buffer


class H2Ws:
    """One websocket connection inside an HTTP/2 stream."""

    def __init__(self, host, port, path, cookie):
        self.host, self.port, self.path = host, port, self.path = host, port, path
        self.cookie = cookie
        self.connection = H2Connection(
            config=H2Configuration(client_side=True, header_encoding=None)
        )
        self.sock = socket.create_connection((host, port))
        self.connection.initiate_connection()
        self.sock.sendall(self.connection.data_to_send())
        self.buffer = b""
        self.incoming = []

    def handshake(self):
        stream_id = self.connection.get_next_available_stream_id()
        self.stream_id = stream_id
        headers = [
            (b":method", b"CONNECT"),
            (b":protocol", b"websocket"),
            (b":scheme", b"http"),
            (b":path", self.path.encode()),
            (b":authority", f"{self.host}:{self.port}".encode()),
            (b"sec-websocket-version", b"13"),
            (b"origin", b"http://localhost"),
            (b"cookie", self.cookie.encode()),
        ]
        self.connection.send_headers(stream_id, headers)
        self.sock.sendall(self.connection.data_to_send())
        status = None
        while status is None:
            data = self.sock.recv(65536)
            if not data:
                raise SystemExit("connection closed during the handshake")
            for event in self.connection.receive_data(data):
                out = self.connection.data_to_send()
                if out:
                    self.sock.sendall(out)
                if isinstance(event, ResponseReceived):
                    status = int(dict(event.headers)[b":status"])
                elif isinstance(event, DataReceived):
                    # The first websocket frames can arrive together with
                    # the response headers: keep them.
                    self.buffer += event.data
        return status

    def send(self, payload: dict):
        frame = client_frame(json.dumps(payload).encode())
        self.connection.send_data(self.stream_id, frame, end_stream=False)
        self.sock.sendall(self.connection.data_to_send())

    def receive(self, timeout=5):
        """The next complete websocket frame (parsed JSON)."""
        while True:
            if self.incoming:
                return self.incoming.pop(0)
            frames, self.buffer = server_frames(self.buffer)
            self.incoming.extend(
                json.loads(frame) for frame in frames
            )
            if self.incoming:
                return self.incoming.pop(0)
            self.sock.settimeout(timeout)
            try:
                data = self.sock.recv(65536)
            except (TimeoutError, socket.timeout):
                return None
            if not data:
                return None
            ended = False
            for event in self.connection.receive_data(data):
                out = self.connection.data_to_send()
                if out:
                    self.sock.sendall(out)
                if isinstance(event, DataReceived):
                    self.buffer += event.data
                elif isinstance(event, StreamEnded):
                    ended = True
            if ended and not self.buffer:
                return None

    def close(self):
        self.sock.close()


def main():
    env_values = bench_env()
    document_id = env_values["DOCUMENT_ID"]
    cookie = env_values["COOKIE"]
    env = dict(os.environ, PROJECT_PATH=APP, DOCUMENT_ID=document_id)
    subprocess.run(
        [VENV_PYTHON, "manage.py", "shell", "-c", RESET],
        check=True,
        cwd=APP,
        env=env,
    )

    ws = H2Ws("127.0.0.1", 8099, f"/ws/document/{document_id}/", cookie)
    status = ws.handshake()
    print("handshake status:", status)
    assert status == 200

    seen = []
    seen.append(ws.receive())
    print("frame:", seen[-1])

    client_counter = 0
    server_seen = seen[-1]["s"] if seen[-1] else 0

    def counted(message):
        nonlocal client_counter, server_seen
        client_counter += 1
        message["c"] = client_counter
        message["s"] = server_seen
        return message

    ws.send(counted({"type": "subscribe", "connection": 0, "v": 0}))
    while True:
        frame = ws.receive()
        if frame is None:
            break
        print("frame:", frame)
        seen.append(frame)
        # Every counted frame advances the server counter the client must
        # echo, not only confirm_version.
        server_seen = max(server_seen, frame.get("s", 0))
        if frame["type"] == "connections":
            break

    expected = {"subscribed", "session_info", "confirm_version", "connections"}
    got = {frame["type"] for frame in seen if frame}
    missing = expected - got
    assert not missing, f"missing frames: {missing}"

    ws.send(counted(DIFF))
    frame = ws.receive()
    print("frame:", frame)
    assert frame and frame["type"] == "confirm_diff", f"unexpected: {frame}"
    frame = ws.receive()
    print("frame:", frame)

    ws.close()
    print("H2 FULL PROTOCOL: OK")


if __name__ == "__main__":
    main()
