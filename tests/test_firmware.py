"""Static checks on the Arduino sketches against docs/PROTOCOL.md (no toolchain needed)."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FW = ROOT / "firmware"
STATIC_FW = ROOT / "app" / "static" / "firmware"
PROTOCOL = (ROOT / "docs" / "PROTOCOL.md").read_text()
ROLES = ("sensor", "hub", "body")


def sketch(role: str) -> str:
    return (FW / f"weathering_{role}" / f"weathering_{role}.ino").read_text()


def header() -> str:
    return (FW / "weathering_hub" / "wx.h").read_text()


def fw_version() -> str:
    m = re.search(r'#define FW_VERSION "(\d+\.\d+\.\d+)"', header())
    assert m, "FW_VERSION missing from wx.h"
    return m.group(1)


def test_shared_header_is_identical_in_every_sketch():
    # Arduino only sees headers inside the sketch folder, so there are three.
    copies = {role: (FW / f"weathering_{role}" / "wx.h").read_text() for role in ROLES}
    assert len(set(copies.values())) == 1, "firmware/*/wx.h differ: keep all three in sync"


def test_fw_code_matches_version():
    major, minor, _ = (int(x) for x in fw_version().split("."))
    code = int(re.search(r"#define WX_FW_CODE (0x[0-9A-Fa-f]+)", header()).group(1), 16)
    assert code == (major << 8 | minor)


def test_version_matches_every_manifest():
    v = fw_version()
    for role in ROLES:
        manifest = json.loads((STATIC_FW / role / "manifest.json").read_text())
        assert manifest["version"] == v, f"{role}: rebuild with tools/build_firmware.sh"


def test_manifests_point_at_real_images():
    for role in ROLES:
        d = STATIC_FW / role
        manifest = json.loads((d / "manifest.json").read_text())
        parts = manifest["builds"][0]["parts"]
        assert manifest["builds"][0]["chipFamily"] == "ESP32"
        assert [p["offset"] for p in parts] == [0x1000, 0x8000, 0xE000, 0x10000]
        assert [p["path"] for p in parts] == ["bootloader.bin", "partitions.bin", "boot_app0.bin",
                                              f"weathering_{role}.bin"]
        for p in parts:
            f = d / p["path"]
            assert f.is_file() and f.stat().st_size > 0, f
            if p["path"] in ("bootloader.bin", f"weathering_{role}.bin"):
                assert f.read_bytes()[:1] == b"\xe9", f"{f} is not an ESP32 image"


def test_radio_contract_matches_header():
    h = header()
    m = re.search(r"#define WX_MAGIC (0x[0-9A-Fa-f]+)", PROTOCOL)
    assert m and f"#define WX_MAGIC {m.group(1)}" in h
    # every packet type with the same number
    enum = re.search(r"enum \{ (WX_HELLO=.*?)\};", PROTOCOL, re.S).group(1)
    for name, num in re.findall(r"(WX_\w+)=(\d+)", enum):
        assert re.search(rf"\b{name} = {num}\b", h), name
    # the struct fields, in order
    doc_fields = re.findall(r"^\s+(\w+)\s+(\w+(?:\[\d+\])?);", PROTOCOL.split("typedef struct")[1].split("} WxPacket;")[0], re.M)
    h_struct = h.split("typedef struct __attribute__((packed)) {")[1].split("} WxPacket;")[0]
    h_fields = re.findall(r"^\s+(\w+)\s+(\w+(?:\[[\w]+\])?);", h_struct, re.M)
    h_fields = [(t, n.replace("[WX_TEXT_LEN]", "[40]")) for t, n in h_fields]
    assert h_fields == doc_fields
    assert "#define WX_TEXT_LEN 40" in h
    # roles 1 sensor, 2 hub, 3 body
    assert "WX_ROLE_SENSOR = 1, WX_ROLE_HUB = 2, WX_ROLE_BODY = 3" in h
    assert "#define WX_HELLO_MS 3000" in h and "#define WX_LOST_MS  30000" in h
    # channel order co2,t,rh,lux,db
    assert '{"co2", "t", "rh", "lux", "db"}' in h


def test_boot_line_matches_protocol():
    doc = re.search(r"^FW weathering_<role> <version> mac <AA:BB:CC:DD:EE:FF> group <g>$", PROTOCOL, re.M)
    assert doc, "boot line changed in PROTOCOL.md"
    for role in ROLES:
        assert f'"FW weathering_{role} %s mac %s group %u\\n", FW_VERSION' in sketch(role), role


def test_info_and_common_commands():
    assert "INFO <role> fw <version> mac <mac> group <g>" in PROTOCOL
    for role in ROLES:
        src = sketch(role)
        assert f'"INFO {role} fw %s mac %s group %u' in src, role
        for cmd in ('"PING"', '"INFO"', '"SET"', '"PONG"', '"OK SET"', '"group"', "LOG "):
            assert cmd in src, (role, cmd)
        assert 'prefs.putUChar("group"' in src and "wx_accept(data, len, group)" in src
        assert "WX_HELLO" in src and "WX_HELLO_MS" in src


def test_hub_commands_and_replies_match_protocol():
    hub = sketch("hub")
    hub_section = PROTOCOL.split("## Hub board")[1].split("## Body board")[0]
    to_hub = hub_section.split("host → hub:")[1].split("hub → host:")[0]
    cmds = re.findall(r"^\s*([A-Z]{3,})\b", to_hub, re.M)
    assert {"TIME", "POSE", "RELAX", "TEST", "READ", "CFG", "NODES"} <= set(cmds)
    for cmd in cmds:
        assert f'"{cmd}"' in hub, f"hub doesn't handle {cmd}"
    for reply in (
        '"OK POSE %u\\n"', '"ACK body %u\\n"', '"NAK body %u\\n"', '"NODE %s %s fw %u.%u rssi %d\\n"',
        '"LOST %s\\n"', '"BODY %.3f %.3f %.3f %.3f moving=%d homed=%d found=%u\\n"', '"OK %s\\n"',
    ):
        assert reply in hub, reply
    assert "#define POSE_RETRIES   3" in hub and "#define POSE_RETRY_MS  300" in hub
    assert "OK POSE <seq>" in hub_section and "ACK body <seq>  |  NAK body <seq>" in hub_section
    assert "NODE <role> <mac> fw <version> rssi <dBm>" in hub_section
    assert "BODY <p1> … <p4> moving=<0|1> homed=<0|1> found=<mask>" in hub_section
    assert "POSE <seq> <p1> <p2> <p3> <p4> <glide_s>" in hub_section


def test_reading_line_matches_protocol():
    assert "R <unix> <seq> co2=<v> t=<v> rh=<v> lux=<v> db=<v> [sim=<list>] [old]" in PROTOCOL
    h = header()
    assert '"R %lu %u"' in h
    assert '{" co2=%.0f", " t=%.2f", " rh=%.1f", " lux=%.1f", " db=%.1f"}' in h
    assert '" sim=" : ","' in h and '" old"' in h
    assert "#define WX_FLAG_OLD      0x01" in h and "#define WX_FLAG_SIM(i)   (0x02 << (i))" in h
    sensor = sketch("sensor")
    assert '"READ"' in sensor and "wx_format_reading" in sensor and "wx_format_reading" in sketch("hub")


def test_sensor_matches_protocol():
    s = sketch("sensor")
    assert "#define SCD41_ADDR     0x62" in s and "i2c_present(0x23)" in s and "i2c_present(0x5C)" in s
    assert "#define SCD30_ADDR     0x61" in s and "SCD30** (0x61" in PROTOCOL
    # channels: default co2,t,rh; the others neither sent nor simulated
    assert "#define CHANNELS_DEFAULT 0x07" in s and "`channels` (default `co2,t,rh`)" in PROTOCOL
    assert "if (!(channels & (1 << i))) continue;" in s
    for key, default in (("interval", "300"), ("sda", "21"), ("scl", "22"), ("mic_pin", "34")):
        assert f'"{key}"' in s
        assert re.search(rf'prefs\.get\w+\("{key}", {default}\)', s), key
    assert "wx_parse_long(v, 10, 3600, &iv)" in s
    assert '{"auto", "all", "none"}' in s
    assert "interval=%u channels=%s sensors=%s sim=%s" in s
    # backlog: >= 1 day at 300 s, oldest first, dropped only after the ACK
    backlog = int(re.search(r"#define BACKLOG\s+(\d+)", s).group(1))
    assert backlog >= 24 * 3600 // 300
    assert "on_ack(p->seq)" in s and "WX_FLAG_OLD" not in s.split("static void on_ack")[1].split("}")[0]
    assert "case WX_TIME:" in s and "case WX_READ:" in s


def test_body_matches_protocol():
    b = sketch("body")
    body = PROTOCOL.split("## Body board")[1].split("## Radio")[0]
    # wiring and bus as in Florian's proven TTGO sketch
    assert "#define DXL_RX         33" in b and "#define DXL_TX         32" in b and "#define DXL_BAUD       57600" in b
    assert "GPIO 32" in body and "57600" in body and "extended position mode" in body
    assert "crc = (crc & 0x8000) ? (crc << 1) ^ 0x8005" in b and "buf[i + 7] == 0x55" in b
    # calibration keys documented and handled
    for key in ("jog", "slack", "closed", "ids", "setid", "speed", "group"):
        assert f"`{key}=" in body, key
        assert f'strcmp(k, "{key}") == 0' in b, key
    for cmd in ('"POSE"', '"TEST"', '"RELAX"', '"SCAN"', "case WX_POSE:", "case WX_TEST:", "case WX_RELAX:",
                "case WX_CONFIG:", "WX_BODYSTATE", "WX_ACK"):
        assert cmd in b, cmd
    # safety: goals clamped to the calibrated travel, never "power-up = slack"
    assert "pull = constrain(pull, PULL_LO, PULL_HI);" in b
    assert "#define PULL_LO        -0.02f" in b and "#define PULL_HI        1.02f" in b
    assert "zero − 2 % … zero + 102 % of travel" in body
    assert "if (!all_homed())" in b.split("static bool start_pose")[1].split("}")[0]
    assert "#define HOME_TOL       256" in b and "within 1/16 turn" in body
    assert "startPos" not in b                                    # Florian's power-up zero is gone
    assert "pose=%.3f,%.3f,%.3f,%.3f" in b and '" m%d=%u,%ld"' in b
    assert "#define STATE_EVERY_MS 2000" in b
    assert "WX_FLAG_HOMED" in b and "#define WX_FLAG_HOMED    0x02" in header()
