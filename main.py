import argparse
import sys
import time
import discord
import logging
from logging.handlers import RotatingFileHandler
import sqlite3
from decouple import config
from discord.ext import tasks
from subprocess import check_output, CalledProcessError, STDOUT
from pathlib import Path
from datetime import datetime
from typing import Optional, Tuple
import re

RAID_STATE_DB = Path(
    config("RAID_STATE_DB", default="/var/lib/raidcheck/raid_monitor.sqlite3")
)
WEEK_SECONDS = 7 * 24 * 60 * 60
CHANNEL_ID = ""

client = discord.Client(intents=discord.Intents.default())
MAX_DISCORD_MESSAGE_LENGTH = 2000


def enforce_discord_message_limit(message: str) -> str:
    """Trim a message to Discord's 2000-character hard limit while preserving readability."""
    if len(message) <= MAX_DISCORD_MESSAGE_LENGTH:
        return message
    trimmed = message[: MAX_DISCORD_MESSAGE_LENGTH - 24].rstrip()
    return f"{trimmed}...\n[truncated]"


async def send_message(message: str | discord.Embed) -> bool:
    try:
        channel = client.get_channel(int(CHANNEL_ID))
        if channel:
            if isinstance(message, discord.Embed):
                await channel.send(embed=message)
            else:
                await channel.send(message)
            return True
        else:
            logging.error(f"Channel with ID {CHANNEL_ID} not found.")
    except Exception as e:
        logging.error(f"Failed to send message: {e}")
    return False


def _connect_state_db() -> sqlite3.Connection:
    RAID_STATE_DB.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(RAID_STATE_DB))
    connection.execute(
        "CREATE TABLE IF NOT EXISTS notification_state "
        "(name TEXT PRIMARY KEY, sent_at REAL NOT NULL)"
    )
    columns = {
        row[1] for row in connection.execute("PRAGMA table_info(notification_state)")
    }
    if "due_at" not in columns:
        connection.execute("ALTER TABLE notification_state ADD COLUMN due_at REAL")
    if "status" not in columns:
        connection.execute("ALTER TABLE notification_state ADD COLUMN status TEXT")
    connection.execute(
        "UPDATE notification_state SET due_at = sent_at + ? WHERE due_at IS NULL",
        (WEEK_SECONDS,),
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS notification_history "
        "(id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, "
        "sent_at REAL NOT NULL, weekly INTEGER NOT NULL)"
    )
    connection.commit()
    return connection


def get_weekly_notification_state() -> Optional[Tuple[float, float, str]]:
    connection = _connect_state_db()
    try:
        row = connection.execute(
            "SELECT sent_at, due_at, status FROM notification_state WHERE name = ?",
            ("raid_summary",),
        ).fetchone()
        if row:
            return float(row[0]), float(row[1]), row[2] or "unknown"
        return None
    finally:
        connection.close()


def record_notification(status: str, timestamp: float, weekly: bool) -> None:
    connection = _connect_state_db()
    try:
        if weekly:
            connection.execute(
                "INSERT OR REPLACE INTO notification_state "
                "(name, sent_at, due_at, status) VALUES (?, ?, ?, ?)",
                ("raid_summary", timestamp, timestamp + WEEK_SECONDS, status),
            )
        connection.execute(
            "INSERT INTO notification_history (status, sent_at, weekly) "
            "VALUES (?, ?, ?)",
            (status, timestamp, int(weekly)),
        )
        connection.commit()
    finally:
        connection.close()


