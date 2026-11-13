"""Minimal OSC 1.0 messages over UDP (standard library only).

Enough for the app to talk to SuperCollider: int, float and string
arguments. `decode` exists for the tests.
"""
from __future__ import annotations

import socket
import struct


def _pad(b: bytes) -> bytes:
    return b + b"\0" * (4 - len(b) % 4)


def _str(s: str) -> bytes:
    return _pad(s.encode("utf-8"))


def encode(address: str, *args) -> bytes:
    tags, data = ",", b""
    for a in args:
        if isinstance(a, bool):
            a = int(a)
        if isinstance(a, int):
            tags += "i"
            data += struct.pack(">i", a)
        elif isinstance(a, float):
            tags += "f"
            data += struct.pack(">f", a)
        else:
            tags += "s"
            data += _str(str(a))
    return _str(address) + _str(tags) + data


def decode(packet: bytes) -> tuple[str, list]:
    def read_str(i):
        j = packet.index(b"\0", i)
        s = packet[i:j].decode()
        return s, (j // 4 + 1) * 4
    address, i = read_str(0)
    tags, i = read_str(i)
    args = []
    for t in tags[1:]:
        if t == "i":
            args.append(struct.unpack(">i", packet[i:i + 4])[0]); i += 4
        elif t == "f":
            args.append(struct.unpack(">f", packet[i:i + 4])[0]); i += 4
        elif t == "s":
            s, i = read_str(i)
            args.append(s)
    return address, args


class OscOut:
    def __init__(self, host: str = "127.0.0.1", port: int = 57120):
        self.addr = (host, port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(self, address: str, *args) -> None:
        try:
            self.sock.sendto(encode(address, *args), self.addr)
        except OSError:
            pass                                   # sound is never allowed to break the show
