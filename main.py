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


async def send_message(message: str) -> bool:
    try:
        channel = client.get_channel(int(CHANNEL_ID))
        if channel:
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
    except CalledProcessError as e:
        logging.error(f"Error checking RAID status: {e.output.decode()}")
        return "error", e.output.decode()


def get_duf_output() -> str:
    try:
        # Use --output to show only specific columns for narrower display
        result = check_output(
            ["duf", "--output", "size,used,avail,usage", "/mnt/media/"],
            stderr=STDOUT,
        ).decode()
        return result.strip()
    except CalledProcessError as e:
        logging.error(f"Error getting duf output: {e.output.decode()}")
        return f"Error getting disk usage: {e.output.decode()}"


def format_raid_summary(status: str, details: str, duf_output: str) -> str:
    """Extract and format RAID and storage information in a unified table format"""
    try:
        # Extract RAID information using regex
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

        # Extract detailed device information
        devices = []
        device_section = False
        for line in details.split("\n"):
            if "Number   Major   Minor   RaidDevice State" in line:
                device_section = True
                continue
            if device_section and "/dev/sd" in line:
                parts = line.strip().split()
                if len(parts) >= 6:
                    number = parts[0]
                    device = parts[-1].replace("/dev/", "")
                    state = " ".join(
                        parts[4:-1]
                    )  # Everything between device number and device path
                    devices.append({"number": number, "device": device, "state": state})

        # Extract storage information from duf
        storage_info = "N/A"
        for line in duf_output.split("\n"):
            if "T" in line and ("│" in line or "|" in line):
                cleaned = line.replace("│", "|").replace("|", " ").strip()
                parts = [p.strip() for p in cleaned.split() if p.strip()]
                if len(parts) >= 4:
                    size, used, avail, usage = parts[0], parts[1], parts[2], parts[3]
                    storage_info = f"{used}/{size} ({usage}) | {avail} free"
                    break

        # Build values
        raid_level = level_match.group(1) if level_match else "unknown"
        array_size = array_size_match.group(1) if array_size_match else "unknown"
        active_devices = active_devices_match.group(1) if active_devices_match else "0"
        working_devices = (
            working_devices_match.group(1) if working_devices_match else "0"
        )
        failed_devices = failed_devices_match.group(1) if failed_devices_match else "0"
        spare_devices = spare_devices_match.group(1) if spare_devices_match else "0"
        update_time = update_time_match.group(1) if update_time_match else "unknown"
        persistence = persistence_match.group(1) if persistence_match else "unknown"
        full_state = state_match.group(1) if state_match else "unknown"
        check_status = check_status_match.group(1) if check_status_match else "N/A"
        events = events_match.group(1) if events_match else "unknown"
        layout = layout_match.group(1) if layout_match else "unknown"
        chunk_size = chunk_size_match.group(1) if chunk_size_match else "unknown"
        consistency_policy = (
            consistency_policy_match.group(1) if consistency_policy_match else "unknown"
        )
        uuid = uuid_match.group(1) if uuid_match else "unknown"
        creation_time = (
            creation_time_match.group(1) if creation_time_match else "unknown"
        )
        version = version_match.group(1) if version_match else "unknown"

        # Create unified table format with fixed widths
        content_width = 43  # Width of the content column

        header = "╭─────────────────────────────────────────────────────────────╮"
        title = f"│ RAID {raid_level.upper()} SYSTEM STATUS - {status.upper():<32} │"
        separator = "├───────────────┬─────────────────────────────────────────────┤"

        rows = [
            f"│ Status        │ {full_state:<{content_width}} │",
            f"│ Array Size    │ {array_size:<{content_width}} │",
            f"│ Devices       │ {active_devices} active, {working_devices} working, {failed_devices} failed, {spare_devices} spare{'':<{content_width - len(f'{active_devices} active, {working_devices} working, {failed_devices} failed, {spare_devices} spare')}} │",
            f"│ Persistence   │ {persistence:<{content_width}} │",
            f"│ Last Update   │ {update_time:<{content_width}} │",
            f"│ Check Status  │ {check_status:<{content_width}} │",
            f"│ Events        │ {events:<{content_width}} │",
            f"│ Layout        │ {layout:<{content_width}} │",
            f"│ Chunk Size    │ {chunk_size:<{content_width}} │",
            f"│ Consistency   │ {consistency_policy:<{content_width}} │",
            f"│ UUID          │ {uuid:<{content_width}} │",
            f"│ Creation Time │ {creation_time:<{content_width}} │",
            f"│ Version       │ {version:<{content_width}} │",
            f"│ Storage Usage │ {storage_info:<{content_width}} │",
        ]

        # Add Active Disks section as full-width nested table
        device_separator = (
            "├─────────────────────────────────────────────────────────────┤"
        )
        rows.append(device_separator)
        rows.append("│ Active Disks                                                │")
        rows.append("├─────┬────────┬──────────────────────────────────────────────┤")
        rows.append("│ No. │ Device │ State                                        │")
        rows.append("├─────┼────────┼──────────────────────────────────────────────┤")

        if devices:
            for device in devices:
                device_num = device["number"].rjust(3)
                device_name = device["device"].ljust(6)
                device_state = device["state"]

                # Ensure state fits in the allocated space (44 chars)
                if len(device_state) > 44:
                    device_state = device_state[:41] + "..."
                else:
                    device_state = device_state.ljust(44)

                rows.append(f"│ {device_num} │ {device_name} │ {device_state} │")
        else:
            rows.append(
                "│     │        │ No device information available              │"
            )

        footer = "╰─────┴────────┴──────────────────────────────────────────────╯"

        return "\n".join([header, title, separator] + rows + [footer])

    except Exception as e:
        logging.error(f"Error formatting RAID summary: {e}")
        return f"RAID Array {status.capitalize()}\nError parsing details"


@client.event
async def on_ready() -> None:
    logging.info(f"Logged in as {client.user}")
    monitor_raid.start()


@tasks.loop(hours=2)
async def monitor_raid() -> None:
    status, details = check_raid_status()
    duf_output = get_duf_output()

    # Create unified formatted message
    message_content = format_raid_summary(status, details, duf_output)

    if status in ["clean", "active"]:
        try:
            notification_state = get_weekly_notification_state()
        except (OSError, sqlite3.Error):
            logging.exception("Could not read RAID notification state from SQLite.")
            return

        if notification_state is None or time.time() >= notification_state[1]:
            logging.info(f"RAID Array {status.capitalize()} Sending Message")
            if await send_message(f"```\n{message_content}\n```"):
                try:
                    record_notification(status, time.time(), weekly=True)
                except (OSError, sqlite3.Error):
                    logging.exception(
                        "Could not save RAID notification state to SQLite."
                    )
    else:
        logging.info(f"RAID Array {status.capitalize()} Sending Message")
        if await send_message(f"```\n{message_content}\n```"):
            try:
                record_notification(status, time.time(), weekly=False)
            except (OSError, sqlite3.Error):
                logging.exception("Could not save RAID notification history to SQLite.")


def main() -> int:
    global CHANNEL_ID

    parser = argparse.ArgumentParser(description="RAID monitoring bot and status tools")
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("status", help="Show the next weekly summary due time")
    logs_parser = subparsers.add_parser("logs", help="Show recent sent notifications")
    logs_parser.add_argument("--limit", "-n", type=int, default=20)
    arguments = parser.parse_args()

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
