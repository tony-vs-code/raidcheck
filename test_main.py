import asyncio
import json
from pathlib import Path
from subprocess import CalledProcessError
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

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

    def __init__(self, status_code: int, headers: dict[str, str], body: bytes) -> None:
        self.status_code = status_code
        self.headers = headers
        self.content = body
        self.text = body.decode("utf-8", errors="replace")

    def json(self):
        return json.loads(self.text)


def asgi_get(app, path: str) -> AsgiResponse:
    """Execute a GET request directly against an ASGI app without external HTTP client deps."""
    parsed = urlsplit(path)
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": parsed.path or "/",
        "raw_path": (parsed.path or "/").encode("ascii"),
        "query_string": parsed.query.encode("ascii"),
        "headers": [(b"host", b"testserver")],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
    }

    messages = []
    request_sent = False

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    asyncio.run(app(scope, receive, send))

    status_code = 500
    headers: dict[str, str] = {}
    body_parts: list[bytes] = []

    for message in messages:
        if message["type"] == "http.response.start":
            status_code = message["status"]
            headers = {
                k.decode("latin1").lower(): v.decode("latin1")
                for k, v in message.get("headers", [])
            }
        elif message["type"] == "http.response.body":
            body_parts.append(message.get("body", b""))

    return AsgiResponse(status_code, headers, b"".join(body_parts))


class RaidFormattingTests(unittest.TestCase):
    def test_format_raid_summary_uses_clean_card_layout(self):
        text = main.format_raid_summary("clean", SAMPLE_DETAILS, SAMPLE_DUF)
        self.assertNotIn("╭", text)
        self.assertNotIn("│", text)
        self.assertIn("Status: clean", text)
        self.assertIn("Array Size: 9.31 GiB", text)
        self.assertIn("Devices: 2 active, 2 working, 0 failed, 0 spare", text)
        self.assertIn("- sda: active sync", text)
        self.assertIn("- sdb: active sync", text)

    def test_extract_raid_summary_data_parses_duf_table_and_fallback(self):
        data = main._extract_raid_summary_data("clean", SAMPLE_DETAILS, SAMPLE_DUF_TABLE)
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

    def test_check_raid_status_and_get_duf_output_mocked(self):
        with patch("main.check_output", return_value=SAMPLE_DETAILS.encode()):
            status, details = main.check_raid_status()
            self.assertEqual(status, "clean")
            self.assertIn("Raid Level : raid1", details)

        with patch(
            "main.check_output",
            side_effect=CalledProcessError(1, ["mdadm"], output=b"mdadm failed"),
        ):
            status, details = main.check_raid_status()
            self.assertEqual(status, "error")
            self.assertEqual(details, "mdadm failed")

        with patch(
            "main.check_output",
            side_effect=CalledProcessError(1, ["duf"], output=b"duf error"),
        ):
            duf_out = main.get_duf_output()
            self.assertIn("Error getting disk usage: duf error", duf_out)


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

        # Recording a non-weekly alert should not overwrite weekly notification_state
        t2 = t1 + 3600.0
        main.record_notification("degraded", t2, weekly=False)

        state_after_alert = main.get_weekly_notification_state()
        self.assertEqual(state_after_alert, (t1, t1 + main.WEEK_SECONDS, "clean"))

        # Recording a new weekly summary updates notification_state
        t3 = t1 + main.WEEK_SECONDS + 60.0
        main.record_notification("active", t3, weekly=True)
        state_after_second_weekly = main.get_weekly_notification_state()
        self.assertEqual(
            state_after_second_weekly, (t3, t3 + main.WEEK_SECONDS, "active")
        )

        # History is ordered newest-first and respects limit
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


class FastAPIEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "test_api_raid.sqlite3"
        self.db_patcher = patch.object(main, "RAID_STATE_DB", self.db_path)
        self.db_patcher.start()

    def tearDown(self):
        self.db_patcher.stop()
        self.temp_dir.cleanup()

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
            response = asgi_get(api.app, "/api/status")

        self.assertEqual(response.status_code, 200)
        mock_raid.assert_called_once()
        mock_duf.assert_called_once()

        payload = response.json()
        self.assertIn("raid", payload)
        self.assertIn("system", payload)
        self.assertIn("notification_state", payload)

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
            response = asgi_get(api.app, "/api/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["raid"]["status"], "degraded")
        self.assertIsNone(payload["notification_state"])

    def test_get_api_history_returns_formatted_notifications_and_respects_limit(self):
        main.record_notification("clean", 1700000100.0, weekly=True)
        main.record_notification("degraded", 1700000200.0, weekly=False)
        main.record_notification("recovering", 1700000300.0, weekly=False)

        response = asgi_get(api.app, "/api/history")
        self.assertEqual(response.status_code, 200)
        history = response.json()["history"]
        self.assertEqual(len(history), 3)
        self.assertEqual(history[0]["status"], "recovering")
        self.assertFalse(history[0]["weekly"])
        self.assertEqual(history[0]["kind"], "alert")
        self.assertEqual(history[2]["status"], "clean")
        self.assertTrue(history[2]["weekly"])
        self.assertEqual(history[2]["kind"], "weekly summary")

        limited_resp = asgi_get(api.app, "/api/history?limit=1")
        self.assertEqual(limited_resp.status_code, 200)
        limited_history = limited_resp.json()["history"]
        self.assertEqual(len(limited_history), 1)
        self.assertEqual(limited_history[0]["status"], "recovering")

        invalid_resp = asgi_get(api.app, "/api/history?limit=0")
        self.assertEqual(invalid_resp.status_code, 422)

    def test_get_root_serves_dashboard_html(self):
        response = asgi_get(api.app, "/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.headers.get("content-type", ""))
        self.assertIn("<html", response.text.lower())

    def test_static_assets_and_dashboard_elements_served(self):
        index_resp = asgi_get(api.app, "/")
        self.assertEqual(index_resp.status_code, 200)
        self.assertIn('id="raid-status-badge"', index_resp.text)
        self.assertIn('id="active-disks-table"', index_resp.text)
        self.assertIn('id="notification-history-table"', index_resp.text)

        css_resp = asgi_get(api.app, "/static/styles.css")
        self.assertEqual(css_resp.status_code, 200)
        self.assertIn("text/css", css_resp.headers.get("content-type", ""))
        self.assertTrue(len(css_resp.text) > 0)

        js_resp = asgi_get(api.app, "/static/app.js")
        self.assertEqual(js_resp.status_code, 200)
        self.assertIn("javascript", js_resp.headers.get("content-type", ""))
        self.assertTrue(len(js_resp.text) > 0)


if __name__ == "__main__":
    unittest.main()