def get_notification_history(limit: int) -> list:
    connection = _connect_state_db()
    try:
        return connection.execute(
            "SELECT status, sent_at, weekly FROM notification_history "
            "ORDER BY sent_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    finally:
        connection.close()


def format_timestamp(timestamp: float) -> str:
    return (
        datetime.fromtimestamp(timestamp)
        .astimezone()
        .isoformat(sep=" ", timespec="seconds")
    )


def should_send_weekly_summary(
    notification_state: Optional[Tuple[float, float, str]],
    *,
    force: bool = False,
    now: Optional[float] = None,
) -> bool:
    """Decide whether a clean/active weekly summary should be sent.

    A bot restart should trigger one immediate check without waiting for the stored
    `due_at` value to expire; the normal weekly throttling still applies otherwise.
    """
    if force:
        return True
    if notification_state is None:
        return True
    _, due_at, _ = notification_state
    current_time = time.time() if now is None else now
    return current_time >= due_at


def show_notification_status() -> None:
    state = get_weekly_notification_state()
    if state is None:
        print("No successful weekly summary has been recorded yet.")
        print("Next weekly summary: due on the next clean/active RAID check.")
        return

    sent_at, due_at, status = state
    print(f"Last successful weekly summary: {format_timestamp(sent_at)} ({status})")
    print(f"Next weekly summary due:       {format_timestamp(due_at)}")
    remaining = int(due_at - time.time())
    if remaining <= 0:
        print("Refresh status:                due on the next clean/active RAID check")
    else:
        days, remaining = divmod(remaining, 24 * 60 * 60)
        hours, remaining = divmod(remaining, 60 * 60)
        minutes = remaining // 60
        print(f"Time remaining:                {days}d {hours}h {minutes}m")


def show_notification_logs(limit: int) -> None:
    history = get_notification_history(limit)
    if not history:
        print("No successful notifications have been recorded yet.")
        return

    for status, timestamp, weekly in history:
        kind = "weekly summary" if weekly else "alert"
        print(f"{format_timestamp(timestamp)} | {kind:<14} | {status}")


def check_raid_status() -> Tuple[str, str]:
    try:
        result = check_output(
            ["mdadm", "--detail", "/dev/md128"], stderr=STDOUT
        ).decode()
        if "State : clean" in result:
            return "clean", result
        elif "State : active" in result:
            return "active", result
        elif "State : degraded" in result:
            return "degraded", result
        elif "State : recovering" in result:
            return "recovering", result
        elif "State : resyncing" in result:
            return "resyncing", result
        elif "State : failed" in result:
            return "failed", result
        else:
            return "unknown", result
    except (CalledProcessError, FileNotFoundError, OSError) as e:
        error_msg = (
            e.output.decode()
            if isinstance(e, CalledProcessError) and e.output
            else str(e)
        )
        logging.error(f"Error checking RAID status: {error_msg}")
        return "error", error_msg


def get_duf_output() -> str:
    try:
        # Use --output to show only specific columns for narrower display
        result = check_output(
            ["duf", "--output", "size,used,avail,usage", "/mnt/media/"],
            stderr=STDOUT,
        ).decode()
        return result.strip()
    except (CalledProcessError, FileNotFoundError, OSError) as e:
        error_msg = (
            e.output.decode()
            if isinstance(e, CalledProcessError) and e.output
            else str(e)
        )
        logging.error(f"Error getting duf output: {error_msg}")
        return f"Error getting disk usage: {error_msg}"


def _extract_raid_summary_data(status: str, details: str, duf_output: str) -> dict:
    """Parse RAID mdadm output into a compact, Discord-friendly data structure."""
    level_match = re.search(r"Raid Level : (\w+)", details)
    array_size_match = re.search(r"Array Size : \d+ \(([^)]+)\)", details)
    active_devices_match = re.search(r"Active Devices : (\d+)", details)
    working_devices_match = re.search(r"Working Devices : (\d+)", details)
    failed_devices_match = re.search(r"Failed Devices : (\d+)", details)
    spare_devices_match = re.search(r"Spare Devices : (\d+)", details)
    update_time_match = re.search(r"Update Time : (.+)", details)
    persistence_match = re.search(r"Persistence : (.+)", details)
    state_match = re.search(r"State : (.+)", details)
    check_status_match = re.search(r"Check Status : (.+)", details)
    events_match = re.search(r"Events : (\d+)", details)
    layout_match = re.search(r"Layout : (.+)", details)
    chunk_size_match = re.search(r"Chunk Size : (.+)", details)
    consistency_policy_match = re.search(r"Consistency Policy : (.+)", details)
    uuid_match = re.search(r"UUID : (.+)", details)
    creation_time_match = re.search(r"Creation Time : (.+)", details)
    version_match = re.search(r"Version : (.+)", details)

    devices = []
    device_section = False
    for line in details.split("\n"):
        if "Number   Major   Minor   RaidDevice State" in line:
            device_section = True
            continue
        if device_section and "/dev/sd" in line:
            parts = line.strip().split()
            if len(parts) >= 6:
                device_name = parts[-1].replace("/dev/", "")
                device_state = " ".join(parts[4:-1])
                devices.append({"device": device_name, "state": device_state})

    storage_info = "N/A"
    for line in duf_output.split("\n"):
        if "T" in line and ("│" in line or "|" in line):
            cleaned = line.replace("│", "|").replace("|", " ").strip()
            parts = [p.strip() for p in cleaned.split() if p.strip()]
            if len(parts) >= 4:
                size, used, avail, usage = parts[0], parts[1], parts[2], parts[3]
                storage_info = f"{used}/{size} ({usage}) | {avail} free"
                break

    return {
        "status": status,
        "raid_level": level_match.group(1) if level_match else "unknown",
        "array_size": array_size_match.group(1) if array_size_match else "unknown",
        "active_devices": active_devices_match.group(1)
        if active_devices_match
        else "0",
        "working_devices": working_devices_match.group(1)
        if working_devices_match
        else "0",
        "failed_devices": failed_devices_match.group(1)
        if failed_devices_match
        else "0",
        "spare_devices": spare_devices_match.group(1) if spare_devices_match else "0",
        "update_time": update_time_match.group(1) if update_time_match else "unknown",
        "persistence": persistence_match.group(1) if persistence_match else "unknown",
        "full_state": state_match.group(1) if state_match else "unknown",
        "check_status": check_status_match.group(1) if check_status_match else "N/A",
        "events": events_match.group(1) if events_match else "unknown",
        "layout": layout_match.group(1) if layout_match else "unknown",
        "chunk_size": chunk_size_match.group(1) if chunk_size_match else "unknown",
        "consistency_policy": (
            consistency_policy_match.group(1) if consistency_policy_match else "unknown"
        ),
        "uuid": uuid_match.group(1) if uuid_match else "unknown",
        "creation_time": creation_time_match.group(1)
        if creation_time_match
        else "unknown",
        "version": version_match.group(1) if version_match else "unknown",
        "storage_info": storage_info,
        "devices": devices,
    }


def build_raid_embed(status: str, details: str, duf_output: str) -> discord.Embed:
    """Keep the old boxed RAID card look, but render it inside a Discord embed."""
    data = _extract_raid_summary_data(status, details, duf_output)
    raid_level = data["raid_level"]
    display_raid_level = (
        raid_level[4:].upper()
        if raid_level.lower().startswith("raid")
        else raid_level.upper()
    )
    color = {
        "clean": 0x2ECC71,
        "active": 0x3498DB,
        "degraded": 0xF39C12,
        "recovering": 0xE67E22,
        "resyncing": 0xE67E22,
        "failed": 0xE74C3C,
        "error": 0xE74C3C,
    }.get(status, 0x95A5A6)

    card = format_raid_summary(status, details, duf_output)
    embed = discord.Embed(
        title=f"RAID {display_raid_level} | {status.upper()}",
        color=color,
    )
    embed.description = f"```text\n{card}\n```"
    return embed


def format_raid_summary(status: str, details: str, duf_output: str) -> str:
    """Return the RAID status in a clean card-friendly list format without box borders."""
    try:
        data = _extract_raid_summary_data(status, details, duf_output)
        raid_level = data["raid_level"]
        display_raid_level = (
            raid_level[4:].upper()
            if raid_level.lower().startswith("raid")
            else raid_level.upper()
        )

        lines = [
            f"Status: {data['full_state']}",
            f"Array Size: {data['array_size']}",
            (
                "Devices: "
                f"{data['active_devices']} active, {data['working_devices']} working, "
                f"{data['failed_devices']} failed, {data['spare_devices']} spare"
            ),
            f"Persistence: {data['persistence']}",
            f"Last Update: {data['update_time']}",
            f"Check Status: {data['check_status']}",
            f"Events: {data['events']}",
            f"Layout: {data['layout']}",
            f"Chunk Size: {data['chunk_size']}",
            f"Consistency: {data['consistency_policy']}",
            f"UUID: {data['uuid']}",
            f"Creation Time: {data['creation_time']}",
            f"Version: {data['version']}",
            f"Storage Usage: {data['storage_info']}",
            "",
            "Active Disks:",
        ]

        if data["devices"]:
            lines.extend(
                f"- {device['device']}: {device['state']}" for device in data["devices"]
            )
        else:
            lines.append("- No device information available")

        return "\n".join(lines)
    except Exception as e:
        logging.error(f"Error formatting RAID summary: {e}")
        return f"RAID Array {status.capitalize()}\nError parsing details"


async def run_raid_check(force: bool = False) -> None:
    status, details = check_raid_status()
    duf_output = get_duf_output()

    message_content = build_raid_embed(status, details, duf_output)

    if status in ["clean", "active"]:
        try:
            notification_state = get_weekly_notification_state()
        except (OSError, sqlite3.Error):
            logging.exception("Could not read RAID notification state from SQLite.")
            return

        if should_send_weekly_summary(notification_state, force=force):
            logging.info(f"RAID Array {status.capitalize()} Sending Message")
            if await send_message(message_content):
                try:
                    record_notification(status, time.time(), weekly=True)
                except (OSError, sqlite3.Error):
                    logging.exception(
                        "Could not save RAID notification state to SQLite."
                    )
    else:
        logging.info(f"RAID Array {status.capitalize()} Sending Message")
        if await send_message(message_content):
            try:
                record_notification(status, time.time(), weekly=False)
            except (OSError, sqlite3.Error):
                logging.exception("Could not save RAID notification history to SQLite.")


@client.event
async def on_ready() -> None:
    logging.info(f"Logged in as {client.user}")
    await run_raid_check(force=True)
    monitor_raid.start()


@tasks.loop(hours=2)
async def monitor_raid() -> None:
    await run_raid_check(force=False)


def main() -> int:
    global CHANNEL_ID

    parser = argparse.ArgumentParser(description="RAID monitoring bot and status tools")
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("status", help="Show the next weekly summary due time")
    logs_parser = subparsers.add_parser("logs", help="Show recent sent notifications")
    logs_parser.add_argument("--limit", "-n", type=int, default=20)
    web_parser = subparsers.add_parser("web", help="Run the FastAPI web dashboard")
    web_parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    web_parser.add_argument("--port", type=int, default=8000, help="Port to bind to")
    arguments = parser.parse_args()

    if arguments.command == "web":
        import uvicorn

        uvicorn.run("api:app", host=arguments.host, port=arguments.port)
        return 0

    if arguments.command:
        if arguments.command == "logs" and arguments.limit < 1:
            parser.error("--limit must be a positive integer")
        try:
            if arguments.command == "status":
                show_notification_status()
            else:
                show_notification_logs(arguments.limit)
        except (OSError, sqlite3.Error) as error:
            print(f"Could not read RAID notification data: {error}", file=sys.stderr)
            return 1
        return 0

    discord_token = config("DISCORD_TOKEN", default="")
    CHANNEL_ID = config("CHANNEL_ID", default="")
    if not discord_token or not CHANNEL_ID:
        print(
            "DISCORD_TOKEN and CHANNEL_ID must be set to run the bot.", file=sys.stderr
        )
        return 1

    log_max_bytes = config("RAID_LOG_MAX_BYTES", default=10 * 1024 * 1024, cast=int)
    log_backup_count = config("RAID_LOG_BACKUP_COUNT", default=5, cast=int)
    if log_max_bytes < 1 or log_backup_count < 0:
        print(
            "RAID_LOG_MAX_BYTES must be positive and RAID_LOG_BACKUP_COUNT cannot be negative.",
            file=sys.stderr,
        )
        return 1

    log_handler = RotatingFileHandler(
        "/var/log/raid_monitor.log",
        maxBytes=log_max_bytes,
        backupCount=log_backup_count,
        encoding="utf-8",
    )
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[log_handler],
    )
    client.run(discord_token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
