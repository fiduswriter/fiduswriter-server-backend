"""Probe the native websockets route over HTTP/2 (RFC 8441).

The extended CONNECT method is used: the handshake answers 200 (not 101),
and the websocket frames travel inside an HTTP/2 stream. The session cookie
of the benchmark user is read from /tmp/kilo/bench-env (like bench/run.sh).

Usage (with a server running on 8099):
    python bench/h2_probe.py /ws/document/3/ '{"type":"subscribe","c":1,"s":1,"connection":0,"v":0}'
"""

import json
import os
import socket
import struct
import sys

from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, ResponseReceived, StreamEnded

OPCODE_TEXT = 0x1


def bench_cookie() -> str:
    """The session cookie the benchmark user authenticates with."""
    try:
        with open("/tmp/kilo/bench-env") as handle:
            for line in handle:
                if line.startswith("COOKIE="):
                    return line.strip()[len("COOKIE="):]
    except OSError:
        pass
    return ""


def client_frame(payload: bytes, opcode: int = OPCODE_TEXT) -> bytes:
    """A masked client frame (RFC 6455)."""
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
    """Extract the complete (unmasked) server frames."""
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


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "/ws/document/3/"
    payload = (
        sys.argv[2]
        if len(sys.argv) > 2
        else '{"type": "subscribe", "c": 1, "s": 1, "connection": 0, "v": 0}'
    )
    host, port = "127.0.0.1", 8099

    connection = H2Connection(
        config=H2Configuration(client_side=True, header_encoding=None)
    )
    sock = socket.create_connection((host, port))
    connection.initiate_connection()
    sock.sendall(connection.data_to_send())

    stream_id = connection.get_next_available_stream_id()
    headers = [
        (":method", "CONNECT"),
        (":protocol", "websocket"),
        (":scheme", "http"),
        (":path", path),
        (":authority", f"{host}:{port}"),
        ("sec-websocket-version", "13"),
        ("origin", "http://localhost"),
    ]
    if cookie := bench_cookie():
        headers.append(("cookie", cookie))
    connection.send_headers(stream_id, headers)
    sock.sendall(connection.data_to_send())

    buffer = b""
    status = None
    while status is None:
        data = sock.recv(65536)
        if not data:
            raise SystemExit("connection closed during the handshake")
        for event in connection.receive_data(data):
            out = connection.data_to_send()
            if out:
                sock.sendall(out)
            if isinstance(event, ResponseReceived):
                status = int(dict(event.headers)[b":status"])
            elif isinstance(event, DataReceived):
                # The first websocket frames can arrive together with the
                # response headers: keep them.
                buffer += event.data
    print("handshake status:", status)

    connection.send_data(stream_id, client_frame(payload.encode()), end_stream=False)
    sock.sendall(connection.data_to_send())

    sock.settimeout(5)
    for _ in range(4):
        frames, buffer = server_frames(buffer)
        if frames:
            print("frame:", frames[0].decode(errors="replace")[:200])
            continue
        try:
            data = sock.recv(65536)
        except TimeoutError:
            print("no more frames")
            return
        if not data:
            print("connection closed")
            return
        for event in connection.receive_data(data):
            out = connection.data_to_send()
            if out:
                sock.sendall(out)
            if isinstance(event, DataReceived):
                buffer += event.data
            elif isinstance(event, StreamEnded):
                print("stream ended")
                return

    sock.close()


if __name__ == "__main__":
    main()
