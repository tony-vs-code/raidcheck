import asyncio
from datetime import datetime
import io
import json
from pathlib import Path
import sqlite3
from subprocess import CalledProcessError
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.error import URLError
from urllib.parse import urlsplit

import aiohttp
import discord

import api
import main


SAMPLE_DETAILS = """/dev/md128:
        Version : 1.2
        Creation Time : Thu Jan  1 00:00:00 1970
        Raid Level : raid1
        Array Size : 10000 (9.31 GiB)
        Used Dev Size : 10000
        Raid Devices : 2
        Total Devices : 2
        Persistence : Superblock is persistent

        Update Time : Wed Oct 28 00:00:00 2026
        State : clean
        Active Devices : 2
        Working Devices : 2
        Failed Devices : 0
        Spare Devices : 0
        Check Status : 100%
        Events : 42

        Layout : near=2
        Chunk Size : 64K
        Consistency Policy : resync

        Name : test:0
        UUID : abcdef
        Events : 42

        Number   Major   Minor   RaidDevice State
           0       8       0        0      active sync   /dev/sda
           1       8      16        1      active sync   /dev/sdb
"""

SAMPLE_DUF = """Filesystem      Size  Used Avail Use%
/dev/media      100G   60G   40G   60%
"""

SAMPLE_DUF_TABLE = """╭─────────┬─────────┬─────────┬────────╮
│    SIZE │    USED │   AVAIL │  USAGE │
├─────────┼─────────┼─────────┼────────┤
│  14.55T │   8.12T │   6.43T │  55.8% │
╰─────────┴─────────┴─────────┴────────╯"""


class AsgiResponse:
    """Minimal response wrapper for in-process ASGI requests."""

    def __init__(
        self,
        status_code: int,
        headers: dict[str, str],
        raw_headers: list[tuple[str, str]],
        body: bytes,
    ) -> None:
        self.status_code = status_code
        self.headers = headers
        self.raw_headers = raw_headers
        self.content = body
        self.text = body.decode("utf-8", errors="replace")

    def json(self):
        return json.loads(self.text)


def asgi_request(
    app,
    method: str,
    path: str,
    *,
    json_body: dict | None = None,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
) -> AsgiResponse:
    """Execute an HTTP request directly against an ASGI app without external HTTP client deps."""
    parsed = urlsplit(path)
    body_bytes = b""
    req_headers: list[tuple[bytes, bytes]] = [(b"host", b"testserver")]

    if json_body is not None:
        body_bytes = json.dumps(json_body).encode("utf-8")
        req_headers.append((b"content-type", b"application/json"))
        req_headers.append((b"content-length", str(len(body_bytes)).encode("ascii")))

    if headers:
        for k, v in headers.items():
            req_headers.append((k.lower().encode("latin1"), v.encode("latin1")))

    if cookies:
        cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
        req_headers.append((b"cookie", cookie_str.encode("latin1")))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method.upper(),
        "scheme": "http",
        "path": parsed.path or "/",
        "raw_path": (parsed.path or "/").encode("ascii"),
        "query_string": parsed.query.encode("ascii"),
        "headers": req_headers,
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
    }

    messages = []
    request_sent = False

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body_bytes, "more_body": False}
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    asyncio.run(app(scope, receive, send))

    status_code = 500
    resp_headers: dict[str, str] = {}
    raw_headers: list[tuple[str, str]] = []
    body_parts: list[bytes] = []

    for message in messages:
        if message["type"] == "http.response.start":
            status_code = message["status"]
            for k, v in message.get("headers", []):
                key_str = k.decode("latin1").lower()
                val_str = v.decode("latin1")
                resp_headers[key_str] = val_str
                raw_headers.append((key_str, val_str))
        elif message["type"] == "http.response.body":
            body_parts.append(message.get("body", b""))

    return AsgiResponse(status_code, resp_headers, raw_headers, b"".join(body_parts))


def asgi_get(
    app,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
) -> AsgiResponse:
    return asgi_request(app, "GET", path, headers=headers, cookies=cookies)


def asgi_post(
    app,
    path: str,
    *,
    json_body: dict | None = None,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
) -> AsgiResponse:
    return asgi_request(
        app, "POST", path, json_body=json_body, headers=headers, cookies=cookies
    )


class AsgiWebSocketResult:
    """Result container for in-process ASGI WebSocket session."""

    def __init__(
        self,
        accepted: bool,
        close_code: int | None,
        messages: list[dict],
    ) -> None:
        self.accepted = accepted
        self.close_code = close_code
        self.messages = messages


def asgi_ws(
    app,
    path: str,
    *,
    client_messages: list[dict] | None = None,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
) -> AsgiWebSocketResult:
    """Execute a WebSocket session directly against an ASGI app."""
    parsed = urlsplit(path)
    req_headers: list[tuple[bytes, bytes]] = [(b"host", b"testserver")]
    if headers:
        for k, v in headers.items():
            req_headers.append((k.lower().encode("latin1"), v.encode("latin1")))
    if cookies:
        cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
        req_headers.append((b"cookie", cookie_str.encode("latin1")))

    scope = {
        "type": "websocket",
        "asgi": {"version": "3.0"},
        "scheme": "ws",
        "path": parsed.path or "/api/ws",
        "raw_path": (parsed.path or "/api/ws").encode("ascii"),
        "query_string": parsed.query.encode("ascii"),
        "headers": req_headers,
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "subprotocols": [],
    }

    inbound_queue: list[dict] = [{"type": "websocket.connect"}]
    for msg in client_messages or []:
        inbound_queue.append({"type": "websocket.receive", "text": json.dumps(msg)})
    inbound_queue.append({"type": "websocket.disconnect", "code": 1000})

    accepted = False
    close_code: int | None = None
    sent_messages: list[dict] = []

    async def receive():
        if inbound_queue:
            return inbound_queue.pop(0)
        return {"type": "websocket.disconnect", "code": 1000}

    async def send(message):
        nonlocal accepted, close_code
        msg_type = message.get("type")
        if msg_type == "websocket.accept":
            accepted = True
        elif msg_type == "websocket.send":
            text = message.get("text")
            if text is not None:
                sent_messages.append(json.loads(text))
        elif msg_type == "websocket.close":
            close_code = message.get("code", 1000)

    asyncio.run(app(scope, receive, send))
    return AsgiWebSocketResult(accepted, close_code, sent_messages)


class RaidFormattingTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_formatting.sqlite3"
        self.db_patcher = patch.object(main, "RAID_STATE_DB", self.db_path)
        self.db_patcher.start()

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_format_raid_summary_uses_clean_card_layout(self):
        text = main.format_raid_summary("clean", SAMPLE_DETAILS, SAMPLE_DUF)
        self.assertNotIn("╭", text)
        self.assertNotIn("│", text)
        self.assertIn("Status: clean", text)
        self.assertIn("Array Size: 9.31 GiB", text)
        self.assertIn("Devices: 2 active, 2 working, 0 failed, 0 spare", text)
        self.assertIn("- sda: active sync", text)
        self.assertIn("- sdb: active sync", text)

    def test_format_raid_summary_exception_fallback(self):
        with patch.object(
            main, "_extract_raid_summary_data", side_effect=RuntimeError("parse fail")
        ):
            text = main.format_raid_summary("degraded", SAMPLE_DETAILS, SAMPLE_DUF)
        self.assertEqual(text, "RAID Array Degraded\nError parsing details")

    def test_extract_raid_summary_data_parses_duf_table_and_fallback(self):
        data = main._extract_raid_summary_data("clean", SAMPLE_DETAILS, SAMPLE_DUF_TABLE)
        self.assertEqual(data["raid_device"], "/dev/md128")
        self.assertEqual(data["status"], "clean")
        self.assertEqual(data["raid_level"], "raid1")
        self.assertEqual(data["array_size"], "9.31 GiB")
        self.assertEqual(data["storage_info"], "8.12T/14.55T (55.8%) | 6.43T free")
        self.assertEqual(len(data["devices"]), 2)

        empty_data = main._extract_raid_summary_data("unknown", "", "")
        self.assertEqual(empty_data["raid_level"], "unknown")
        self.assertEqual(empty_data["storage_info"], "N/A")
        self.assertEqual(empty_data["devices"], [])

        summary_no_devices = main.format_raid_summary("unknown", "", "")
        self.assertIn("- No device information available", summary_no_devices)

    def test_extract_raid_summary_data_parses_nvme_vda_and_raid_device(self):
        nvme_details = """/dev/md0:
        Version : 1.2
        Raid Level : raid10
        Array Size : 20000 (19.07 GiB)
        State : active
        Active Devices : 2
        Working Devices : 2
        Failed Devices : 0
        Spare Devices : 0

        Number   Major   Minor   RaidDevice State
           0     259       0        0      active sync set-A   /dev/nvme0n1p1
           1     252       1        1      active sync set-B   /dev/vda1
"""
        data = main._extract_raid_summary_data("active", nvme_details, SAMPLE_DUF_TABLE)
        self.assertEqual(data["raid_device"], "/dev/md0")
        self.assertEqual(data["raid_level"], "raid10")
        self.assertEqual(
            data["devices"],
            [
                {"device": "nvme0n1p1", "state": "active sync set-A"},
                {"device": "vda1", "state": "active sync set-B"},
            ],
        )

    def test_discover_and_resolve_raid_devices(self):
        fake_mdstat = """Personalities : [raid1] [raid6] [raid5] [raid4]
md127 : active raid5 sdc1[0] sdd1[1] sde1[2]
      19532609536 blocks super 1.2 level 5, 512k chunk, algorithm 2 [3/3] [UUU]

md0 : active raid1 nvme0n1p1[0] nvme1n1p1[1]
      999872 blocks super 1.2 [2/2] [UU]

unused devices: <none>
"""
        mdstat_file = Path(self.temp_dir.name) / "mdstat"
        mdstat_file.write_text(fake_mdstat, encoding="utf-8")

        orig_path = main.Path

        def fake_path_factory(p):
            if p == "/proc/mdstat":
                return mdstat_file
            return orig_path(p)

        with (
            patch.object(main, "Path", side_effect=fake_path_factory),
            patch.object(
                main.glob,
                "glob",
                side_effect=lambda pattern: (
                    ["/dev/md0", "/dev/md0p1"] if pattern == "/dev/md[0-9]*" else []
                ),
            ),
        ):
            devices = main.discover_raid_devices()
            self.assertEqual(devices, ["/dev/md0", "/dev/md127"])

            # 'auto' resolves to first discovered device (/dev/md0)
            self.assertEqual(main.resolve_raid_device("auto"), "/dev/md0")

            # Non-existent default '/dev/md128' falls back to discovered '/dev/md0'
            self.assertEqual(main.resolve_raid_device("/dev/md128"), "/dev/md0")

        # When no devices are discovered on disk or in /proc/mdstat, returns None
        with patch.object(main, "discover_raid_devices", return_value=[]):
            self.assertIsNone(main.resolve_raid_device("auto"))
            self.assertIsNone(main.resolve_raid_device(""))
            self.assertIsNone(main.resolve_raid_device("none"))
            self.assertIsNone(main.resolve_raid_device("/dev/md_nonexistent"))

    def test_build_raid_embed_is_compatible_across_statuses(self):
        embed = main.build_raid_embed("clean", SAMPLE_DETAILS, SAMPLE_DUF)
        self.assertEqual(embed.title, "RAID 1 | CLEAN")
        self.assertEqual(embed.color.value, 0x2ECC71)
        self.assertNotIn("╭", embed.description)
        self.assertIn("Status", embed.description)

        degraded_embed = main.build_raid_embed("degraded", SAMPLE_DETAILS, SAMPLE_DUF)
        self.assertEqual(degraded_embed.title, "RAID 1 | DEGRADED")
        self.assertEqual(degraded_embed.color.value, 0xF39C12)

        failed_embed = main.build_raid_embed("failed", SAMPLE_DETAILS, SAMPLE_DUF)
        self.assertEqual(failed_embed.title, "RAID 1 | FAILED")
        self.assertEqual(failed_embed.color.value, 0xE74C3C)

        unknown_embed = main.build_raid_embed("mystery", "", "")
        self.assertEqual(unknown_embed.title, "RAID UNKNOWN | MYSTERY")
        self.assertEqual(unknown_embed.color.value, 0x95A5A6)

    def test_should_send_weekly_summary_respects_due_date_and_empty_state(self):
        self.assertTrue(main.should_send_weekly_summary(None, now=150.0))
        future_state = (100.0, 200.0, "clean")
        self.assertFalse(main.should_send_weekly_summary(future_state, now=150.0))
        self.assertTrue(
            main.should_send_weekly_summary(future_state, force=True, now=150.0)
        )
        self.assertTrue(main.should_send_weekly_summary(future_state, now=200.0))
        self.assertTrue(main.should_send_weekly_summary(future_state, now=250.0))

    def test_enforce_discord_message_limit_preserves_short_and_truncates_large_messages(self):
        short_message = "RAID array is healthy."
        self.assertEqual(main.enforce_discord_message_limit(short_message), short_message)

        exact_limit_message = "B" * main.MAX_DISCORD_MESSAGE_LENGTH
        self.assertEqual(
            main.enforce_discord_message_limit(exact_limit_message), exact_limit_message
        )

        long_message = "A" * 5000
        truncated = main.enforce_discord_message_limit(long_message)
        self.assertLessEqual(len(truncated), main.MAX_DISCORD_MESSAGE_LENGTH)
        self.assertTrue(truncated.endswith("...\n[truncated]"))

    def test_check_raid_status_all_state_branches_and_errors(self):
        # When resolve_raid_device() returns None, check_raid_status returns ('none', 'No RAID array detected') without calling mdadm
        with (
            patch.object(main, "resolve_raid_device", return_value=None),
            patch("main.check_output") as mock_check_output,
        ):
            status, details = main.check_raid_status()
            self.assertEqual(status, "none")
            self.assertEqual(details, "No RAID array detected")
            mock_check_output.assert_not_called()

        with patch.object(main, "resolve_raid_device", return_value="/dev/md128"):
            for expected_state in [
                "clean",
                "active",
                "degraded",
                "recovering",
                "resyncing",
                "failed",
            ]:
                raw_output = f"/dev/md128:\n        State : {expected_state}\n".encode()
                with patch("main.check_output", return_value=raw_output):
                    status, details = main.check_raid_status()
                    self.assertEqual(status, expected_state)
                    self.assertIn(f"State : {expected_state}", details)

            with patch(
                "main.check_output", return_value=b"/dev/md128:\n        State : weird\n"
            ):
                status, details = main.check_raid_status()
                self.assertEqual(status, "unknown")
                self.assertIn("State : weird", details)

            with patch(
                "main.check_output",
                side_effect=CalledProcessError(1, ["mdadm"], output=b"mdadm failed"),
            ):
                status, details = main.check_raid_status()
                self.assertEqual(status, "error")
                self.assertEqual(details, "mdadm failed")

            with patch(
                "main.check_output",
                side_effect=FileNotFoundError("No such file or directory: 'mdadm'"),
            ):
                status, details = main.check_raid_status()
                self.assertEqual(status, "error")
                self.assertIn("mdadm", details)

    def test_get_duf_output_success_and_error_branches(self):
        with patch("main.check_output", return_value=b"  duf table output  \n"):
            self.assertEqual(main.get_duf_output(), "duf table output")

        with patch(
            "main.check_output",
            side_effect=CalledProcessError(1, ["duf"], output=b"duf error"),
        ):
            duf_out = main.get_duf_output()
            self.assertIn("Error getting disk usage: duf error", duf_out)

        with patch(
            "main.check_output",
            side_effect=FileNotFoundError("No such file or directory: 'duf'"),
        ):
            duf_out = main.get_duf_output()
            self.assertIn("Error getting disk usage:", duf_out)
            self.assertIn("duf", duf_out)


class DiscordAndRaidCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_raid_check.sqlite3"
        self.db_patcher = patch.object(main, "RAID_STATE_DB", self.db_path)
        self.db_patcher.start()
        main.update_app_settings(
            {
                "discord_enabled": "true",
                "discord_token": "test_token",
                "channel_id": "12345",
            }
        )

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_send_message_handles_string_embed_missing_channel_and_exception(self):
        mock_channel = MagicMock()
        mock_channel.send = AsyncMock()

        with (
            patch.object(main, "CHANNEL_ID", "12345"),
            patch.object(main.client, "get_channel", return_value=mock_channel),
        ):
            result_str = asyncio.run(main.send_message("hello world"))
            self.assertTrue(result_str)
            mock_channel.send.assert_awaited_once_with("hello world")

            mock_channel.send.reset_mock()
            embed = discord.Embed(title="Test Embed")
            result_embed = asyncio.run(main.send_message(embed))
            self.assertTrue(result_embed)
            mock_channel.send.assert_awaited_once_with(embed=embed)

        with (
            patch.object(main, "CHANNEL_ID", "99999"),
            patch.object(main.client, "get_channel", return_value=None),
        ):
            result_missing = asyncio.run(main.send_message("no channel"))
            self.assertFalse(result_missing)

        mock_failing_channel = MagicMock()
        mock_failing_channel.send = AsyncMock(side_effect=RuntimeError("network down"))
        with (
            patch.object(main, "CHANNEL_ID", "12345"),
            patch.object(main.client, "get_channel", return_value=mock_failing_channel),
        ):
            result_error = asyncio.run(main.send_message("boom"))
            self.assertFalse(result_error)

    def test_run_raid_check_clean_sent_vs_throttled_and_degraded_alert(self):
        with (
            patch.object(
                main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF),
            patch.object(main, "send_message", new=AsyncMock(return_value=True)) as mock_send,
        ):
            asyncio.run(main.run_raid_check(force=False))
            self.assertEqual(mock_send.await_count, 1)
            self.assertIsNotNone(main.get_weekly_notification_state())

            mock_send.reset_mock()
            asyncio.run(main.run_raid_check(force=False))
            self.assertEqual(mock_send.await_count, 0)

            asyncio.run(main.run_raid_check(force=True))
            self.assertEqual(mock_send.await_count, 1)

        with (
            patch.object(
                main, "check_raid_status", return_value=("degraded", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF),
            patch.object(main, "send_message", new=AsyncMock(return_value=True)) as mock_send,
        ):
            asyncio.run(main.run_raid_check(force=False))
            self.assertEqual(mock_send.await_count, 1)
            history = main.get_notification_history(5)
            self.assertEqual(history[0][0], "degraded")
            self.assertEqual(history[0][2], 0)

        # When check_raid_status returns ('none', 'No RAID array detected'), no Discord alert is sent
        with (
            patch.object(
                main,
                "check_raid_status",
                return_value=("none", "No RAID array detected"),
            ),
            patch.object(main, "send_message", new=AsyncMock(return_value=True)) as mock_send,
        ):
            asyncio.run(main.run_raid_check(force=True))
            self.assertEqual(mock_send.await_count, 0)

    def test_run_raid_check_handles_sqlite_errors_gracefully(self):
        with (
            patch.object(
                main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF),
            patch.object(
                main,
                "get_weekly_notification_state",
                side_effect=sqlite3.Error("read failure"),
            ),
            patch.object(main, "send_message", new=AsyncMock(return_value=True)) as mock_send,
        ):
            asyncio.run(main.run_raid_check(force=False))
            self.assertEqual(mock_send.await_count, 0)

        with (
            patch.object(
                main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF),
            patch.object(
                main, "record_notification", side_effect=sqlite3.Error("write failure")
            ),
            patch.object(main, "send_message", new=AsyncMock(return_value=True)) as mock_send,
        ):
            asyncio.run(main.run_raid_check(force=True))
            self.assertEqual(mock_send.await_count, 1)

        with (
            patch.object(
                main, "check_raid_status", return_value=("failed", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF),
            patch.object(
                main, "record_notification", side_effect=sqlite3.Error("write failure")
            ),
            patch.object(main, "send_message", new=AsyncMock(return_value=True)) as mock_send,
        ):
            asyncio.run(main.run_raid_check(force=False))
            self.assertEqual(mock_send.await_count, 1)

    def test_discord_enabled_setting_controls_sending_and_logging(self):
        # 1. When discord_enabled is explicitly 'false', send_message skips sending and logs
        main.update_app_settings({"discord_enabled": "false", "channel_id": "12345"})
        mock_channel = MagicMock()
        mock_channel.send = AsyncMock()
        with (
            patch.object(main.client, "get_channel", return_value=mock_channel),
            self.assertLogs(level="INFO") as log_ctx,
        ):
            sent = asyncio.run(main.send_message("test message"))
            self.assertFalse(sent)
            mock_channel.send.assert_not_called()
            self.assertTrue(
                any("Discord notifications are disabled" in entry for entry in log_ctx.output)
            )

        # 2. When discord_enabled is 'false', run_raid_check skips checks/sending
        with (
            patch.object(main, "send_message", new=AsyncMock(return_value=True)) as mock_send,
            patch.object(main, "check_raid_status") as mock_raid_status,
            self.assertLogs(level="INFO") as log_ctx_raid,
        ):
            asyncio.run(main.run_raid_check(force=True))
            mock_raid_status.assert_not_called()
            self.assertEqual(mock_send.await_count, 0)
            self.assertTrue(
                any("Discord notifications are disabled" in entry for entry in log_ctx_raid.output)
            )

        # 3. When discord_enabled is set to 'true', sending works
        main.update_app_settings({"discord_enabled": "true"})
        with patch.object(main.client, "get_channel", return_value=mock_channel):
            sent_enabled = asyncio.run(main.send_message("enabled message"))
            self.assertTrue(sent_enabled)
            mock_channel.send.assert_awaited_once_with("enabled message")

    def test_send_test_notification_success_and_failure_branches(self):
        # Disabled in settings
        main.update_app_settings(
            {"discord_enabled": "false", "discord_token": "test_token", "channel_id": "12345"}
        )
        success, msg = asyncio.run(main.send_test_notification())
        self.assertFalse(success)
        self.assertIn("disabled", msg.lower())

        # Enabled but channel ID missing
        with (
            patch.object(main, "CHANNEL_ID", ""),
            patch.object(
                main,
                "get_app_settings",
                return_value={
                    "discord_enabled": "true",
                    "discord_token": "test_token",
                    "channel_id": "",
                },
            ),
        ):
            success, msg = asyncio.run(main.send_test_notification())
            self.assertFalse(success)
            self.assertIn("channel", msg.lower())

        # Enabled and channel ID configured, send_message succeeds
        main.update_app_settings(
            {"discord_enabled": "true", "discord_token": "test_token", "channel_id": "99999"}
        )
        with patch.object(main, "send_message", new=AsyncMock(return_value=True)) as mock_send:
            success, msg = asyncio.run(main.send_test_notification())
            self.assertTrue(success)
            self.assertEqual(mock_send.await_count, 1)
            self.assertIn("success", msg.lower())

            history = main.get_notification_history(5)
            self.assertEqual(history[0][0], "test")
            self.assertEqual(history[0][2], 0)

        # Enabled, but send_message fails
        with patch.object(main, "send_message", new=AsyncMock(return_value=False)) as mock_send_fail:
            success, msg = asyncio.run(main.send_test_notification())
            self.assertFalse(success)
            self.assertEqual(mock_send_fail.await_count, 1)
            self.assertIn("failed", msg.lower())

    def test_discord_rest_fallback_and_detailed_error_reporting(self):
        # 1. Missing token
        main.update_app_settings({"discord_enabled": "true", "channel_id": "123456", "discord_token": ""})
        with (
            patch.object(main, "CHANNEL_ID", "123456"),
            patch.object(main, "config", side_effect=lambda k, default="": ""),
            patch.object(main.client, "is_ready", return_value=False),
            patch.object(main.client, "get_channel", return_value=None),
        ):
            success, msg = asyncio.run(main.send_test_notification())
            self.assertFalse(success)
            self.assertIn("token", msg.lower())

        # 2. REST 200 success
        main.update_app_settings({"discord_enabled": "true", "channel_id": "123456", "discord_token": "valid_token"})
        mock_resp_200 = MagicMock()
        mock_resp_200.status = 200
        mock_resp_200.text = AsyncMock(return_value='{"id": "msg123"}')
        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_resp_200), __aexit__=AsyncMock()))

        with (
            patch.object(main.client, "is_ready", return_value=False),
            patch.object(main.client, "get_channel", return_value=None),
            patch("aiohttp.ClientSession", return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_session), __aexit__=AsyncMock())),
        ):
            # Test string message
            sent_str = asyncio.run(main.send_message("rest text message"))
            self.assertTrue(sent_str)
            mock_session.post.assert_called_once()
            call_kwargs = mock_session.post.call_args.kwargs
            self.assertEqual(call_kwargs["json"], {"content": "rest text message"})
            self.assertEqual(call_kwargs["headers"]["Authorization"], "Bot valid_token")

            # Test send_test_notification with REST 200
            mock_session.post.reset_mock()
            success_test, msg_test = asyncio.run(main.send_test_notification())
            self.assertTrue(success_test)
            self.assertIn("success", msg_test.lower())

        # 3. REST 401 Unauthorized
        mock_resp_401 = MagicMock()
        mock_resp_401.status = 401
        mock_resp_401.text = AsyncMock(return_value='{"message": "401: Unauthorized", "code": 0}')
        mock_session_401 = MagicMock()
        mock_session_401.post = MagicMock(return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_resp_401), __aexit__=AsyncMock()))

        with (
            patch.object(main.client, "is_ready", return_value=False),
            patch.object(main.client, "get_channel", return_value=None),
            patch("aiohttp.ClientSession", return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_session_401), __aexit__=AsyncMock())),
        ):
            success_401, msg_401 = asyncio.run(main.send_test_notification())
            self.assertFalse(success_401)
            self.assertIn("401", msg_401)
            self.assertIn("unauthorized", msg_401.lower())

        # 4. REST 404 Unknown Channel
        mock_resp_404 = MagicMock()
        mock_resp_404.status = 404
        mock_resp_404.text = AsyncMock(return_value='{"message": "Unknown Channel", "code": 10003}')
        mock_session_404 = MagicMock()
        mock_session_404.post = MagicMock(return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_resp_404), __aexit__=AsyncMock()))

        with (
            patch.object(main.client, "is_ready", return_value=False),
            patch.object(main.client, "get_channel", return_value=None),
            patch("aiohttp.ClientSession", return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_session_404), __aexit__=AsyncMock())),
        ):
            success_404, msg_404 = asyncio.run(main.send_test_notification())
            self.assertFalse(success_404)
            self.assertIn("404", msg_404)
            self.assertIn("unknown channel", msg_404.lower())

        # 5. REST 403 Forbidden
        mock_resp_403 = MagicMock()
        mock_resp_403.status = 403
        mock_resp_403.text = AsyncMock(return_value='{"message": "Missing Permissions", "code": 50013}')
        mock_session_403 = MagicMock()
        mock_session_403.post = MagicMock(return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_resp_403), __aexit__=AsyncMock()))

        with (
            patch.object(main.client, "is_ready", return_value=False),
            patch.object(main.client, "get_channel", return_value=None),
            patch("aiohttp.ClientSession", return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_session_403), __aexit__=AsyncMock())),
        ):
            success_403, msg_403 = asyncio.run(main.send_test_notification())
            self.assertFalse(success_403)
            self.assertIn("403", msg_403)
            self.assertIn("forbidden", msg_403.lower())
            self.assertIn("Missing Permissions", msg_403)

        # 6. REST network exception handling and descriptive message
        mock_session_exc = MagicMock()
        mock_session_exc.post = MagicMock(side_effect=aiohttp.ClientError("connection refused"))

        with (
            patch.object(main.client, "is_ready", return_value=False),
            patch.object(main.client, "get_channel", return_value=None),
            patch("aiohttp.ClientSession", return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_session_exc), __aexit__=AsyncMock(return_value=False))),
        ):
            success_exc, msg_exc = asyncio.run(main.send_test_notification())
            self.assertFalse(success_exc)
            self.assertIn("request failed", msg_exc.lower())
            self.assertIn("connection refused", msg_exc)

            sent_exc = asyncio.run(main.send_message("rest fail"))
            self.assertFalse(sent_exc)
            self.assertIn("request failed", main._last_send_error.lower())

        # 7. REST 200 with discord.Embed
        test_embed = discord.Embed(title="Embed Title", description="Embed Description")
        mock_resp_embed = MagicMock()
        mock_resp_embed.status = 200
        mock_resp_embed.text = AsyncMock(return_value='{"id": "msg_embed"}')
        mock_session_embed = MagicMock()
        mock_session_embed.post = MagicMock(return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_resp_embed), __aexit__=AsyncMock()))

        with (
            patch.object(main.client, "is_ready", return_value=False),
            patch.object(main.client, "get_channel", return_value=None),
            patch("aiohttp.ClientSession", return_value=AsyncMock(__aenter__=AsyncMock(return_value=mock_session_embed), __aexit__=AsyncMock())),
        ):
            sent_embed = asyncio.run(main.send_message(test_embed))
            self.assertTrue(sent_embed)
            mock_session_embed.post.assert_called_once()
            call_kwargs = mock_session_embed.post.call_args.kwargs
            self.assertIn("embeds", call_kwargs["json"])
            self.assertEqual(call_kwargs["json"]["embeds"][0]["title"], "Embed Title")


class CliAndMainTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_cli.sqlite3"
        self.db_patcher = patch.object(main, "RAID_STATE_DB", self.db_path)
        self.db_patcher.start()

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_show_notification_status_empty_future_and_overdue(self):
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            main.show_notification_status()
        self.assertIn("No successful weekly summary has been recorded yet.", buf.getvalue())

        now = time.time()
        main.record_notification("clean", now, weekly=True)
        buf_future = io.StringIO()
        with patch("sys.stdout", buf_future):
            main.show_notification_status()
        self.assertIn("Last successful weekly summary:", buf_future.getvalue())
        self.assertIn("Time remaining:", buf_future.getvalue())

        past = now - main.WEEK_SECONDS - 100
        main.record_notification("active", past, weekly=True)
        buf_overdue = io.StringIO()
        with patch("sys.stdout", buf_overdue):
            main.show_notification_status()
        self.assertIn(
            "Refresh status:                due on the next clean/active RAID check",
            buf_overdue.getvalue(),
        )

    def test_show_notification_logs_empty_and_populated(self):
        buf_empty = io.StringIO()
        with patch("sys.stdout", buf_empty):
            main.show_notification_logs(10)
        self.assertIn("No successful notifications have been recorded yet.", buf_empty.getvalue())

        main.record_notification("clean", 1700000000.0, weekly=True)
        main.record_notification("degraded", 1700000500.0, weekly=False)
        main.record_notification("test", 1700000600.0, weekly=False)
        buf_logs = io.StringIO()
        with patch("sys.stdout", buf_logs):
            main.show_notification_logs(10)
        output = buf_logs.getvalue()
        self.assertIn("weekly summary", output)
        self.assertIn("alert", output)
        self.assertIn("test notification", output)
        self.assertIn("clean", output)
        self.assertIn("degraded", output)
        self.assertIn("test", output)

    def test_main_cli_subcommands_and_validation(self):
        with (
            patch("sys.argv", ["main.py", "status"]),
            patch("sys.stdout", io.StringIO()),
        ):
            self.assertEqual(main.main(), 0)

        with (
            patch("sys.argv", ["main.py", "logs", "--limit", "5"]),
            patch("sys.stdout", io.StringIO()),
        ):
            self.assertEqual(main.main(), 0)

        with (
            patch("sys.argv", ["main.py", "logs", "--limit", "0"]),
            patch("sys.stderr", io.StringIO()),
        ):
            with self.assertRaises(SystemExit):
                main.main()

        with (
            patch("sys.argv", ["main.py", "status"]),
            patch.object(
                main,
                "show_notification_status",
                side_effect=sqlite3.Error("corrupt db"),
            ),
            patch("sys.stderr", io.StringIO()) as err_buf,
        ):
            self.assertEqual(main.main(), 1)
            self.assertIn("Could not read RAID notification data", err_buf.getvalue())

        with (
            patch("sys.argv", ["main.py", "web", "--host", "127.0.0.1", "--port", "9000"]),
            patch("uvicorn.run") as mock_uvicorn,
        ):
            self.assertEqual(main.main(), 0)
            mock_uvicorn.assert_called_once_with("api:app", host="127.0.0.1", port=9000)

        with (
            patch("sys.argv", ["main.py"]),
            patch.object(main, "get_app_settings", return_value={}),
            patch.object(main, "config", side_effect=lambda k, **kw: ""),
            patch("sys.stderr", io.StringIO()) as err_buf,
        ):
            self.assertEqual(main.main(), 1)
            self.assertIn(
                "DISCORD_TOKEN and CHANNEL_ID must be set to run the bot.",
                err_buf.getvalue(),
            )

        def fake_config_invalid_log(key, default=None, cast=None):
            values = {
                "DISCORD_TOKEN": "token123",
                "CHANNEL_ID": "456",
                "RAID_LOG_MAX_BYTES": 0,
                "RAID_LOG_BACKUP_COUNT": -1,
            }
            return values.get(key, default)

        with (
            patch("sys.argv", ["main.py"]),
            patch.object(main, "get_app_settings", return_value={}),
            patch.object(main, "config", side_effect=fake_config_invalid_log),
            patch("sys.stderr", io.StringIO()) as err_buf,
        ):
            self.assertEqual(main.main(), 1)
            self.assertIn("RAID_LOG_MAX_BYTES must be positive", err_buf.getvalue())


class SqlitePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_raid_monitor.sqlite3"
        self.db_patcher = patch.object(main, "RAID_STATE_DB", self.db_path)
        self.db_patcher.start()

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_initial_state_and_history_are_empty(self):
        self.assertIsNone(main.get_weekly_notification_state())
        self.assertEqual(main.get_notification_history(10), [])
        self.assertTrue(self.db_path.exists())

    def test_record_weekly_and_alert_notifications(self):
        t1 = 1700000000.0
        main.record_notification("clean", t1, weekly=True)

        state = main.get_weekly_notification_state()
        self.assertIsNotNone(state)
        sent_at, due_at, status = state
        self.assertEqual(sent_at, t1)
        self.assertEqual(due_at, t1 + main.WEEK_SECONDS)
        self.assertEqual(status, "clean")

        t2 = t1 + 3600.0
        main.record_notification("degraded", t2, weekly=False)

        state_after_alert = main.get_weekly_notification_state()
        self.assertEqual(state_after_alert, (t1, t1 + main.WEEK_SECONDS, "clean"))

        t3 = t1 + main.WEEK_SECONDS + 60.0
        main.record_notification("active", t3, weekly=True)
        state_after_second_weekly = main.get_weekly_notification_state()
        self.assertEqual(
            state_after_second_weekly, (t3, t3 + main.WEEK_SECONDS, "active")
        )

        full_history = main.get_notification_history(10)
        self.assertEqual(
            full_history,
            [
                ("active", t3, 1),
                ("degraded", t2, 0),
                ("clean", t1, 1),
            ],
        )

        limited_history = main.get_notification_history(2)
        self.assertEqual(len(limited_history), 2)
        self.assertEqual(limited_history[0][0], "active")
        self.assertEqual(limited_history[1][0], "degraded")

    def test_users_and_sessions_crud_and_expiration(self):
        self.assertFalse(main.has_any_user())

        with self.assertRaises(ValueError):
            main.create_user("", "secret")
        with self.assertRaises(ValueError):
            main.create_user("admin", "")

        created = main.create_user("admin", "CorrectHorseBatteryStaple", email="admin@example.com")
        self.assertEqual(created["username"], "admin")
        self.assertEqual(created["email"], "admin@example.com")
        self.assertTrue(main.has_any_user())

        self.assertTrue(main.verify_user("admin", "CorrectHorseBatteryStaple"))
        self.assertFalse(main.verify_user("admin", "WrongPassword"))
        self.assertFalse(main.verify_user("nonexistent", "CorrectHorseBatteryStaple"))
        self.assertFalse(main.verify_user("", "CorrectHorseBatteryStaple"))

        # Sessions: create, verify, expire, delete
        token = main.create_session("admin")
        self.assertEqual(main.verify_session(token), "admin")
        self.assertIsNone(main.verify_session(None))
        self.assertIsNone(main.verify_session("unknown-token"))

        # Expire session in the future using time.time mock
        future_time = time.time() + main.SESSION_TTL_SECONDS + 10
        with patch("main.time.time", return_value=future_time):
            self.assertIsNone(main.verify_session(token))
        # Expired session should have been deleted from DB
        self.assertIsNone(main.verify_session(token))

        # Delete active session
        token2 = main.create_session("admin")
        self.assertEqual(main.verify_session(token2), "admin")
        main.delete_session(token2)
        self.assertIsNone(main.verify_session(token2))
        main.delete_session(None)

    def test_refresh_intervals_defaults_and_custom_settings(self):
        # 1. Default intervals
        intervals = main.get_refresh_intervals()
        self.assertEqual(
            intervals,
            {"system": 1, "raid": 15, "notifications": 60, "docker": 5},
        )

        # 2. Custom SQLite settings including 0 for paused
        main.update_app_settings(
            {
                "refresh_system_sec": "5",
                "refresh_raid_sec": "0",
                "refresh_notifications_sec": "120",
                "refresh_docker_sec": "10",
            }
        )
        custom = main.get_refresh_intervals()
        self.assertEqual(
            custom,
            {"system": 5, "raid": 0, "notifications": 120, "docker": 10},
        )

        # 3. Direct dictionary argument support and fallback for invalid values
        override = main.get_refresh_intervals(
            {
                "refresh_system_sec": "invalid",
                "refresh_raid_sec": "30",
                "refresh_notifications_sec": "-5",
                "refresh_docker_sec": "abc",
            }
        )
        self.assertEqual(override["system"], 1)  # fallback to default
        self.assertEqual(override["raid"], 30)
        self.assertEqual(override["notifications"], 0)  # max(0, -5) -> 0
        self.assertEqual(override["docker"], 5)  # fallback to default

    def test_app_settings_env_seed_update_and_fallback(self):
        env_values = {
            "DISCORD_TOKEN": "env_discord_token_1234",
            "CHANNEL_ID": "987654321",
            "RAID_DEVICE": "/dev/md128",
            "MOUNT_PATH": "/mnt/media/",
            "GOOGLE_CLIENT_ID": "env-google-client.apps.googleusercontent.com",
            "ALLOWED_GOOGLE_EMAILS": "owner@example.com",
        }
        with patch.object(
            main, "config", side_effect=lambda k, default="": env_values.get(k, default)
        ):
            seeded = main.get_app_settings()
            self.assertEqual(seeded["discord_token"], "env_discord_token_1234")
            self.assertEqual(seeded["channel_id"], "987654321")
            self.assertEqual(seeded["raid_device"], "/dev/md128")
            self.assertEqual(seeded["mount_path"], "/mnt/media/")
            self.assertEqual(
                seeded["google_client_id"], "env-google-client.apps.googleusercontent.com"
            )
            self.assertEqual(seeded["allowed_google_emails"], "owner@example.com")

            # Update settings in SQLite
            updated = main.update_app_settings(
                {
                    "channel_id": "111222333",
                    "raid_device": "/dev/md0",
                    "mount_path": "/mnt/storage/",
                    "allowed_google_emails": "owner@example.com, second@example.com",
                }
            )
            self.assertEqual(updated["channel_id"], "111222333")
            self.assertEqual(main.CHANNEL_ID, "111222333")
            self.assertEqual(updated["raid_device"], "/dev/md0")
            self.assertEqual(updated["mount_path"], "/mnt/storage/")
            self.assertEqual(updated["discord_token"], "env_discord_token_1234")

            # Verify fallback to .env defaults if SQLite raises an error
            with patch.object(
                main, "_connect_state_db", side_effect=sqlite3.Error("db locked")
            ):
                fallback = main.get_app_settings()
                self.assertEqual(fallback["channel_id"], "987654321")
                self.assertEqual(fallback["discord_token"], "env_discord_token_1234")

    def test_discord_enabled_env_seed_and_db_persistence(self):
        # 1. When DISCORD_TOKEN is present in env, discord_enabled defaults to 'true'
        with patch.object(
            main, "config", side_effect=lambda k, default=None: "my-token" if k == "DISCORD_TOKEN" else default
        ):
            defaults = main._default_app_settings_from_env()
            self.assertEqual(defaults["discord_enabled"], "true")

        # 2. When DISCORD_TOKEN is missing in env, discord_enabled defaults to 'false'
        with patch.object(
            main, "config", side_effect=lambda k, default=None: "" if k == "DISCORD_TOKEN" else default
        ):
            defaults_empty = main._default_app_settings_from_env()
            self.assertEqual(defaults_empty["discord_enabled"], "false")

        # 3. Explicit DISCORD_ENABLED env var overrides token presence
        with patch.object(
            main, "config", side_effect=lambda k, default=None: "my-token" if k == "DISCORD_TOKEN" else ("false" if k == "DISCORD_ENABLED" else default)
        ):
            defaults_disabled = main._default_app_settings_from_env()
            self.assertEqual(defaults_disabled["discord_enabled"], "false")

        with patch.object(
            main, "config", side_effect=lambda k, default=None: "" if k == "DISCORD_TOKEN" else ("true" if k == "DISCORD_ENABLED" else default)
        ):
            defaults_override_true = main._default_app_settings_from_env()
            self.assertEqual(defaults_override_true["discord_enabled"], "true")

        # 4. update_app_settings persists discord_enabled to app_settings in DB
        main.update_app_settings({"discord_enabled": "true"})
        self.assertEqual(main.get_app_settings()["discord_enabled"], "true")

        main.update_app_settings({"discord_enabled": "false"})
        self.assertEqual(main.get_app_settings()["discord_enabled"], "false")


class FastAPIEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_api_raid.sqlite3"
        self.db_patcher = patch.object(main, "RAID_STATE_DB", self.db_path)
        self.db_patcher.start()
        main.create_user("admin", "adminpass", email="admin@example.com")
        self.session_token = main.create_session("admin")
        self.auth_cookies = {"session_token": self.session_token}
        self.auth_headers = {"Authorization": f"Bearer {self.session_token}"}

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_protected_endpoints_enforce_authentication(self):
        protected_get_paths = [
            "/api/status",
            "/api/history",
            "/api/settings",
            "/api/update/check",
            "/api/changelog",
        ]
        for path in protected_get_paths:
            resp = asgi_get(api.app, path)
            self.assertEqual(resp.status_code, 401, f"Expected 401 for unauthenticated GET {path}")

        for path in ["/api/settings", "/api/update/apply", "/api/notifications/test"]:
            resp = asgi_post(api.app, path, json_body={})
            self.assertEqual(resp.status_code, 401, f"Expected 401 for unauthenticated POST {path}")

        # Verify both session cookie and Bearer token grant 200 access
        with (
            patch.object(main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF),
        ):
            cookie_resp = asgi_get(api.app, "/api/status", cookies=self.auth_cookies)
            self.assertEqual(cookie_resp.status_code, 200)

            bearer_resp = asgi_get(api.app, "/api/status", headers=self.auth_headers)
            self.assertEqual(bearer_resp.status_code, 200)

    def test_auth_setup_login_google_and_logout_flows(self):
        # Use a fresh empty DB to test initial setup flow
        fresh_db = Path(self.temp_dir.name) / "fresh_auth.sqlite3"
        with patch.object(main, "RAID_STATE_DB", fresh_db):
            status_before = asgi_get(api.app, "/api/auth/status").json()
            self.assertFalse(status_before["authenticated"])
            self.assertTrue(status_before["setup_required"])

            # Password too short returns 400
            bad_setup = asgi_post(
                api.app,
                "/api/auth/setup",
                json_body={"username": "firstadmin", "password": "123"},
            )
            self.assertEqual(bad_setup.status_code, 400)

            # Valid initial setup creates user and returns token + cookie
            setup_resp = asgi_post(
                api.app,
                "/api/auth/setup",
                json_body={
                    "username": "firstadmin",
                    "password": "strongpassword",
                    "email": "first@example.com",
                },
            )
            self.assertEqual(setup_resp.status_code, 200)
            setup_data = setup_resp.json()
            self.assertTrue(setup_data["authenticated"])
            self.assertEqual(setup_data["username"], "firstadmin")
            self.assertIn("session_token=", setup_resp.headers.get("set-cookie", ""))

            # Second setup attempt is rejected with 400
            dup_setup = asgi_post(
                api.app,
                "/api/auth/setup",
                json_body={"username": "second", "password": "strongpassword"},
            )
            self.assertEqual(dup_setup.status_code, 400)

            # Login with invalid password returns 401
            bad_login = asgi_post(
                api.app,
                "/api/auth/login",
                json_body={"username": "firstadmin", "password": "wrongpassword"},
            )
            self.assertEqual(bad_login.status_code, 401)

            # Login with valid password returns 200 and session token
            login_resp = asgi_post(
                api.app,
                "/api/auth/login",
                json_body={"username": "firstadmin", "password": "strongpassword"},
            )
            self.assertEqual(login_resp.status_code, 200)
            login_token = login_resp.json()["token"]

            # Auth status with token shows authenticated
            status_after = asgi_get(
                api.app,
                "/api/auth/status",
                cookies={"session_token": login_token},
            ).json()
            self.assertTrue(status_after["authenticated"])
            self.assertEqual(status_after["username"], "firstadmin")
            self.assertFalse(status_after["setup_required"])

            # Google OAuth login test (mocking urlopen to Google tokeninfo endpoint)
            main.update_app_settings(
                {
                    "google_client_id": "my-google-client-id",
                    "allowed_google_emails": "allowed@example.com",
                }
            )

            missing_token_resp = asgi_post(api.app, "/api/auth/google", json_body={})
            self.assertEqual(missing_token_resp.status_code, 400)

            def mock_urlopen_factory(payload_dict):
                mock_cm = MagicMock()
                mock_cm.__enter__.return_value.read.return_value = json.dumps(
                    payload_dict
                ).encode("utf-8")
                return mock_cm

            # Allowed Google email succeeds
            with patch(
                "api.urlopen",
                return_value=mock_urlopen_factory(
                    {
                        "email": "allowed@example.com",
                        "email_verified": "true",
                        "aud": "my-google-client-id",
                    }
                ),
            ):
                google_ok = asgi_post(
                    api.app,
                    "/api/auth/google",
                    json_body={"credential": "fake-google-jwt"},
                )
                self.assertEqual(google_ok.status_code, 200)
                self.assertTrue(google_ok.json()["authenticated"])
                self.assertEqual(google_ok.json()["username"], "allowed@example.com")

            # Unauthorized Google email returns 403
            with patch(
                "api.urlopen",
                return_value=mock_urlopen_factory(
                    {
                        "email": "intruder@example.com",
                        "email_verified": "true",
                        "aud": "my-google-client-id",
                    }
                ),
            ):
                google_forbidden = asgi_post(
                    api.app,
                    "/api/auth/google",
                    json_body={"credential": "fake-google-jwt"},
                )
                self.assertEqual(google_forbidden.status_code, 403)

            # Audience mismatch returns 401
            with patch(
                "api.urlopen",
                return_value=mock_urlopen_factory(
                    {
                        "email": "allowed@example.com",
                        "email_verified": "true",
                        "aud": "wrong-client-id",
                    }
                ),
            ):
                google_bad_aud = asgi_post(
                    api.app,
                    "/api/auth/google",
                    json_body={"credential": "fake-google-jwt"},
                )
                self.assertEqual(google_bad_aud.status_code, 401)

            # URLError during tokeninfo verification returns 401
            with patch("api.urlopen", side_effect=URLError("network error")):
                google_net_err = asgi_post(
                    api.app,
                    "/api/auth/google",
                    json_body={"credential": "fake-google-jwt"},
                )
                self.assertEqual(google_net_err.status_code, 401)

            # Logout invalidates session token
            logout_resp = asgi_post(
                api.app,
                "/api/auth/logout",
                cookies={"session_token": login_token},
            )
            self.assertEqual(logout_resp.status_code, 200)
            self.assertFalse(logout_resp.json()["authenticated"])
            self.assertIsNone(main.verify_session(login_token))

    def test_settings_api_masks_discord_token_and_updates_sqlite(self):
        main.update_app_settings(
            {
                "discord_token": "super_secret_token_9876",
                "channel_id": "123456789",
                "raid_device": "/dev/md128",
                "mount_path": "/mnt/media/",
            }
        )

        with patch.object(
            main, "discover_raid_devices", return_value=["/dev/md0", "/dev/md127"]
        ):
            get_resp = asgi_get(api.app, "/api/settings", cookies=self.auth_cookies)
            self.assertEqual(get_resp.status_code, 200)
            settings_data = get_resp.json()
            self.assertTrue(settings_data["discord_token_configured"])
            self.assertEqual(settings_data["discord_token_masked"], "••••9876")
            self.assertNotIn("super_secret", json.dumps(settings_data))
            self.assertEqual(settings_data["channel_id"], "123456789")
            self.assertEqual(
                settings_data["available_raid_devices"], ["/dev/md0", "/dev/md127"]
            )
            self.assertEqual(settings_data["resolved_raid_device"], "/dev/md0")

        # Update settings without sending discord_token preserves existing token
        post_resp = asgi_post(
            api.app,
            "/api/settings",
            cookies=self.auth_cookies,
            json_body={
                "channel_id": "555666777",
                "raid_device": "/dev/md1",
                "mount_path": "/mnt/raid/",
                "google_client_id": "new-client-id",
                "allowed_google_emails": "user1@example.com",
            },
        )
        self.assertEqual(post_resp.status_code, 200)
        updated_data = post_resp.json()
        self.assertTrue(updated_data["saved"])
        self.assertEqual(updated_data["channel_id"], "555666777")
        self.assertEqual(updated_data["raid_device"], "/dev/md1")
        self.assertEqual(updated_data["mount_path"], "/mnt/raid/")
        self.assertEqual(updated_data["discord_token_masked"], "••••9876")

        # Updating discord_token changes the stored and masked value
        post_token_resp = asgi_post(
            api.app,
            "/api/settings",
            cookies=self.auth_cookies,
            json_body={"discord_token": "new_discord_token_4321"},
        )
        self.assertEqual(post_token_resp.status_code, 200)
        self.assertEqual(post_token_resp.json()["discord_token_masked"], "••••4321")
        self.assertEqual(main.get_app_settings()["discord_token"], "new_discord_token_4321")

    def test_notifications_test_endpoint_and_discord_enabled_toggle(self):
        # 1. Toggle discord_enabled to false via POST /api/settings
        toggle_false_resp = asgi_post(
            api.app,
            "/api/settings",
            cookies=self.auth_cookies,
            json_body={"discord_enabled": False},
        )
        self.assertEqual(toggle_false_resp.status_code, 200)
        self.assertFalse(toggle_false_resp.json()["discord_enabled"])
        self.assertEqual(main.get_app_settings()["discord_enabled"], "false")

        # 2. Toggle discord_enabled back to true
        toggle_true_resp = asgi_post(
            api.app,
            "/api/settings",
            cookies=self.auth_cookies,
            json_body={"discord_enabled": True},
        )
        self.assertEqual(toggle_true_resp.status_code, 200)
        self.assertTrue(toggle_true_resp.json()["discord_enabled"])
        self.assertEqual(main.get_app_settings()["discord_enabled"], "true")

        # 3. POST /api/notifications/test with mocked send_test_notification
        with patch.object(
            main,
            "send_test_notification",
            new=AsyncMock(return_value=(True, "Test notification sent successfully.")),
        ) as mock_send_test:
            test_resp = asgi_post(
                api.app,
                "/api/notifications/test",
                cookies=self.auth_cookies,
            )
            self.assertEqual(test_resp.status_code, 200)
            self.assertEqual(
                test_resp.json(),
                {"success": True, "message": "Test notification sent successfully."},
            )
            mock_send_test.assert_awaited_once()

        # 4. POST /api/notifications/test failure result
        with patch.object(
            main,
            "send_test_notification",
            new=AsyncMock(
                return_value=(False, "Discord notifications are disabled in settings.")
            ),
        ):
            test_fail_resp = asgi_post(
                api.app,
                "/api/notifications/test",
                cookies=self.auth_cookies,
            )
            self.assertEqual(test_fail_resp.status_code, 200)
            self.assertEqual(
                test_fail_resp.json(),
                {
                    "success": False,
                    "message": "Discord notifications are disabled in settings.",
                },
            )

    def test_release_update_check_and_apply_endpoints(self):
        executed_cmds = []

        def fake_check_output(cmd, *args, **kwargs):
            executed_cmds.append(cmd)
            if cmd[:3] == ["git", "rev-parse", "--short"] and cmd[3] == "HEAD":
                return b"abc1234\n"
            if cmd[:3] == ["git", "fetch", "origin"]:
                return b""
            if cmd[:3] == ["git", "tag", "-l"] and any("v*" in str(c) for c in cmd):
                return b"v0.1.0\nv0.2.0\n"
            if cmd[:3] == ["git", "rev-parse", "--short"] and "v0.2.0" in cmd[3]:
                return b"def5678\n"
            if cmd[:3] == ["git", "log", "--oneline"]:
                return b"def5678 Add settings and update manager\n"
            if cmd[:2] == ["git", "show"] and "v0.2.0:RELEASE_NOTES.md" in cmd[2]:
                return b"# Release v0.2.0 \xf0\x9f\x9a\x80\n\n- Add settings and update manager\n"
            if cmd[:3] == ["git", "checkout", "-f"]:
                return b"Previous HEAD position was abc1234\nHEAD is now at def5678\n"
            if len(cmd) == 2 and cmd[1] == "sync":
                return b"Resolved 20 packages\n"
            return b""

        with (
            patch.object(
                main,
                "get_current_version_info",
                return_value={"version": "0.1.0", "commit": "abc1234"},
            ),
            patch.object(main, "check_output", side_effect=fake_check_output),
        ):
            check_resp = asgi_get(api.app, "/api/update/check", cookies=self.auth_cookies)
            self.assertEqual(check_resp.status_code, 200)
            check_data = check_resp.json()
            self.assertEqual(check_data["current_version"], "0.1.0")
            self.assertEqual(check_data["current_commit"], "abc1234")
            self.assertEqual(check_data["latest_version"], "0.2.0")
            self.assertEqual(check_data["latest_commit"], "def5678")
            self.assertTrue(check_data["update_available"])
            self.assertIn("Add settings and update manager", check_data["changelog"])
            self.assertEqual(check_data["release_notes"], "# Release v0.2.0\n\n- Add settings and update manager")

            with patch("main.subprocess.Popen") as mock_popen:
                apply_resp = asgi_post(
                    api.app, "/api/update/apply", cookies=self.auth_cookies
                )
                self.assertEqual(apply_resp.status_code, 200)
                apply_data = apply_resp.json()
                self.assertEqual(apply_data["status"], "updating")
                self.assertEqual(apply_data["target_version"], "0.2.0")
                self.assertIn(["git", "checkout", "-f", "v0.2.0"], executed_cmds)
                mock_popen.assert_called_once()

            changelog_resp = asgi_get(api.app, "/api/changelog", cookies=self.auth_cookies)
            self.assertEqual(changelog_resp.status_code, 200)
            changelog_data = changelog_resp.json()
            self.assertIn("changelog", changelog_data)
            self.assertTrue(isinstance(changelog_data["changelog"], str))

        # Verify apply_release_update succeeds even when uv binary raises FileNotFoundError
        def fake_check_output_no_uv(cmd, *args, **kwargs):
            if len(cmd) == 2 and cmd[1] == "sync":
                raise FileNotFoundError(2, "No such file or directory", "uv")
            return fake_check_output(cmd, *args, **kwargs)

        with (
            patch.object(
                main,
                "get_current_version_info",
                return_value={"version": "0.1.0", "commit": "abc1234"},
            ),
            patch.object(main, "check_output", side_effect=fake_check_output_no_uv),
            patch("main.subprocess.Popen") as mock_popen,
        ):
            no_uv_resp = asgi_post(
                api.app, "/api/update/apply", cookies=self.auth_cookies
            )
            self.assertEqual(no_uv_resp.status_code, 200)
            self.assertEqual(no_uv_resp.json()["status"], "updating")
            mock_popen.assert_called_once()

        # Verify 500 response when git checkout / uv sync fails during apply
        with patch.object(
            main,
            "apply_release_update",
            side_effect=CalledProcessError(1, ["git", "checkout"], output=b"checkout conflict"),
        ):
            fail_resp = asgi_post(
                api.app, "/api/update/apply", cookies=self.auth_cookies
            )
            self.assertEqual(fail_resp.status_code, 500)
            self.assertIn("checkout conflict", fail_resp.json()["detail"])

    def test_api_changelog_endpoint(self):
        # Authenticated access when CHANGELOG.md exists
        with patch.object(main, "get_full_changelog", return_value="# Changelog\n\n- v0.8.2 Initial"):
            resp = asgi_get(api.app, "/api/changelog", cookies=self.auth_cookies)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json(), {"changelog": "# Changelog\n\n- v0.8.2 Initial"})

        # Fallback when CHANGELOG.md is missing or raises OSError
        with patch.object(main, "get_full_changelog", return_value=""):
            resp = asgi_get(api.app, "/api/changelog", cookies=self.auth_cookies)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json(), {"changelog": ""})

    def test_check_for_release_update_with_curated_notes(self):
        def fake_git(cmd, *args, **kwargs):
            if cmd[:3] == ["git", "fetch", "origin"]:
                return b""
            if cmd[:3] == ["git", "tag", "-l"] and any("v*" in str(c) for c in cmd):
                return b"v0.1.0\nv0.9.0\n"
            if cmd[:3] == ["git", "rev-parse", "--short"]:
                return b"abc999\n"
            if cmd[:3] == ["git", "log", "--oneline"]:
                return b"abc999 Commit log\n"
            if cmd[:2] == ["git", "show"] and "v0.9.0:RELEASE_NOTES.md" in cmd[2]:
                return (
                    b"# Release v0.9.0 \xf0\x9f\x9a\x80\n\n"
                    b"## Highlights \xe2\x9c\xa8\n"
                    b"- \xf0\x9f\x9a\x80 Fast streaming\n"
                    b"- \xe2\x9a\xa1 Low overhead\n"
                )
            return b""

        with (
            patch.object(
                main,
                "get_current_version_info",
                return_value={"version": "0.1.0", "commit": "old000"},
            ),
            patch.object(main, "check_output", side_effect=fake_git),
        ):
            res = main.check_for_release_update()
            self.assertTrue(res["update_available"])
            self.assertEqual(res["latest_version"], "0.9.0")
            self.assertEqual(
                res["release_notes"],
                "# Release v0.9.0\n\n## Highlights\n- Fast streaming\n- Low overhead",
            )
            self.assertEqual(res["changelog"], "abc999 Commit log")

    def test_check_for_release_update_fallback_to_tag_message(self):
        def fake_git(cmd, *args, **kwargs):
            if cmd[:3] == ["git", "fetch", "origin"]:
                return b""
            if cmd[:3] == ["git", "tag", "-l"] and any("v*" in str(c) for c in cmd):
                return b"v0.1.0\nv0.9.0\n"
            if cmd[:3] == ["git", "rev-parse", "--short"]:
                return b"abc999\n"
            if cmd[:3] == ["git", "log", "--oneline"]:
                return b"abc999 Commit log\n"
            if cmd[:2] == ["git", "show"]:
                raise CalledProcessError(1, cmd, output=b"fatal: path not found")
            if cmd[:3] == ["git", "tag", "-l"] and any("%(contents)" in str(c) for c in cmd):
                return b"Release v0.9.0 \xf0\x9f\x8e\x89\nCurated tag message\n"
            return b""

        with (
            patch.object(
                main,
                "get_current_version_info",
                return_value={"version": "0.1.0", "commit": "old000"},
            ),
            patch.object(main, "check_output", side_effect=fake_git),
        ):
            res = main.check_for_release_update()
            self.assertTrue(res["update_available"])
            self.assertEqual(
                res["release_notes"],
                "Release v0.9.0\nCurated tag message",
            )

    def test_check_for_release_update_fallback_to_git_log(self):
        def fake_git(cmd, *args, **kwargs):
            if cmd[:3] == ["git", "fetch", "origin"]:
                return b""
            if cmd[:3] == ["git", "tag", "-l"] and any("v*" in str(c) for c in cmd):
                return b"v0.1.0\nv0.9.0\n"
            if cmd[:3] == ["git", "rev-parse", "--short"]:
                return b"abc999\n"
            if cmd[:3] == ["git", "log", "--oneline"]:
                return b"abc999 Direct log fallback \xf0\x9f\x90\x9b\n"
            if cmd[:2] == ["git", "show"]:
                raise CalledProcessError(1, cmd, output=b"fatal: not found")
            if cmd[:3] == ["git", "tag", "-l"] and any("%(contents)" in str(c) for c in cmd):
                return b""
            return b""

        with (
            patch.object(
                main,
                "get_current_version_info",
                return_value={"version": "0.1.0", "commit": "old000"},
            ),
            patch.object(main, "check_output", side_effect=fake_git),
        ):
            res = main.check_for_release_update()
            self.assertTrue(res["update_available"])
            self.assertEqual(res["release_notes"], "abc999 Direct log fallback")
            self.assertEqual(res["changelog"], "abc999 Direct log fallback \U0001f41b")

    def test_check_for_release_update_no_update_and_no_tags(self):
        # Case 1: No tags
        with (
            patch.object(
                main,
                "get_current_version_info",
                return_value={"version": "1.0.0", "commit": "cur123"},
            ),
            patch.object(main, "check_output", return_value=b""),
        ):
            res = main.check_for_release_update()
            self.assertFalse(res["update_available"])
            self.assertEqual(res["release_notes"], "")
            self.assertEqual(res["changelog"], "")

        # Case 2: Latest version <= current version
        def fake_git_uptodate(cmd, *args, **kwargs):
            if cmd[:3] == ["git", "tag", "-l"] and any("v*" in str(c) for c in cmd):
                return b"v1.0.0\nv0.9.0\n"
            return b""

        with (
            patch.object(
                main,
                "get_current_version_info",
                return_value={"version": "1.0.0", "commit": "cur123"},
            ),
            patch.object(main, "check_output", side_effect=fake_git_uptodate),
        ):
            res = main.check_for_release_update()
            self.assertFalse(res["update_available"])
            self.assertEqual(res["release_notes"], "")
            self.assertEqual(res["changelog"], "")

    def test_strip_emojis_utility(self):
        self.assertEqual(main.strip_emojis(""), "")
        self.assertEqual(main.strip_emojis(None), "")
        raw = (
            "# Release v1.0.0 \U0001f680\n\n"
            "## Highlights \u2728\n"
            "- \U0001f680 High-performance direct event streaming\n"
            "    - \u26a1 Debian-native low-overhead monitoring\n"
            "- \U0001f41b Fix concurrency issue\n"
        )
        expected = (
            "# Release v1.0.0\n\n"
            "## Highlights\n"
            "- High-performance direct event streaming\n"
            "    - Debian-native low-overhead monitoring\n"
            "- Fix concurrency issue"
        )
        self.assertEqual(main.strip_emojis(raw), expected)

    def test_get_api_status_returns_raid_system_and_notification_state(self):
        ts = 1700001000.0
        main.record_notification("clean", ts, weekly=True)

        with (
            patch.object(
                main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)
            ) as mock_raid,
            patch.object(
                main, "get_duf_output", return_value=SAMPLE_DUF_TABLE
            ) as mock_duf,
        ):
            response = asgi_get(api.app, "/api/status", cookies=self.auth_cookies)

        self.assertEqual(response.status_code, 200)
        mock_raid.assert_called_once()
        mock_duf.assert_called_once()

        payload = response.json()
        self.assertIn("raid", payload)
        self.assertIn("system", payload)
        self.assertIn("notification_state", payload)
        self.assertIn("version", payload)

        self.assertEqual(payload["raid"]["status"], "clean")
        self.assertEqual(payload["raid"]["raid_level"], "raid1")
        self.assertEqual(payload["raid"]["array_size"], "9.31 GiB")
        self.assertEqual(
            payload["raid"]["storage_info"], "8.12T/14.55T (55.8%) | 6.43T free"
        )
        self.assertEqual(len(payload["raid"]["devices"]), 2)

        system = payload["system"]
        self.assertIn("cpu_percent", system)
        self.assertIn("memory", system)
        self.assertIn("disk", system)
        self.assertIn("boot_time", system)

        notif = payload["notification_state"]
        self.assertIsNotNone(notif)
        self.assertEqual(notif["sent_at"], ts)
        self.assertEqual(notif["due_at"], ts + main.WEEK_SECONDS)
        self.assertEqual(notif["status"], "clean")

    def test_get_api_status_when_no_notification_state_recorded(self):
        with (
            patch.object(
                main, "check_raid_status", return_value=("degraded", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF),
        ):
            response = asgi_get(api.app, "/api/status", cookies=self.auth_cookies)

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["raid"]["status"], "degraded")
        self.assertIsNone(payload["notification_state"])

    def test_get_api_history_returns_formatted_notifications_and_respects_limit(self):
        main.record_notification("clean", 1700000100.0, weekly=True)
        main.record_notification("degraded", 1700000200.0, weekly=False)
        main.record_notification("recovering", 1700000300.0, weekly=False)
        main.record_notification("test", 1700000400.0, weekly=False)

        response = asgi_get(api.app, "/api/history", cookies=self.auth_cookies)
        self.assertEqual(response.status_code, 200)
        history = response.json()["history"]
        self.assertEqual(len(history), 4)
        self.assertEqual(history[0]["status"], "test")
        self.assertFalse(history[0]["weekly"])
        self.assertEqual(history[0]["kind"], "test notification")
        self.assertEqual(history[1]["status"], "recovering")
        self.assertFalse(history[1]["weekly"])
        self.assertEqual(history[1]["kind"], "alert")
        self.assertEqual(history[3]["status"], "clean")
        self.assertTrue(history[3]["weekly"])
        self.assertEqual(history[3]["kind"], "weekly summary")

        limited_resp = asgi_get(
            api.app, "/api/history?limit=1", cookies=self.auth_cookies
        )
        self.assertEqual(limited_resp.status_code, 200)
        limited_history = limited_resp.json()["history"]
        self.assertEqual(len(limited_history), 1)
        self.assertEqual(limited_history[0]["status"], "test")

        invalid_resp = asgi_get(
            api.app, "/api/history?limit=0", cookies=self.auth_cookies
        )
        self.assertEqual(invalid_resp.status_code, 422)

    def test_api_sqlite_error_and_missing_index_fallbacks(self):
        with (
            patch.object(
                main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF),
            patch.object(
                main,
                "get_weekly_notification_state",
                side_effect=sqlite3.Error("db unavailable"),
            ),
        ):
            status_resp = asgi_get(api.app, "/api/status", cookies=self.auth_cookies)
            self.assertEqual(status_resp.status_code, 200)
            self.assertIsNone(status_resp.json()["notification_state"])

        with patch.object(
            main,
            "get_notification_history",
            side_effect=sqlite3.Error("db unavailable"),
        ):
            history_resp = asgi_get(api.app, "/api/history", cookies=self.auth_cookies)
            self.assertEqual(history_resp.status_code, 200)
            self.assertEqual(history_resp.json(), {"history": []})

        empty_static_dir = Path(self.temp_dir.name) / "empty_static"
        empty_static_dir.mkdir(parents=True, exist_ok=True)
        with patch.object(api, "STATIC_DIR", empty_static_dir):
            fallback_resp = asgi_get(api.app, "/")
            self.assertEqual(fallback_resp.status_code, 200)
            self.assertIn("<h1>SystemAlerts Server Manager</h1>", fallback_resp.text)

    def test_get_root_serves_dashboard_html(self):
        response = asgi_get(api.app, "/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers.get("content-type", ""))
        self.assertIn("<html", response.text.lower())
        self.assertEqual(
            response.headers.get("cache-control"), "no-cache, no-store, must-revalidate"
        )
        self.assertEqual(response.headers.get("pragma"), "no-cache")
        self.assertEqual(response.headers.get("expires"), "0")

        current_ver = main.get_current_version_info()["current_version"]
        self.assertIn(f"/static/styles.css?v={current_ver}", response.text)
        self.assertIn(f"/static/app.js?v={current_ver}", response.text)

    def test_static_assets_and_dashboard_elements_served(self):
        index_resp = asgi_get(api.app, "/")
        self.assertEqual(index_resp.status_code, 200)
        self.assertIn('id="raid-status-badge"', index_resp.text)
        self.assertIn('id="active-disks-table"', index_resp.text)
        self.assertIn('id="notification-history-table"', index_resp.text)
        self.assertIn('id="auth-overlay"', index_resp.text)
        self.assertIn('id="settings-modal"', index_resp.text)
        self.assertIn('id="system-interval-select"', index_resp.text)
        self.assertIn('id="raid-interval-select"', index_resp.text)
        self.assertIn('id="notifications-interval-select"', index_resp.text)

        # Navigation tabs and view panels (verifying Containers is between Overview and Notifications)
        self.assertIn('id="nav-tab-overview"', index_resp.text)
        self.assertIn('id="nav-tab-containers"', index_resp.text)
        self.assertIn('id="nav-tab-notifications"', index_resp.text)
        self.assertIn(">Overview</span>", index_resp.text)
        self.assertIn(">Containers</span>", index_resp.text)
        self.assertIn(">Notifications</span>", index_resp.text)
        self.assertIn('id="view-overview"', index_resp.text)
        self.assertIn('id="view-containers"', index_resp.text)
        self.assertIn('id="view-notifications"', index_resp.text)

        # Verify nav order: Overview -> Containers -> Notifications
        idx_nav_overview = index_resp.text.find('id="nav-tab-overview"')
        idx_nav_containers = index_resp.text.find('id="nav-tab-containers"')
        idx_nav_notifs = index_resp.text.find('id="nav-tab-notifications"')
        self.assertTrue(
            -1 < idx_nav_overview < idx_nav_containers < idx_nav_notifs,
            "Nav order must be Overview, Containers, Notifications",
        )

        # Docker UI elements in Containers view
        self.assertIn('id="docker-install-banner"', index_resp.text)
        self.assertIn('id="btn-install-docker"', index_resp.text)
        self.assertIn('id="docker-stopped-banner"', index_resp.text)
        self.assertIn('id="docker-daemon-badge"', index_resp.text)
        self.assertIn('id="docker-version-info"', index_resp.text)
        self.assertIn('id="docker-interval-select"', index_resp.text)
        self.assertIn('id="docker-status-dot"', index_resp.text)
        self.assertIn('id="nav-tab-containers-badge"', index_resp.text)
        self.assertIn('id="refresh-docker-btn"', index_resp.text)
        self.assertIn('id="docker-stat-stacks"', index_resp.text)
        self.assertIn('id="docker-stat-containers"', index_resp.text)
        self.assertIn('id="docker-stat-images"', index_resp.text)
        self.assertIn('id="docker-stat-volumes"', index_resp.text)
        self.assertIn('id="docker-stat-networks"', index_resp.text)

        # Container filters
        self.assertIn('id="containers-search-input"', index_resp.text)
        self.assertIn('id="containers-filter-stack"', index_resp.text)
        self.assertIn('id="containers-filter-status"', index_resp.text)

        # Automated Update Schedule UI
        self.assertIn('update-schedule-card', index_resp.text)
        self.assertIn('id="update-schedule-form"', index_resp.text)
        self.assertIn('id="update-schedule-badge"', index_resp.text)
        self.assertIn('id="schedule-enabled-toggle"', index_resp.text)
        self.assertIn('id="schedule-day-select"', index_resp.text)
        self.assertIn('id="schedule-time-input"', index_resp.text)
        self.assertIn('id="btn-save-schedule"', index_resp.text)
        self.assertIn('id="schedule-next-run"', index_resp.text)

        # Docker sub-tabs and tables
        self.assertIn('id="subtab-docker-stacks"', index_resp.text)
        self.assertIn('id="subtab-docker-containers"', index_resp.text)
        self.assertIn('id="subtab-docker-images"', index_resp.text)
        self.assertIn('id="subtab-docker-volumes"', index_resp.text)
        self.assertIn('id="subtab-docker-networks"', index_resp.text)
        self.assertIn('id="subtab-docker-updates"', index_resp.text)
        self.assertIn('id="docker-stacks-table"', index_resp.text)
        self.assertIn('id="docker-containers-table"', index_resp.text)
        self.assertIn('id="docker-images-table"', index_resp.text)
        self.assertIn('id="docker-volumes-table"', index_resp.text)
        self.assertIn('id="docker-networks-table"', index_resp.text)
        self.assertIn('id="docker-updates-table"', index_resp.text)

        # Modals for Docker management
        self.assertIn('id="container-logs-modal"', index_resp.text)
        self.assertIn('id="container-logs-viewer"', index_resp.text)
        self.assertIn('id="stack-editor-modal"', index_resp.text)
        self.assertIn('id="stack-editor-form"', index_resp.text)
        self.assertIn('id="volume-details-modal"', index_resp.text)
        self.assertIn('id="vol-detail-name"', index_resp.text)
        self.assertIn('id="vol-detail-driver"', index_resp.text)
        self.assertIn('id="vol-detail-mountpoint"', index_resp.text)
        self.assertIn('id="vol-detail-containers"', index_resp.text)
        self.assertIn('id="close-volume-details-btn"', index_resp.text)

        # Timezone selector in settings modal
        self.assertIn('id="setting-timezone"', index_resp.text)

        # Notifications tab ('Notifications'), view panels, and Discord setup card
        self.assertIn('id="discord-config-form"', index_resp.text)
        self.assertIn('id="save-discord-btn"', index_resp.text)
        self.assertIn('id="send-test-notification-btn"', index_resp.text)
        self.assertIn('id="discord-feedback"', index_resp.text)
        self.assertIn('id="discord-status-badge"', index_resp.text)
        self.assertIn('id="discord-channel-input"', index_resp.text)
        self.assertIn('id="discord-token-input"', index_resp.text)
        self.assertIn('id="discord-enabled-toggle"', index_resp.text)
        self.assertIn('name="discord_enabled"', index_resp.text)

        # Sysfs RAID rebuild progress, direct stream indicator, and toast notifications
        self.assertIn('id="raid-sync-container"', index_resp.text)
        self.assertIn('id="raid-sync-label"', index_resp.text)
        self.assertIn('id="raid-sync-progress-fill"', index_resp.text)
        self.assertIn('id="live-stream-indicator"', index_resp.text)
        self.assertIn('id="toast-container"', index_resp.text)

        # Software update header notice button and update modal
        self.assertIn('id="nav-update-notice-btn"', index_resp.text)
        self.assertIn('class="update-pulse-dot"', index_resp.text)
        self.assertIn('id="nav-update-version-label"', index_resp.text)
        self.assertIn('id="update-modal"', index_resp.text)
        self.assertIn('id="close-update-modal-btn"', index_resp.text)
        self.assertIn('id="modal-current-version"', index_resp.text)
        self.assertIn('id="modal-latest-version"', index_resp.text)
        self.assertIn('id="modal-release-notes"', index_resp.text)
        self.assertIn('id="modal-update-status"', index_resp.text)
        self.assertIn('id="modal-dismiss-btn"', index_resp.text)
        self.assertIn('id="modal-apply-update-btn"', index_resp.text)
        self.assertIn('id="modal-toggle-changelog-btn"', index_resp.text)

        # Settings modal should NOT contain Discord fields
        modal_start = index_resp.text.find('id="settings-modal"')
        self.assertGreater(modal_start, -1)
        modal_end = index_resp.text.find('</form>', modal_start)
        self.assertGreater(modal_end, modal_start)
        settings_modal_html = index_resp.text[modal_start:modal_end]
        self.assertNotIn("setting-discord-token", settings_modal_html)
        self.assertNotIn("setting-channel-id", settings_modal_html)
        self.assertNotIn("setting-discord-enabled", settings_modal_html)
        self.assertNotIn('name="discord_token"', settings_modal_html)
        self.assertNotIn('name="discord_enabled"', settings_modal_html)

        css_resp = asgi_get(api.app, "/static/styles.css")
        self.assertEqual(css_resp.status_code, 200)
        self.assertIn("text/css", css_resp.headers.get("content-type", ""))
        self.assertEqual(css_resp.headers.get("cache-control"), "no-cache, must-revalidate")
        self.assertTrue(len(css_resp.text) > 0)

        js_resp = asgi_get(api.app, "/static/app.js")
        self.assertEqual(js_resp.status_code, 200)
        self.assertIn("javascript", js_resp.headers.get("content-type", ""))
        self.assertEqual(js_resp.headers.get("cache-control"), "no-cache, must-revalidate")
        self.assertTrue(len(js_resp.text) > 0)

    def test_ci_workflow_and_systemd_services_configured(self):
        repo_root = Path(__file__).resolve().parent
        workflow_file = repo_root / ".github" / "workflows" / "ci-release.yml"
        raidcheck_service = repo_root / "systemd" / "raidcheck.service"
        raidcheck_web_service = repo_root / "systemd" / "raidcheck-web.service"

        self.assertTrue(workflow_file.is_file())
        workflow_content = workflow_file.read_text(encoding="utf-8")
        self.assertIn("uv run pytest -v", workflow_content)
        self.assertIn("gh release create", workflow_content)

        self.assertTrue(raidcheck_service.is_file())
        raidcheck_content = raidcheck_service.read_text(encoding="utf-8")
        self.assertIn("WantedBy=multi-user.target", raidcheck_content)
        self.assertIn("main.py", raidcheck_content)

        self.assertTrue(raidcheck_web_service.is_file())
        raidcheck_web_content = raidcheck_web_service.read_text(encoding="utf-8")
        self.assertIn("WantedBy=multi-user.target", raidcheck_web_content)
        self.assertIn("main.py web", raidcheck_web_content)

    def test_websocket_auth_snapshot_and_refresh_actions(self):
        # 1. Unauthenticated connection attempt is closed with code 4401
        unauth_ws = asgi_ws(api.app, "/api/ws")
        self.assertEqual(unauth_ws.close_code, 4401)
        self.assertEqual(unauth_ws.messages, [])

        # 2. Authenticated connection via session_token cookie receives initial snapshot
        #    and responds to {'action': 'refresh'} and {'action': 'refresh_module', 'module': 'system'}
        main.record_notification("clean", 1700001000.0, weekly=True)
        with (
            patch.object(
                main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF_TABLE),
        ):
            ws_cookie = asgi_ws(
                api.app,
                "/api/ws",
                cookies=self.auth_cookies,
                client_messages=[
                    {"action": "refresh"},
                    {"action": "refresh_module", "module": "system"},
                ],
            )
            self.assertTrue(ws_cookie.accepted)
            self.assertEqual(len(ws_cookie.messages), 3)

            # First message: initial snapshot
            initial_snapshot = ws_cookie.messages[0]
            self.assertEqual(initial_snapshot["type"], "snapshot")
            self.assertEqual(initial_snapshot["raid"]["status"], "clean")
            self.assertIn("system", initial_snapshot)
            self.assertIsNotNone(initial_snapshot["notification_state"])
            self.assertEqual(len(initial_snapshot["history"]), 1)
            self.assertIn("version", initial_snapshot)

            # Second message: response to {'action': 'refresh'}
            refreshed_snapshot = ws_cookie.messages[1]
            self.assertEqual(refreshed_snapshot["type"], "snapshot")
            self.assertEqual(refreshed_snapshot["raid"]["array_size"], "9.31 GiB")

            # Third message: response to {'action': 'refresh_module', 'module': 'system'}
            module_msg = ws_cookie.messages[2]
            self.assertEqual(module_msg["type"], "module_update")
            self.assertEqual(module_msg["module"], "system")
            self.assertIn("cpu_percent", module_msg["system"])

            # 3. Authenticated connection via ?token= query parameter also receives snapshot
            ws_query = asgi_ws(
                api.app,
                f"/api/ws?token={self.session_token}",
            )
            self.assertTrue(ws_query.accepted)
            self.assertEqual(len(ws_query.messages), 1)
            self.assertEqual(ws_query.messages[0]["type"], "snapshot")

    def test_websocket_multi_rate_intervals_and_adaptive_raid(self):
        # 1. Test WebSocket handling 'set_intervals' and persisting to SQLite
        with (
            patch.object(
                main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF_TABLE),
        ):
            ws_set = asgi_ws(
                api.app,
                "/api/ws",
                cookies=self.auth_cookies,
                client_messages=[
                    {
                        "action": "set_intervals",
                        "intervals": {"system": 2, "raid": 30, "notifications": 120},
                    }
                ],
            )
            self.assertTrue(ws_set.accepted)
            self.assertEqual(len(ws_set.messages), 2)  # 1 snapshot, 1 intervals_updated

            intervals_msg = ws_set.messages[1]
            self.assertEqual(intervals_msg["type"], "intervals_updated")
            self.assertEqual(
                intervals_msg["refresh_intervals"],
                {"system": 2, "raid": 30, "notifications": 120, "docker": 5},
            )

            # Verify persisted in SQLite
            persisted = main.get_refresh_intervals()
            self.assertEqual(
                persisted,
                {"system": 2, "raid": 30, "notifications": 120, "docker": 5},
            )

        # 2. Test WebSocket refresh_module 'raid' when status is 'degraded' (adaptive_fast=True, effective_interval=5)
        with (
            patch.object(
                main, "check_raid_status", return_value=("degraded", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF_TABLE),
        ):
            ws_raid = asgi_ws(
                api.app,
                "/api/ws",
                cookies=self.auth_cookies,
                client_messages=[
                    {"action": "refresh_module", "module": "raid"},
                ],
            )
            self.assertTrue(ws_raid.accepted)
            self.assertEqual(len(ws_raid.messages), 2)  # snapshot, module_update

            raid_module_msg = ws_raid.messages[1]
            self.assertEqual(raid_module_msg["type"], "module_update")
            self.assertEqual(raid_module_msg["module"], "raid")
            self.assertEqual(raid_module_msg["raid"]["status"], "degraded")
            self.assertTrue(raid_module_msg["adaptive_fast"])
            self.assertEqual(raid_module_msg["effective_interval"], 5)

        # 3. Test WebSocket refresh_module 'notifications'
        main.record_notification("degraded", 1700002000.0, weekly=False)
        with (
            patch.object(
                main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF_TABLE),
        ):
            ws_notif = asgi_ws(
                api.app,
                "/api/ws",
                cookies=self.auth_cookies,
                client_messages=[
                    {"action": "refresh_module", "module": "notifications"},
                ],
            )
            self.assertTrue(ws_notif.accepted)
            self.assertEqual(len(ws_notif.messages), 2)  # snapshot, module_update

            notif_module_msg = ws_notif.messages[1]
            self.assertEqual(notif_module_msg["type"], "module_update")
            self.assertEqual(notif_module_msg["module"], "notifications")
            self.assertIn("notification_state", notif_module_msg)
            self.assertIn("history", notif_module_msg)
            self.assertGreaterEqual(len(notif_module_msg["history"]), 1)

        # 4. Test WebSocket refresh_module 'docker'
        with (
            patch.object(
                main, "check_raid_status", return_value=("clean", SAMPLE_DETAILS)
            ),
            patch.object(main, "get_duf_output", return_value=SAMPLE_DUF_TABLE),
            patch.object(
                main.docker_mgr,
                "get_status",
                return_value={"installed": True, "running": True, "version": "29.0.0"},
            ),
        ):
            ws_docker = asgi_ws(
                api.app,
                "/api/ws",
                cookies=self.auth_cookies,
                client_messages=[
                    {"action": "refresh_module", "module": "docker"},
                ],
            )
            self.assertTrue(ws_docker.accepted)
            self.assertEqual(len(ws_docker.messages), 2)  # snapshot, module_update
            snapshot_msg = ws_docker.messages[0]
            self.assertIn("docker", snapshot_msg)
            self.assertEqual(snapshot_msg["docker"]["version"], "29.0.0")

            docker_mod_msg = ws_docker.messages[1]
            self.assertEqual(docker_mod_msg["type"], "module_update")
            self.assertEqual(docker_mod_msg["module"], "docker")
            self.assertEqual(docker_mod_msg["docker"]["version"], "29.0.0")



class TestDockerBackend(unittest.TestCase):
    def setUp(self):
        main.docker_manager.invalidate_cache()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_docker.sqlite3"
        self.stacks_path = Path(self.temp_dir.name) / "stacks"
        self.db_patcher = patch.object(main, "RAID_STATE_DB", self.db_path)
        self.stacks_patcher = patch.object(main, "STACKS_DIR", self.stacks_path)
        self.dm_stacks_patcher = patch.object(
            main.docker_manager, "stacks_dir", self.stacks_path
        )
        self.db_patcher.start()
        self.stacks_patcher.start()
        self.dm_stacks_patcher.start()

        main.create_user("admin", "adminpass", email="admin@example.com")
        self.session_token = main.create_session("admin")
        self.auth_cookies = {"session_token": self.session_token}

    def tearDown(self):
        main.docker_manager.invalidate_cache()
        self.dm_stacks_patcher.stop()
        self.stacks_patcher.stop()
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_docker_endpoints_require_authentication(self):
        endpoints = [
            ("GET", "/api/docker/status"),
            ("POST", "/api/docker/install"),
            ("GET", "/api/docker/stacks"),
            ("POST", "/api/docker/stacks"),
            ("GET", "/api/docker/stacks/mystack"),
            ("POST", "/api/docker/stacks/mystack/action"),
            ("DELETE", "/api/docker/stacks/mystack"),
            ("GET", "/api/docker/containers"),
            ("POST", "/api/docker/containers/c123/action"),
            ("GET", "/api/docker/containers/c123/logs"),
            ("GET", "/api/docker/images"),
            ("POST", "/api/docker/images/pull"),
            ("DELETE", "/api/docker/images/img123"),
            ("POST", "/api/docker/images/prune"),
            ("GET", "/api/docker/volumes"),
            ("DELETE", "/api/docker/volumes/vol123"),
            ("GET", "/api/docker/networks"),
            ("DELETE", "/api/docker/networks/net123"),
            ("GET", "/api/docker/updates"),
            ("POST", "/api/docker/updates/apply"),
            ("POST", "/api/docker/updates/config"),
            ("GET", "/api/docker/updates/schedule"),
            ("POST", "/api/docker/updates/schedule"),
            ("GET", "/api/docker/volumes/testvol"),
        ]
        for method, path in endpoints:
            resp = asgi_request(api.app, method, path)
            self.assertEqual(
                resp.status_code, 401, f"Expected 401 for unauthenticated {method} {path}"
            )

    def test_docker_status_endpoint(self):
        with (
            patch.object(main.docker_manager, "is_installed", return_value=True),
            patch.object(main.docker_manager, "is_running", return_value=True),
            patch.object(main.docker_manager, "get_version", return_value="29.0.0"),
            patch.object(main.docker_manager, "get_compose_version", return_value="v2.20.0"),
            patch.object(
                main.docker_manager,
                "get_stats",
                return_value={
                    "containers": 5,
                    "running": 3,
                    "stopped": 2,
                    "images": 10,
                    "volumes": 4,
                    "networks": 3,
                    "stacks": 2,
                },
            ),
        ):
            resp = asgi_get(api.app, "/api/docker/status", cookies=self.auth_cookies)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertTrue(data["installed"])
            self.assertTrue(data["running"])
            self.assertEqual(data["version"], "29.0.0")
            self.assertEqual(data["compose_version"], "v2.20.0")
            self.assertEqual(data["stats"]["containers"], 5)
            self.assertEqual(data["stats"]["running"], 3)
            self.assertEqual(data["stats"]["stacks"], 2)

    def test_docker_install_trigger(self):
        with patch.object(
            main.docker_manager,
            "install_docker",
            return_value={"status": "installing", "message": "Docker installation triggered"},
        ):
            resp = asgi_post(api.app, "/api/docker/install", cookies=self.auth_cookies)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["status"], "installing")

    def test_docker_stacks_crud_and_actions(self):
        sample_yaml = "services:\n  web:\n    image: nginx:alpine\n"
        with (
            patch.object(main.docker_manager, "is_running", return_value=True),
            patch.object(main.docker_manager, "_run_compose", return_value=""),
        ):
            # 1. Create stack
            create_resp = asgi_post(
                api.app,
                "/api/docker/stacks",
                cookies=self.auth_cookies,
                json_body={"name": "test_stack", "compose_yaml": sample_yaml, "deploy": True},
            )
            self.assertEqual(create_resp.status_code, 200)
            self.assertTrue(create_resp.json()["success"])
            self.assertEqual(create_resp.json()["stack"]["name"], "test_stack")

            # Verify saved file
            saved_file = self.stacks_path / "test_stack" / "docker-compose.yml"
            self.assertTrue(saved_file.is_file())
            self.assertEqual(saved_file.read_text(), sample_yaml)

            # 2. List stacks
            list_resp = asgi_get(api.app, "/api/docker/stacks", cookies=self.auth_cookies)
            self.assertEqual(list_resp.status_code, 200)
            stacks = list_resp.json()["stacks"]
            self.assertEqual(len(stacks), 1)
            self.assertEqual(stacks[0]["name"], "test_stack")

            # 3. Get stack
            get_resp = asgi_get(
                api.app, "/api/docker/stacks/test_stack", cookies=self.auth_cookies
            )
            self.assertEqual(get_resp.status_code, 200)
            stack_data = get_resp.json()["stack"]
            self.assertEqual(stack_data["name"], "test_stack")
            self.assertIn("services", stack_data["compose_yaml"])

            # 4. Stack action
            action_resp = asgi_post(
                api.app,
                "/api/docker/stacks/test_stack/action",
                cookies=self.auth_cookies,
                json_body={"action": "restart"},
            )
            self.assertEqual(action_resp.status_code, 200)
            self.assertEqual(action_resp.json()["status"], "running")

            # 5. Delete stack
            del_resp = asgi_request(
                api.app,
                "DELETE",
                "/api/docker/stacks/test_stack?down=true",
                cookies=self.auth_cookies,
            )
            self.assertEqual(del_resp.status_code, 200)
            self.assertTrue(del_resp.json()["success"])

            # Verify deleted from list
            after_del_resp = asgi_get(
                api.app, "/api/docker/stacks", cookies=self.auth_cookies
            )
            self.assertEqual(len(after_del_resp.json()["stacks"]), 0)

    def test_docker_containers_list_action_logs(self):
        mock_containers = [
            {
                "id": "c123456789ab",
                "name": "web_app",
                "image": "nginx:alpine",
                "state": "running",
                "status": "Up 2 hours",
                "ports": "0.0.0.0:80->80/tcp",
                "created": "2 hours ago",
                "stack": "my_stack",
            }
        ]
        with (
            patch.object(main.docker_manager, "list_containers", return_value=mock_containers),
            patch.object(
                main.docker_manager,
                "execute_container_action",
                return_value={"success": True, "action": "stop", "id": "c123456789ab"},
            ),
            patch.object(
                main.docker_manager,
                "get_container_logs",
                return_value="[INFO] Server started\n[INFO] Ready for connections\n",
            ),
        ):
            # List containers
            c_resp = asgi_get(api.app, "/api/docker/containers", cookies=self.auth_cookies)
            self.assertEqual(c_resp.status_code, 200)
            self.assertEqual(len(c_resp.json()["containers"]), 1)
            self.assertEqual(c_resp.json()["containers"][0]["name"], "web_app")

            # Container action
            act_resp = asgi_post(
                api.app,
                "/api/docker/containers/c123456789ab/action",
                cookies=self.auth_cookies,
                json_body={"action": "stop"},
            )
            self.assertEqual(act_resp.status_code, 200)
            self.assertTrue(act_resp.json()["success"])

            # Container logs
            log_resp = asgi_get(
                api.app,
                "/api/docker/containers/c123456789ab/logs?tail=50",
                cookies=self.auth_cookies,
            )
            self.assertEqual(log_resp.status_code, 200)
            self.assertIn("Server started", log_resp.json()["logs"])

    def test_docker_images_volumes_networks(self):
        with (
            patch.object(
                main.docker_manager,
                "list_images",
                return_value=[
                    {"id": "img1", "repository": "nginx", "tag": "alpine", "size": "20MB", "created": "1d"}
                ],
            ),
            patch.object(
                main.docker_manager,
                "pull_image",
                return_value={"success": True, "image": "redis:alpine", "output": "Downloaded"},
            ),
            patch.object(
                main.docker_manager,
                "remove_image",
                return_value={"success": True, "id": "img1", "output": "Deleted"},
            ),
            patch.object(
                main.docker_manager,
                "prune_images",
                return_value={"success": True, "output": "Total reclaimed: 10MB"},
            ),
            patch.object(
                main.docker_manager,
                "list_volumes",
                return_value=[
                    {"name": "vol1", "driver": "local", "scope": "local", "mountpoint": "/var/vol1", "created_at": "1d", "size": "100MB"}
                ],
            ),
            patch.object(
                main.docker_manager,
                "remove_volume",
                return_value={"success": True, "name": "vol1", "output": "Deleted"},
            ),
            patch.object(
                main.docker_manager,
                "list_networks",
                return_value=[
                    {"id": "net1", "name": "bridge", "driver": "bridge", "scope": "local", "internal": "false", "created_at": "1d"}
                ],
            ),
            patch.object(
                main.docker_manager,
                "remove_network",
                return_value={"success": True, "id": "net1", "output": "Deleted"},
            ),
        ):
            # Images
            imgs_resp = asgi_get(api.app, "/api/docker/images", cookies=self.auth_cookies)
            self.assertEqual(imgs_resp.status_code, 200)
            self.assertEqual(len(imgs_resp.json()["images"]), 1)

            pull_resp = asgi_post(
                api.app,
                "/api/docker/images/pull",
                cookies=self.auth_cookies,
                json_body={"image": "redis:alpine"},
            )
            self.assertEqual(pull_resp.status_code, 200)
            self.assertTrue(pull_resp.json()["success"])

            del_img_resp = asgi_request(
                api.app, "DELETE", "/api/docker/images/img1", cookies=self.auth_cookies
            )
            self.assertEqual(del_img_resp.status_code, 200)

            prune_resp = asgi_post(
                api.app, "/api/docker/images/prune", cookies=self.auth_cookies
            )
            self.assertEqual(prune_resp.status_code, 200)

            # Volumes
            vols_resp = asgi_get(api.app, "/api/docker/volumes", cookies=self.auth_cookies)
            self.assertEqual(vols_resp.status_code, 200)
            self.assertEqual(len(vols_resp.json()["volumes"]), 1)

            del_vol_resp = asgi_request(
                api.app, "DELETE", "/api/docker/volumes/vol1", cookies=self.auth_cookies
            )
            self.assertEqual(del_vol_resp.status_code, 200)

            # Networks
            nets_resp = asgi_get(api.app, "/api/docker/networks", cookies=self.auth_cookies)
            self.assertEqual(nets_resp.status_code, 200)
            self.assertEqual(len(nets_resp.json()["networks"]), 1)

            del_net_resp = asgi_request(
                api.app, "DELETE", "/api/docker/networks/net1", cookies=self.auth_cookies
            )
            self.assertEqual(del_net_resp.status_code, 200)

    def test_docker_updates_flow(self):
        with (
            patch.object(
                main.docker_manager,
                "check_updates",
                return_value={
                    "updates": [
                        {
                            "container_id": "c1",
                            "container_name": "app",
                            "image": "nginx:alpine",
                            "stack": "",
                            "update_available": True,
                            "current_id": "aaa",
                            "latest_id": "bbb",
                        }
                    ],
                    "config": {"frequency": "daily"},
                },
            ),
            patch.object(
                main.docker_manager,
                "apply_updates",
                return_value={"success": True, "updated": [{"type": "container", "id": "c1", "name": "app", "success": True}]},
            ),
        ):
            # Check updates
            chk_resp = asgi_get(api.app, "/api/docker/updates", cookies=self.auth_cookies)
            self.assertEqual(chk_resp.status_code, 200)
            self.assertEqual(len(chk_resp.json()["updates"]), 1)
            self.assertTrue(chk_resp.json()["updates"][0]["update_available"])

            # Apply updates
            apply_resp = asgi_post(
                api.app,
                "/api/docker/updates/apply",
                cookies=self.auth_cookies,
                json_body={"containers": ["c1"]},
            )
            self.assertEqual(apply_resp.status_code, 200)
            self.assertTrue(apply_resp.json()["success"])

            # Configure auto updates
            cfg_resp = asgi_post(
                api.app,
                "/api/docker/updates/config",
                cookies=self.auth_cookies,
                json_body={"frequency": "hourly"},
            )
            self.assertEqual(cfg_resp.status_code, 200)
            self.assertEqual(cfg_resp.json()["frequency"], "hourly")
            self.assertEqual(
                main.get_app_settings().get("docker_auto_update_frequency"), "hourly"
            )

    def test_docker_error_handling_and_validation(self):
        # 1. Invalid stack action
        bad_stack_act = asgi_post(
            api.app,
            "/api/docker/stacks/mystack/action",
            cookies=self.auth_cookies,
            json_body={"action": "invalid_action"},
        )
        self.assertEqual(bad_stack_act.status_code, 400)

        # 2. Invalid container action
        bad_c_act = asgi_post(
            api.app,
            "/api/docker/containers/c123/action",
            cookies=self.auth_cookies,
            json_body={"action": "explode"},
        )
        self.assertEqual(bad_c_act.status_code, 400)

        # 3. Invalid auto update config frequency
        bad_freq = asgi_post(
            api.app,
            "/api/docker/updates/config",
            cookies=self.auth_cookies,
            json_body={"frequency": "every_minute"},
        )
        self.assertEqual(bad_freq.status_code, 400)

        # 4. Empty image pull
        bad_pull = asgi_post(
            api.app,
            "/api/docker/images/pull",
            cookies=self.auth_cookies,
            json_body={"image": ""},
        )
        self.assertEqual(bad_pull.status_code, 400)

        # 5. Nonexistent stack returns 404
        missing_stack = asgi_get(
            api.app,
            "/api/docker/stacks/nonexistent_stack",
            cookies=self.auth_cookies,
        )
        self.assertEqual(missing_stack.status_code, 404)

        # 6. Docker daemon stopped returns 500 on actions and empty list on container queries
        with patch.object(main.docker_manager, "is_running", return_value=False):
            c_resp = asgi_get(api.app, "/api/docker/containers", cookies=self.auth_cookies)
            self.assertEqual(c_resp.status_code, 200)
            self.assertEqual(c_resp.json()["containers"], [])

            stopped_act = asgi_post(
                api.app,
                "/api/docker/containers/c1/action",
                cookies=self.auth_cookies,
                json_body={"action": "start"},
            )
            self.assertEqual(stopped_act.status_code, 500)

            # Docker daemon stopped on image pull
            stopped_pull = asgi_post(
                api.app,
                "/api/docker/images/pull",
                cookies=self.auth_cookies,
                json_body={"image": "redis:latest"},
            )
            self.assertEqual(stopped_pull.status_code, 500)

            # Docker daemon stopped on image remove
            stopped_del_img = asgi_request(
                api.app,
                "DELETE",
                "/api/docker/images/img123",
                cookies=self.auth_cookies,
            )
            self.assertEqual(stopped_del_img.status_code, 500)

            # Docker daemon stopped on volume remove
            stopped_del_vol = asgi_request(
                api.app,
                "DELETE",
                "/api/docker/volumes/vol123",
                cookies=self.auth_cookies,
            )
            self.assertEqual(stopped_del_vol.status_code, 500)

            # Docker daemon stopped on network remove
            stopped_del_net = asgi_request(
                api.app,
                "DELETE",
                "/api/docker/networks/net123",
                cookies=self.auth_cookies,
            )
            self.assertEqual(stopped_del_net.status_code, 500)

            # Docker daemon stopped on stack create with deploy=True
            stopped_deploy_stack = asgi_post(
                api.app,
                "/api/docker/stacks",
                cookies=self.auth_cookies,
                json_body={"name": "stopstack", "compose_yaml": "services:\n  a:\n    image: b\n", "deploy": True},
            )
            self.assertEqual(stopped_deploy_stack.status_code, 500)

            # Docker daemon stopped on stack action
            stopped_stack_act = asgi_post(
                api.app,
                "/api/docker/stacks/somestack/action",
                cookies=self.auth_cookies,
                json_body={"action": "start"},
            )
            self.assertEqual(stopped_stack_act.status_code, 500)

            # Docker daemon stopped on container logs
            stopped_logs = asgi_get(
                api.app,
                "/api/docker/containers/c123/logs",
                cookies=self.auth_cookies,
            )
            self.assertEqual(stopped_logs.status_code, 500)

            # Docker daemon stopped on apply updates
            stopped_apply = asgi_post(
                api.app,
                "/api/docker/updates/apply",
                cookies=self.auth_cookies,
                json_body={"containers": ["c1"]},
            )
            self.assertEqual(stopped_apply.status_code, 500)

            # Queries return empty lists when stopped
            self.assertEqual(asgi_get(api.app, "/api/docker/images", cookies=self.auth_cookies).json()["images"], [])
            self.assertEqual(asgi_get(api.app, "/api/docker/volumes", cookies=self.auth_cookies).json()["volumes"], [])
            self.assertEqual(asgi_get(api.app, "/api/docker/networks", cookies=self.auth_cookies).json()["networks"], [])
            self.assertEqual(asgi_get(api.app, "/api/docker/updates", cookies=self.auth_cookies).json()["updates"], [])

    def test_docker_install_failure_handling(self):
        with patch.object(
            main.docker_manager,
            "install_docker",
            side_effect=RuntimeError("Apt repository unreachable"),
        ):
            resp = asgi_post(api.app, "/api/docker/install", cookies=self.auth_cookies)
            self.assertEqual(resp.status_code, 500)
            self.assertIn("Apt repository unreachable", resp.json()["detail"])

    def test_docker_stack_name_validation_errors(self):
        # Invalid stack names: spaces, special characters, empty
        for bad_name in ["", "   ", "my stack", "stack!@#", "stack/slash"]:
            resp = asgi_post(
                api.app,
                "/api/docker/stacks",
                cookies=self.auth_cookies,
                json_body={"name": bad_name, "compose_yaml": "services:\n  a:\n    image: b", "deploy": False},
            )
            self.assertEqual(resp.status_code, 400, f"Expected 400 for bad name: {bad_name!r}")

        # Empty compose yaml
        resp_empty_yaml = asgi_post(
            api.app,
            "/api/docker/stacks",
            cookies=self.auth_cookies,
            json_body={"name": "validname", "compose_yaml": "   ", "deploy": False},
        )
        self.assertEqual(resp_empty_yaml.status_code, 400)

    def test_docker_stack_not_found_on_action(self):
        with patch.object(main.docker_manager, "is_running", return_value=True):
            resp = asgi_post(
                api.app,
                "/api/docker/stacks/nonexistent/action",
                cookies=self.auth_cookies,
                json_body={"action": "restart"},
            )
            self.assertEqual(resp.status_code, 404)

    def test_docker_apply_updates_with_stacks_and_containers(self):
        with (
            patch.object(main.docker_manager, "is_running", return_value=True),
            patch.object(main.docker_manager, "execute_stack_action", return_value={"success": True}),
            patch.object(main.docker_manager, "list_containers", return_value=[
                {"id": "c1", "name": "my_container", "image": "redis:alpine", "stack": "mystack"}
            ]),
            patch.object(main.docker_manager, "pull_image", return_value={"success": True}),
        ):
            resp = asgi_post(
                api.app,
                "/api/docker/updates/apply",
                cookies=self.auth_cookies,
                json_body={"containers": ["c1"], "stacks": ["mystack"]},
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertTrue(data["success"])
            self.assertEqual(len(data["updated"]), 2)
            self.assertEqual(data["updated"][0]["type"], "stack")
            self.assertEqual(data["updated"][1]["type"], "container")

    def test_docker_apply_updates_handles_failures(self):
        with (
            patch.object(main.docker_manager, "is_running", return_value=True),
            patch.object(
                main.docker_manager,
                "execute_stack_action",
                side_effect=RuntimeError("Compose failed"),
            ),
        ):
            resp = asgi_post(
                api.app,
                "/api/docker/updates/apply",
                cookies=self.auth_cookies,
                json_body={"stacks": ["failing_stack"]},
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertTrue(data["success"])
            self.assertFalse(data["updated"][0]["success"])
            self.assertIn("Compose failed", data["updated"][0]["error"])

    def test_external_stack_protection(self):
        external_stack_info = {
            "name": "ext_stack",
            "compose_yaml": "services:\n  ext:\n    image: ext:latest\n",
            "status": "running",
            "managed": False,
            "created_at": 0.0,
            "updated_at": 0.0,
            "containers": [],
        }

        with (
            patch.object(main.docker_manager, "is_running", return_value=True),
            patch.object(
                main.docker_manager,
                "get_stack",
                side_effect=lambda name: external_stack_info if name == "ext_stack" else None,
            ),
        ):
            # 1. Direct method calls raise ValueError with exact required messages
            with self.assertRaises(ValueError) as ctx_save:
                main.docker_manager.save_stack("ext_stack", "services:\n  x:\n    image: y\n")
            self.assertEqual(
                str(ctx_save.exception),
                "Stack is managed externally and cannot be edited in SystemAlerts",
            )

            with self.assertRaises(ValueError) as ctx_del:
                main.docker_manager.delete_stack("ext_stack")
            self.assertEqual(
                str(ctx_del.exception),
                "Stack is managed externally and cannot be deleted",
            )

            with self.assertRaises(ValueError) as ctx_act:
                main.docker_manager.execute_stack_action("ext_stack", "restart")
            self.assertEqual(
                str(ctx_act.exception),
                "Stack is managed externally. Stack actions cannot be executed from SystemAlerts; manage constituent containers directly",
            )

            # 2. HTTP POST /api/docker/stacks returns 400
            post_resp = asgi_post(
                api.app,
                "/api/docker/stacks",
                cookies=self.auth_cookies,
                json_body={
                    "name": "ext_stack",
                    "compose_yaml": "services:\n  x:\n    image: y\n",
                    "deploy": False,
                },
            )
            self.assertEqual(post_resp.status_code, 400)
            self.assertEqual(
                post_resp.json()["detail"],
                "Stack is managed externally and cannot be edited in SystemAlerts",
            )

            # 3. HTTP PUT /api/docker/stacks/ext_stack returns 400
            put_resp = asgi_request(
                api.app,
                "PUT",
                "/api/docker/stacks/ext_stack",
                cookies=self.auth_cookies,
                json_body={
                    "name": "ext_stack",
                    "compose_yaml": "services:\n  x:\n    image: y\n",
                    "deploy": False,
                },
            )
            self.assertEqual(put_resp.status_code, 400)
            self.assertEqual(
                put_resp.json()["detail"],
                "Stack is managed externally and cannot be edited in SystemAlerts",
            )

            # 4. HTTP DELETE /api/docker/stacks/ext_stack returns 400
            del_resp = asgi_request(
                api.app,
                "DELETE",
                "/api/docker/stacks/ext_stack",
                cookies=self.auth_cookies,
            )
            self.assertEqual(del_resp.status_code, 400)
            self.assertEqual(
                del_resp.json()["detail"],
                "Stack is managed externally and cannot be deleted",
            )

            # 5. HTTP POST /api/docker/stacks/ext_stack/action returns 400
            act_resp = asgi_post(
                api.app,
                "/api/docker/stacks/ext_stack/action",
                cookies=self.auth_cookies,
                json_body={"action": "start"},
            )
            self.assertEqual(act_resp.status_code, 400)
            self.assertEqual(
                act_resp.json()["detail"],
                "Stack is managed externally. Stack actions cannot be executed from SystemAlerts; manage constituent containers directly",
            )

    def test_clean_docker_error_formatting(self):
        raw_error = (
            "[+] Pulling 3/3\n"
            " 7b229517ed22: Pulling fs layer\n"
            " 3da1513d2124: Downloading [===>     ]  1.049MB/3.853MB\n"
            " 3ec36f3670df: Extracting 100%\n"
            " 7b229517ed22: Download complete\n"
            " 7b229517ed22: Pull complete\n"
            "Digest: sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a\n"
            "Status: Downloaded newer image for nginx:alpine\n"
            "WARNG[0000] the attribute `version` is obsolete, it will be ignored, please remove it to avoid potential confusion\n"
            "Error response from daemon: Bind for 0.0.0.0:80 failed: port is already allocated\n"
        )
        cleaned = main._clean_docker_error(raw_error)
        self.assertEqual(
            cleaned,
            "Error response from daemon: Bind for 0.0.0.0:80 failed: port is already allocated",
        )

        # Test _run_cmd surfaces cleaned error when CalledProcessError occurs
        cpe = CalledProcessError(1, ["docker", "compose", "up"], stderr=raw_error)
        with patch("subprocess.run", side_effect=cpe):
            with self.assertRaises(RuntimeError) as ctx:
                main.docker_manager._run_cmd(["docker", "compose", "up"])
            self.assertEqual(
                str(ctx.exception),
                "Error response from daemon: Bind for 0.0.0.0:80 failed: port is already allocated",
            )

    def test_volume_enhanced_listing_and_inspection(self):
        def fake_run_docker(args, timeout=30):
            if args[:2] == ["volume", "ls"]:
                return (
                    '{"Name": "data_vol", "Driver": "local", "Scope": "local", '
                    '"Mountpoint": "/var/lib/docker/volumes/data_vol/_data", "CreatedAt": "2026-10-28"}\n'
                )
            if args[:3] == ["system", "df", "-v"]:
                return json.dumps(
                    {
                        "Volumes": [
                            {
                                "Name": "data_vol",
                                "Size": "145MB",
                                "Mountpoint": "/var/lib/docker/volumes/data_vol/_data",
                            }
                        ]
                    }
                )
            if args[:3] == ["ps", "-a", "-q"]:
                return "cid1\n"
            if args[:2] == ["inspect", "--format"] and "cid1" in args:
                return '{"name": "/my_web_app", "mounts": [{"Type": "volume", "Name": "data_vol"}]}\n'
            if args[:2] == ["volume", "inspect"] and "data_vol" in args:
                return json.dumps(
                    [
                        {
                            "Name": "data_vol",
                            "Driver": "local",
                            "Scope": "local",
                            "Mountpoint": "/var/lib/docker/volumes/data_vol/_data",
                            "CreatedAt": "2026-10-28T00:00:00Z",
                            "Labels": {"env": "prod"},
                            "Options": None,
                        }
                    ]
                )
            if args[:2] == ["volume", "inspect"] and "nonexistent" in args:
                raise RuntimeError("Error response from daemon: get nonexistent: no such volume")
            return ""

        with (
            patch.object(main.docker_manager, "is_running", return_value=True),
            patch.object(main.docker_manager, "_run_docker", side_effect=fake_run_docker),
        ):
            # 1. Enhanced list_volumes
            vols_resp = asgi_get(api.app, "/api/docker/volumes", cookies=self.auth_cookies)
            self.assertEqual(vols_resp.status_code, 200)
            vols = vols_resp.json()["volumes"]
            self.assertEqual(len(vols), 1)
            v0 = vols[0]
            self.assertEqual(v0["name"], "data_vol")
            self.assertEqual(v0["size"], "145MB")
            self.assertEqual(v0["mountpoint"], "/var/lib/docker/volumes/data_vol/_data")
            self.assertEqual(v0["containers"], ["my_web_app"])

            # 2. Volume inspect endpoint
            inspect_resp = asgi_get(
                api.app, "/api/docker/volumes/data_vol", cookies=self.auth_cookies
            )
            self.assertEqual(inspect_resp.status_code, 200)
            inv = inspect_resp.json()
            self.assertEqual(inv["name"], "data_vol")
            self.assertEqual(inv["size"], "145MB")
            self.assertEqual(inv["driver"], "local")
            self.assertEqual(inv["scope"], "local")
            self.assertEqual(inv["mountpoint"], "/var/lib/docker/volumes/data_vol/_data")
            self.assertEqual(inv["containers"], ["my_web_app"])
            self.assertEqual(inv["labels"], {"env": "prod"})

            # 3. Nonexistent volume inspect returns 404
            missing_resp = asgi_get(
                api.app, "/api/docker/volumes/nonexistent", cookies=self.auth_cookies
            )
            self.assertEqual(missing_resp.status_code, 404)

    def test_docker_update_schedule_flow_and_checker(self):
        # 1. GET schedule returns defaults
        get_resp = asgi_get(
            api.app, "/api/docker/updates/schedule", cookies=self.auth_cookies
        )
        self.assertEqual(get_resp.status_code, 200)
        sched = get_resp.json()["schedule"]
        self.assertFalse(sched["enabled"])
        self.assertEqual(sched["day"], "daily")
        self.assertEqual(sched["time"], "03:00")
        self.assertTrue(sched["notify_discord"])

        # 2. POST with invalid day / time returns 400
        bad_day = asgi_post(
            api.app,
            "/api/docker/updates/schedule",
            cookies=self.auth_cookies,
            json_body={"day": "someday", "time": "03:00"},
        )
        self.assertEqual(bad_day.status_code, 400)

        bad_time = asgi_post(
            api.app,
            "/api/docker/updates/schedule",
            cookies=self.auth_cookies,
            json_body={"day": "daily", "time": "25:61"},
        )
        self.assertEqual(bad_time.status_code, 400)

        # 3. POST valid schedule
        ok_resp = asgi_post(
            api.app,
            "/api/docker/updates/schedule",
            cookies=self.auth_cookies,
            json_body={
                "enabled": True,
                "day": "monday",
                "time": "04:15",
                "notify_discord": False,
            },
        )
        self.assertEqual(ok_resp.status_code, 200)
        saved = ok_resp.json()["schedule"]
        self.assertTrue(saved["enabled"])
        self.assertEqual(saved["day"], "monday")
        self.assertEqual(saved["time"], "04:15")
        self.assertFalse(saved["notify_discord"])

        # 4. should_run_scheduled_docker_update
        # Monday at 04:15 -> Matches! (2026-10-26 was a Monday)
        monday_dt = datetime(2026, 10, 26, 4, 15, 0)
        self.assertTrue(main.should_run_scheduled_docker_update(monday_dt))

        # Tuesday at 04:15 -> Day mismatch -> False
        tuesday_dt = datetime(2026, 10, 27, 4, 15, 0)
        self.assertFalse(main.should_run_scheduled_docker_update(tuesday_dt))

        # Monday at 04:16 -> Time mismatch -> False
        monday_wrong_time = datetime(2026, 10, 26, 4, 16, 0)
        self.assertFalse(main.should_run_scheduled_docker_update(monday_wrong_time))

        # Disabled schedule -> False
        main.set_docker_auto_update_schedule({"enabled": False, "day": "monday", "time": "04:15"})
        self.assertFalse(main.should_run_scheduled_docker_update(monday_dt))

        # 5. run_scheduled_docker_updates execution
        main.set_docker_auto_update_schedule({"enabled": True, "day": "daily", "time": "03:00", "notify_discord": True})
        target_dt = datetime(2026, 10, 28, 3, 0, 0)
        with (
            patch.object(main.docker_manager, "apply_updates", return_value={"success": True, "updated": [{"type": "container", "name": "c1", "success": True}]}),
            patch.object(main, "send_message", new=AsyncMock(return_value=True)) as mock_send,
        ):
            res = asyncio.run(main.run_scheduled_docker_updates(now_dt=target_dt))
            self.assertTrue(res["executed"])
            mock_send.assert_awaited_once()

            # Calling again in the same minute should not re-run (duplicate prevention)
            res_dup = asyncio.run(main.run_scheduled_docker_updates(now_dt=target_dt))
            self.assertFalse(res_dup["executed"])

    def test_timezone_settings_and_status(self):
        # 1. Default timezone in settings is UTC
        get_resp = asgi_get(api.app, "/api/settings", cookies=self.auth_cookies)
        self.assertEqual(get_resp.status_code, 200)
        self.assertEqual(get_resp.json().get("timezone"), "UTC")

        # 2. Update timezone via POST /api/settings
        post_resp = asgi_post(
            api.app,
            "/api/settings",
            cookies=self.auth_cookies,
            json_body={"timezone": "America/New_York"},
        )
        self.assertEqual(post_resp.status_code, 200)
        self.assertEqual(post_resp.json().get("timezone"), "America/New_York")

        # 3. GET /api/status surfaces timezone globally
        status_resp = asgi_get(api.app, "/api/status", cookies=self.auth_cookies)
        self.assertEqual(status_resp.status_code, 200)
        self.assertEqual(status_resp.json().get("timezone"), "America/New_York")
        self.assertEqual(status_resp.json().get("settings", {}).get("timezone"), "America/New_York")

    def test_docker_cache_and_invalidation(self):
        call_count = {"ps": 0}

        def fake_run_docker(args, timeout=30):
            if "ps" in args:
                call_count["ps"] += 1
                return (
                    '{"ID": "c1", "Names": "web", "Image": "nginx", "State": "running", "Status": "Up 1m", "Labels": ""}\n'
                )
            if "info" in args:
                return "24.0.0"
            if "version" in args:
                return "24.0.0"
            if "compose" in args:
                return "v2.20.0"
            return ""

        with (
            patch.object(main.docker_manager, "is_running", return_value=True),
            patch.object(main.docker_manager, "_run_docker", side_effect=fake_run_docker),
        ):
            # 1. First call populates cache
            c1 = main.docker_manager.list_containers(all=True)
            self.assertEqual(len(c1), 1)
            self.assertEqual(call_count["ps"], 1)

            # 2. Second call within TTL uses cache (no subprocess call)
            c2 = main.docker_manager.list_containers(all=True)
            self.assertEqual(len(c2), 1)
            self.assertEqual(call_count["ps"], 1)

            # 3. bypass_cache=True forces re-fetch
            c3 = main.docker_manager.list_containers(all=True, bypass_cache=True)
            self.assertEqual(len(c3), 1)
            self.assertEqual(call_count["ps"], 2)

            # 4. Invalidation clears cache
            main.docker_manager.invalidate_cache()
            c4 = main.docker_manager.list_containers(all=True)
            self.assertEqual(len(c4), 1)
            self.assertEqual(call_count["ps"], 3)

            # 5. Mutation actions invalidate cache
            with patch.object(main.docker_manager, "_run_docker", return_value=""):
                main.docker_manager.execute_container_action("c1", "restart")
            # Next call should fetch again
            c5 = main.docker_manager.list_containers(all=True)
            self.assertEqual(len(c5), 1)
            self.assertEqual(call_count["ps"], 4)

    def test_docker_concurrent_stats_and_fallback(self):
        def fake_run_docker(args, timeout=30):
            if "images" in args:
                return "img1\nimg2\nimg3\n"
            if "volume" in args:
                return "vol1\nvol2\n"
            if "network" in args:
                raise RuntimeError("Network daemon unresponsive")
            return ""

        with (
            patch.object(main.docker_manager, "is_running", return_value=True),
            patch.object(
                main.docker_manager,
                "list_containers",
                return_value=[
                    {"id": "c1", "name": "c1", "state": "running", "status": "Up"},
                    {"id": "c2", "name": "c2", "state": "exited", "status": "Exited"},
                ],
            ),
            patch.object(main.docker_manager, "list_stacks", return_value=[{"name": "s1"}]),
            patch.object(main.docker_manager, "_run_docker", side_effect=fake_run_docker),
        ):
            stats = main.docker_manager.get_stats(bypass_cache=True)
            self.assertEqual(stats["containers"], 2)
            self.assertEqual(stats["running"], 1)
            self.assertEqual(stats["stopped"], 1)
            self.assertEqual(stats["images"], 3)
            self.assertEqual(stats["volumes"], 2)
            # The failing network inspection gracefully falls back to 0 without crashing
            self.assertEqual(stats["networks"], 0)
            self.assertEqual(stats["stacks"], 1)

    def test_docker_async_routes_and_websocket_update(self):
        with (
            patch.object(main.docker_manager, "is_installed", return_value=True),
            patch.object(main.docker_manager, "is_running", return_value=True),
            patch.object(main.docker_manager, "get_version", return_value="29.0.0"),
            patch.object(main.docker_manager, "get_compose_version", return_value="v2.20.0"),
            patch.object(
                main.docker_manager,
                "get_stats",
                return_value={
                    "containers": 1,
                    "running": 1,
                    "stopped": 0,
                    "images": 1,
                    "volumes": 1,
                    "networks": 1,
                    "stacks": 0,
                },
            ),
        ):
            # Test direct async endpoint
            resp = asgi_get(api.app, "/api/docker/status", cookies=self.auth_cookies)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["version"], "29.0.0")

            # Test async module update helper
            update = asyncio.run(api._build_module_update("docker"))
            self.assertEqual(update["type"], "module_update")
            self.assertEqual(update["module"], "docker")
            self.assertEqual(update["docker"]["version"], "29.0.0")

    def test_docker_cache_ttl_and_deep_copy_isolation(self):
        """Verify that cache respects TTL expiration and deep copies prevent in-place mutation."""
        mgr = main.DockerManager(stacks_dir=self.stacks_path, cache_ttl=0.2)
        base_time = 1000.0

        with (
            patch.object(mgr, "is_running", return_value=True),
            patch.object(
                mgr,
                "_run_docker",
                return_value='{"ID": "c1", "Names": "app", "State": "running"}\n',
            ),
        ):
            with patch("time.time", return_value=base_time):
                c1 = mgr.list_containers(all=True)
                self.assertEqual(len(c1), 1)
                self.assertEqual(c1[0]["name"], "app")

                # Test deep copy isolation: mutating c1 should not affect cached object
                c1[0]["name"] = "mutated_value"
                c2 = mgr.list_containers(all=True)
                self.assertEqual(c2[0]["name"], "app")

            # Fast forward time beyond TTL (0.2s)
            with (
                patch("time.time", return_value=base_time + 0.3),
                patch.object(
                    mgr,
                    "_run_docker",
                    return_value='{"ID": "c2", "Names": "new_app", "State": "running"}\n',
                ) as mock_run,
            ):
                c3 = mgr.list_containers(all=True)
                self.assertEqual(len(c3), 1)
                self.assertEqual(c3[0]["name"], "new_app")
                mock_run.assert_called_once()

    def test_docker_mutations_invalidate_cache(self):
        """Verify all mutation operations properly invalidate DockerManager cache."""
        mgr = main.DockerManager(stacks_dir=self.stacks_path, cache_ttl=10.0)
        mgr._set_cache("status", {"test": 123})
        mgr._set_cache("containers_True", [{"id": "c1"}])

        self.assertIsNotNone(mgr._get_cached("status"))

        # 1. pull_image
        with patch.object(mgr, "is_running", return_value=True), patch.object(
            mgr, "_run_docker", return_value="pulled"
        ):
            mgr.pull_image("redis:alpine")
            self.assertIsNone(mgr._get_cached("status"))

        # Re-prime cache and test remove_image
        mgr._set_cache("status", {"test": 123})
        with patch.object(mgr, "is_running", return_value=True), patch.object(
            mgr, "_run_docker", return_value="deleted"
        ):
            mgr.remove_image("img123")
            self.assertIsNone(mgr._get_cached("status"))

        # Re-prime cache and test prune_images
        mgr._set_cache("status", {"test": 123})
        with patch.object(mgr, "is_running", return_value=True), patch.object(
            mgr, "_run_docker", return_value="pruned"
        ):
            mgr.prune_images()
            self.assertIsNone(mgr._get_cached("status"))

        # Re-prime cache and test remove_volume
        mgr._set_cache("status", {"test": 123})
        with patch.object(mgr, "is_running", return_value=True), patch.object(
            mgr, "_run_docker", return_value="removed"
        ):
            mgr.remove_volume("vol123")
            self.assertIsNone(mgr._get_cached("status"))

        # Re-prime cache and test remove_network
        mgr._set_cache("status", {"test": 123})
        with patch.object(mgr, "is_running", return_value=True), patch.object(
            mgr, "_run_docker", return_value="removed"
        ):
            mgr.remove_network("net123")
            self.assertIsNone(mgr._get_cached("status"))

    def test_docker_not_running_stats_fast_path(self):
        """Verify get_stats immediately returns zeros when daemon is not running without running threadpool."""
        mgr = main.DockerManager(stacks_dir=self.stacks_path)
        with patch.object(mgr, "is_running", return_value=False):
            stats = mgr.get_stats()
            self.assertEqual(
                stats,
                {
                    "containers": 0,
                    "running": 0,
                    "stopped": 0,
                    "images": 0,
                    "volumes": 0,
                    "networks": 0,
                    "stacks": 0,
                },
            )


class DirectSystemStreamsTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_streams.sqlite3"
        self.db_patcher = patch.object(main, "RAID_STATE_DB", self.db_path)
        self.db_patcher.start()

        # Seed test user and session
        main.create_user("admin", "adminpass", email="admin@example.com")
        self.session_token = main.create_session("admin")
        self.auth_cookies = {"session_token": self.session_token}

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

    def test_statvfs_disk_usage_calculation_and_formatting(self):
        stat_mock = MagicMock()
        stat_mock.f_frsize = 4096
        stat_mock.f_blocks = 268435456  # 1 TiB
        stat_mock.f_bfree = 134217728   # 512 GiB free
        stat_mock.f_bavail = 134217728  # 512 GiB avail

        with patch("os.statvfs", return_value=stat_mock):
            res = main.get_disk_usage_statvfs("/mnt/test")
            self.assertEqual(res["total"], 268435456 * 4096)
            self.assertEqual(res["free"], 134217728 * 4096)
            self.assertEqual(res["used"], (268435456 - 134217728) * 4096)
            self.assertEqual(res["percent"], 50.0)
            self.assertEqual(res["total_human"], "1.00T")
            self.assertEqual(res["used_human"], "512.00G")
            self.assertEqual(res["free_human"], "512.00G")
            self.assertIn("512.00G/1.00T (50.0%)", res["storage_info"])

        # Error branch
        with patch("os.statvfs", side_effect=OSError("Drive offline")):
            err_res = main.get_disk_usage_statvfs("/mnt/missing")
            self.assertEqual(err_res["total"], 0)
            self.assertEqual(err_res["percent"], 0.0)
            self.assertEqual(err_res["storage_info"], "N/A")

    def test_extract_raid_summary_data_with_statvfs_fallback(self):
        with (
            patch.object(main, "get_app_settings", return_value={"mount_path": "/mnt/test"}),
            patch("os.path.exists", return_value=True),
            patch.object(
                main,
                "get_disk_usage_statvfs",
                return_value={"storage_info": "1.00T/2.00T (50.0%) | 1.00T free"},
            ),
        ):
            data = main.extract_raid_summary_data("clean", SAMPLE_DETAILS, duf_output="")
            self.assertEqual(data["storage_info"], "1.00T/2.00T (50.0%) | 1.00T free")

    def test_read_sysfs_raid_state_branches(self):
        sysfs_base = Path(self.temp_dir.name) / "sys_block"
        md0_dir = sysfs_base / "md0" / "md"
        md0_dir.mkdir(parents=True, exist_ok=True)

        # 1. Clean array
        (md0_dir / "array_state").write_text("clean\n", encoding="utf-8")
        (md0_dir / "degraded").write_text("0\n", encoding="utf-8")
        (md0_dir / "level").write_text("raid1\n", encoding="utf-8")
        (md0_dir / "raid_disks").write_text("2\n", encoding="utf-8")

        sda1_dir = md0_dir / "dev-sda1"
        sda1_dir.mkdir(parents=True, exist_ok=True)
        (sda1_dir / "state").write_text("in_sync\n", encoding="utf-8")
        (sda1_dir / "slot").write_text("0\n", encoding="utf-8")

        with patch("main.Path", side_effect=lambda p: Path(str(p).replace("/sys/block", str(sysfs_base)))):
            status, details = main.read_sysfs_raid_state("/dev/md0")
            self.assertEqual(status, "clean")
            self.assertIn("State : clean", details)
            self.assertIn("Raid Level : raid1", details)
            self.assertIn("/dev/sda1", details)

            # 2. Degraded state
            (md0_dir / "degraded").write_text("1\n", encoding="utf-8")
            status, details = main.read_sysfs_raid_state("/dev/md0")
            self.assertEqual(status, "degraded")

            # 3. Resyncing state
            (md0_dir / "degraded").write_text("0\n", encoding="utf-8")
            (md0_dir / "sync_action").write_text("resync\n", encoding="utf-8")
            (md0_dir / "sync_completed").write_text("12345 / 50000\n", encoding="utf-8")
            status, details = main.read_sysfs_raid_state("/dev/md0")
            self.assertEqual(status, "resyncing")
            self.assertIn("Check Status : 12345 / 50000", details)

            # 4. Recovering state
            (md0_dir / "sync_action").write_text("recover\n", encoding="utf-8")
            status, details = main.read_sysfs_raid_state("/dev/md0")
            self.assertEqual(status, "recovering")

        # Non-existent device returns None
        self.assertIsNone(main.read_sysfs_raid_state("/dev/md_nonexistent"))

    def test_check_raid_status_prioritizes_sysfs(self):
        with (
            patch.object(main, "resolve_raid_device", return_value="/dev/md0"),
            patch.object(main, "read_sysfs_raid_state", return_value=("clean", "sysfs-details")),
            patch("main.check_output") as mock_co,
        ):
            status, details = main.check_raid_status()
            self.assertEqual(status, "clean")
            self.assertEqual(details, "sysfs-details")
            mock_co.assert_not_called()

    def test_docker_socket_requests_and_fallback(self):
        mgr = main.DockerManager(stacks_dir=Path(self.temp_dir.name) / "stacks", socket_path="/var/run/test_docker.sock")

        # Mock socket request helper
        mock_containers_json = json.dumps([
            {
                "Id": "c123456789012345",
                "Names": ["/my_web"],
                "Image": "nginx:alpine",
                "State": "running",
                "Status": "Up 5 minutes",
                "Ports": [{"IP": "0.0.0.0", "PublicPort": 8080, "PrivatePort": 80, "Type": "tcp"}],
                "Created": 1700000000,
                "Labels": {"com.docker.compose.project": "web_stack"},
            }
        ]).encode("utf-8")

        mock_images_json = json.dumps([
            {
                "Id": "sha256:abc123def456",
                "RepoTags": ["redis:alpine"],
                "Size": 35000000,
                "Created": 1700000000,
            }
        ]).encode("utf-8")

        mock_volumes_json = json.dumps({
            "Volumes": [
                {
                    "Name": "test_vol",
                    "Driver": "local",
                    "Scope": "local",
                    "Mountpoint": "/var/lib/docker/volumes/test_vol/_data",
                    "CreatedAt": "2026-10-01",
                }
            ]
        }).encode("utf-8")

        mock_networks_json = json.dumps([
            {
                "Id": "net123456789",
                "Name": "app_net",
                "Driver": "bridge",
                "Scope": "local",
                "Internal": False,
                "Created": "2026-10-01",
            }
        ]).encode("utf-8")

        mock_stats_json = json.dumps({
            "read": "2026-10-30T10:00:00Z",
            "cpu_stats": {"cpu_usage": {"total_usage": 100000}},
            "memory_stats": {"usage": 5000000},
        }).encode("utf-8")

        def fake_socket_request(method, path, body=None, timeout=5):
            if path == "/_ping":
                return 200, b"OK"
            if "/containers/json" in path:
                return 200, mock_containers_json
            if path == "/images/json":
                return 200, mock_images_json
            if path == "/volumes":
                return 200, mock_volumes_json
            if path == "/networks":
                return 200, mock_networks_json
            if "/containers/c123/stats" in path:
                return 200, mock_stats_json
            raise FileNotFoundError(f"Unknown path {path}")

        with patch.object(mgr, "_socket_request", side_effect=fake_socket_request):
            # 1. is_daemon_running via socket
            self.assertTrue(mgr.is_daemon_running())

            # 2. get_containers
            containers = mgr.get_containers(all=True)
            self.assertEqual(len(containers), 1)
            self.assertEqual(containers[0]["name"], "my_web")
            self.assertEqual(containers[0]["stack"], "web_stack")
            self.assertEqual(containers[0]["ports"], "0.0.0.0:8080->80/tcp")

            # 3. get_images
            images = mgr.get_images()
            self.assertEqual(len(images), 1)
            self.assertEqual(images[0]["repository"], "redis")
            self.assertEqual(images[0]["tag"], "alpine")

            # 4. get_volumes
            volumes = mgr.get_volumes()
            self.assertEqual(len(volumes), 1)
            self.assertEqual(volumes[0]["name"], "test_vol")

            # 5. get_networks
            networks = mgr.get_networks()
            self.assertEqual(len(networks), 1)
            self.assertEqual(networks[0]["name"], "app_net")

            # 6. get_container_stats
            stats = mgr.get_container_stats("c123")
            self.assertIn("cpu_stats", stats)

        # Fallback when socket throws FileNotFoundError
        with (
            patch.object(mgr, "_socket_request", side_effect=FileNotFoundError("socket down")),
            patch.object(mgr, "_run_docker", return_value='{"ID": "cli_c", "Names": "cli_app", "State": "running"}\n'),
        ):
            c_fallback = mgr.get_containers(all=True)
            self.assertEqual(len(c_fallback), 1)
            self.assertEqual(c_fallback[0]["name"], "cli_app")

    def test_api_container_stats_endpoint(self):
        # 1. Unauthenticated request rejected
        resp_unauth = asgi_get(api.app, "/api/docker/containers/c123/stats")
        self.assertEqual(resp_unauth.status_code, 401)

        # 2. Authenticated request
        with patch.object(
            main.docker_manager,
            "get_container_stats",
            return_value={"cpu_percent": 12.5, "memory_usage": 1048576},
        ):
            resp = asgi_get(
                api.app,
                "/api/docker/containers/c123/stats",
                cookies=self.auth_cookies,
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["stats"]["cpu_percent"], 12.5)

    def test_docker_events_listener_lifecycle_broadcast(self):
        event_line = json.dumps({
            "Type": "container",
            "Action": "start",
            "Actor": {
                "ID": "c1234567890123",
                "Attributes": {"name": "monitored_app"},
            },
            "time": 1700000000,
        }).encode("utf-8") + b"\n"

        async def run_listener_test():
            # Mock content stream
            class FakeContent:
                def __aiter__(self):
                    self.yielded = False
                    return self

                async def __anext__(self):
                    if not self.yielded:
                        self.yielded = True
                        return event_line
                    # Cancel listener after delivering event
                    raise asyncio.CancelledError()

            fake_resp = MagicMock()
            fake_resp.status = 200
            fake_resp.content = FakeContent()

            class FakeSessionContext:
                async def __aenter__(self):
                    return self
                async def __aexit__(self, exc_type, exc, tb):
                    pass
                def get(self, url):
                    class FakeGetContext:
                        async def __aenter__(self):
                            return fake_resp
                        async def __aexit__(self, exc_type, exc, tb):
                            pass
                    return FakeGetContext()

            with (
                patch("pathlib.Path.exists", return_value=True),
                patch("aiohttp.UnixConnector", return_value=MagicMock()),
                patch("aiohttp.ClientSession", return_value=FakeSessionContext()),
                patch.object(main.docker_manager, "invalidate_cache") as mock_inval,
                patch.object(api.ws_manager, "broadcast", new_callable=AsyncMock) as mock_broadcast,
            ):
                await api.docker_events_listener(socket_path="/var/run/fake.sock")
                mock_inval.assert_called_once()
                mock_broadcast.assert_called_once()
                payload = mock_broadcast.call_args[0][0]
                self.assertEqual(payload["type"], "docker_event")
                self.assertEqual(payload["event"]["action"], "start")
                self.assertEqual(payload["event"]["name"], "monitored_app")

        asyncio.run(run_listener_test())


if __name__ == "__main__":
    unittest.main()
