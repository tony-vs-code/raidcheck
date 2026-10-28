import argparse
import glob
import hashlib
import hmac
import os
import secrets
import shutil
import subprocess
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
from typing import Any, Optional, Tuple
import re

REPO_DIR = Path(__file__).resolve().parent
RAID_STATE_DB = Path(
    config("RAID_STATE_DB", default="/var/lib/raidcheck/raid_monitor.sqlite3")
)
WEEK_SECONDS = 7 * 24 * 60 * 60
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
CHANNEL_ID = ""

APP_SETTING_KEYS = (
    "discord_token",
    "channel_id",
    "raid_device",
    "mount_path",
    "google_client_id",
    "allowed_google_emails",
)

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
        effective_channel_id = CHANNEL_ID or get_app_settings().get("channel_id", "")
        channel = client.get_channel(int(effective_channel_id))
        if channel:
            if isinstance(message, discord.Embed):
                await channel.send(embed=message)
            else:
                await channel.send(message)
            return True
        else:
            logging.error(f"Channel with ID {effective_channel_id} not found.")
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
    connection.execute(
        "CREATE TABLE IF NOT EXISTS users "
        "(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, "
        "password_hash TEXT NOT NULL, salt TEXT NOT NULL, "
        "email TEXT DEFAULT '', created_at REAL NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS sessions "
        "(token TEXT PRIMARY KEY, username TEXT NOT NULL, "
        "created_at REAL NOT NULL, expires_at REAL NOT NULL)"
    )
    connection.execute(
        "CREATE TABLE IF NOT EXISTS app_settings "
        "(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL)"
    )
    connection.commit()
    return connection


def _hash_password(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt_hex),
        100_000,
    ).hex()


def has_any_user() -> bool:
    connection = _connect_state_db()
    try:
        row = connection.execute("SELECT COUNT(*) FROM users").fetchone()
        return bool(row and row[0] > 0)
    finally:
        connection.close()


def create_user(username: str, password: str, email: str = "") -> dict[str, Any]:
    clean_username = username.strip()
    clean_email = email.strip()
    if not clean_username or not password:
        raise ValueError("Username and password are required.")
    salt_hex = secrets.token_hex(16)
    password_hash = _hash_password(password, salt_hex)
    now = time.time()
    connection = _connect_state_db()
    try:
        connection.execute(
            "INSERT INTO users (username, password_hash, salt, email, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (clean_username, password_hash, salt_hex, clean_email, now),
        )
        connection.commit()
        return {
            "username": clean_username,
            "email": clean_email,
            "created_at": now,
        }
    finally:
        connection.close()


def verify_user(username: str, password: str) -> bool:
    clean_username = username.strip()
    if not clean_username or not password:
        return False
    connection = _connect_state_db()
    try:
        row = connection.execute(
            "SELECT password_hash, salt FROM users WHERE username = ?",
            (clean_username,),
        ).fetchone()
        if not row:
            return False
        expected_hash, salt_hex = row[0], row[1]
        actual_hash = _hash_password(password, salt_hex)
        return hmac.compare_digest(expected_hash, actual_hash)
    finally:
        connection.close()


def get_or_create_google_user(email: str) -> str:
    clean_email = email.strip().lower()
    if not clean_email:
        raise ValueError("Email is required.")
    connection = _connect_state_db()
    try:
        row = connection.execute(
            "SELECT username FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?",
            (clean_email, clean_email),
        ).fetchone()
        if row:
            return str(row[0])
        salt_hex = secrets.token_hex(16)
        random_hash = _hash_password(secrets.token_urlsafe(32), salt_hex)
        now = time.time()
        connection.execute(
            "INSERT INTO users (username, password_hash, salt, email, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (clean_email, random_hash, salt_hex, clean_email, now),
        )
        connection.commit()
        return clean_email
    finally:
        connection.close()


def create_session(username: str) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    expires_at = now + SESSION_TTL_SECONDS
    connection = _connect_state_db()
    try:
        connection.execute(
            "INSERT INTO sessions (token, username, created_at, expires_at) "
            "VALUES (?, ?, ?, ?)",
            (token, username, now, expires_at),
        )
        connection.commit()
        return token
    finally:
        connection.close()


def verify_session(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    connection = _connect_state_db()
    try:
        row = connection.execute(
            "SELECT username, expires_at FROM sessions WHERE token = ?",
            (token,),
        ).fetchone()
        if not row:
            return None
        username, expires_at = str(row[0]), float(row[1])
        if time.time() >= expires_at:
            connection.execute("DELETE FROM sessions WHERE token = ?", (token,))
            connection.commit()
            return None
        return username
    finally:
        connection.close()


def delete_session(token: Optional[str]) -> None:
    if not token:
        return
    connection = _connect_state_db()
    try:
        connection.execute("DELETE FROM sessions WHERE token = ?", (token,))
        connection.commit()
    finally:
        connection.close()


def _default_app_settings_from_env() -> dict[str, str]:
    return {
        "discord_token": str(config("DISCORD_TOKEN", default="") or ""),
        "channel_id": str(config("CHANNEL_ID", default="") or ""),
        "raid_device": str(config("RAID_DEVICE", default="auto") or "auto"),
        "mount_path": str(config("MOUNT_PATH", default="/mnt/media/") or "/mnt/media/"),
        "google_client_id": str(config("GOOGLE_CLIENT_ID", default="") or ""),
        "allowed_google_emails": str(config("ALLOWED_GOOGLE_EMAILS", default="") or ""),
    }


def get_app_settings() -> dict[str, str]:
    defaults = _default_app_settings_from_env()
    try:
        connection = _connect_state_db()
    except (OSError, sqlite3.Error):
        return defaults

    try:
        rows = connection.execute("SELECT key, value FROM app_settings").fetchall()
        stored = {str(k): str(v) for k, v in rows}
        now = time.time()
        inserted = False
        for key, default_val in defaults.items():
            if key not in stored:
                connection.execute(
                    "INSERT OR IGNORE INTO app_settings (key, value, updated_at) "
                    "VALUES (?, ?, ?)",
                    (key, default_val, now),
                )
                stored[key] = default_val
                inserted = True
        if inserted:
            connection.commit()

        result: dict[str, str] = {}
        for key in APP_SETTING_KEYS:
            db_val = stored.get(key, "")
            result[key] = db_val if db_val != "" else defaults.get(key, "")
        return result
    except (OSError, sqlite3.Error):
        return defaults
    finally:
        connection.close()


def update_app_settings(updates: dict[str, Any]) -> dict[str, str]:
    global CHANNEL_ID
    connection = _connect_state_db()
    try:
        now = time.time()
        for key, value in updates.items():
            if key in APP_SETTING_KEYS and value is not None:
                str_val = str(value).strip()
                connection.execute(
                    "INSERT OR REPLACE INTO app_settings (key, value, updated_at) "
                    "VALUES (?, ?, ?)",
                    (key, str_val, now),
                )
                if key == "channel_id" and str_val:
                    CHANNEL_ID = str_val
        connection.commit()
    finally:
        connection.close()
    return get_app_settings()


def _parse_semver(version_str: str) -> Tuple[int, ...]:
    cleaned = version_str.strip().lstrip("vV")
    parts = []
    for segment in cleaned.split("."):
        num_match = re.match(r"(\d+)", segment)
        parts.append(int(num_match.group(1)) if num_match else 0)
    return tuple(parts) if parts else (0, 0, 0)


def get_current_version_info() -> dict[str, str]:
    version = "0.1.0"
    pyproject_path = REPO_DIR / "pyproject.toml"
    try:
        if pyproject_path.is_file():
            content = pyproject_path.read_text(encoding="utf-8")
            match = re.search(r'^version\s*=\s*"([^"]+)"', content, re.MULTILINE)
            if match:
                version = match.group(1).strip()
    except OSError:
        pass

    commit = "unknown"
    try:
        commit = (
            check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=str(REPO_DIR),
                stderr=STDOUT,
            )
            .decode()
            .strip()
        )
    except (CalledProcessError, FileNotFoundError, OSError):
        pass

    return {"version": version, "commit": commit}


def check_for_release_update() -> dict[str, Any]:
    current = get_current_version_info()
    current_version = current["version"]
    current_commit = current["commit"]

    try:
        check_output(
            ["git", "fetch", "origin", "--tags"],
            cwd=str(REPO_DIR),
            stderr=STDOUT,
        )
    except (CalledProcessError, FileNotFoundError, OSError) as e:
        logging.warning(f"Could not fetch tags from origin: {e}")

    tags: list[str] = []
    try:
        raw_tags = (
            check_output(
                ["git", "tag", "-l", "v*"],
                cwd=str(REPO_DIR),
                stderr=STDOUT,
            )
            .decode()
            .splitlines()
        )
        tags = [t.strip() for t in raw_tags if t.strip()]
    except (CalledProcessError, FileNotFoundError, OSError):
        tags = []

    if not tags:
        return {
            "current_version": current_version,
            "current_commit": current_commit,
            "latest_version": current_version,
            "latest_commit": current_commit,
            "update_available": False,
            "changelog": "",
        }

    tags.sort(key=_parse_semver, reverse=True)
    latest_tag = tags[0]
    latest_version = latest_tag.lstrip("vV")

    latest_commit = current_commit
    try:
        latest_commit = (
            check_output(
                ["git", "rev-parse", "--short", f"{latest_tag}^{{commit}}"],
                cwd=str(REPO_DIR),
                stderr=STDOUT,
            )
            .decode()
            .strip()
        )
    except (CalledProcessError, FileNotFoundError, OSError):
        pass

    update_available = _parse_semver(latest_version) > _parse_semver(current_version)
    changelog = ""
    if update_available:
        try:
            changelog = (
                check_output(
                    ["git", "log", "--oneline", f"HEAD..{latest_tag}"],
                    cwd=str(REPO_DIR),
                    stderr=STDOUT,
                )
                .decode()
                .strip()
            )
        except (CalledProcessError, FileNotFoundError, OSError):
            changelog = ""

    return {
        "current_version": current_version,
        "current_commit": current_commit,
        "latest_version": latest_version,
        "latest_commit": latest_commit,
        "update_available": update_available,
        "changelog": changelog,
    }


def _resolve_uv_binary() -> str:
    found = shutil.which("uv")
    if found:
        return found
    for candidate in (
        "/root/.local/bin/uv",
        "/usr/local/bin/uv",
        str(Path.home() / ".local/bin/uv"),
    ):
        try:
            if Path(candidate).is_file():
                return candidate
        except OSError:
            pass
    return "uv"


def apply_release_update() -> dict[str, Any]:
    info = check_for_release_update()
    target_version = info["latest_version"]
    target_tag = f"v{target_version}"

    check_output(
        ["git", "checkout", "-f", target_tag],
        cwd=str(REPO_DIR),
        stderr=STDOUT,
    )
    uv_bin = _resolve_uv_binary()
    check_output(
        [uv_bin, "sync"],
        cwd=str(REPO_DIR),
        stderr=STDOUT,
    )

    if hasattr(os, "geteuid") and os.geteuid() == 0:
        systemd_dir = REPO_DIR / "systemd"
        target_systemd_dir = Path("/etc/systemd/system")
        if systemd_dir.is_dir() and target_systemd_dir.is_dir():
            for unit_file in systemd_dir.glob("*.service"):
                shutil.copy2(unit_file, target_systemd_dir / unit_file.name)
            try:
                check_output(["systemctl", "daemon-reload"], stderr=STDOUT)
            except (CalledProcessError, FileNotFoundError, OSError):
                pass

    try:
        subprocess.Popen(
            ["bash", "-c", "sleep 2 && systemctl restart raidcheck raidcheck-web"],
            cwd=str(REPO_DIR),
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as e:
        logging.warning(f"Could not spawn delayed service restart: {e}")

    return {
        "status": "updating",
        "target_version": target_version,
        "target_commit": info["latest_commit"],
        "message": f"Updated to v{target_version}. Restarting services in 2 seconds...",
    }


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


def discover_raid_devices() -> list[str]:
    """Discover active Linux md RAID array devices from /proc/mdstat and /dev/md*."""
    discovered: set[str] = set()
    mdstat_path = Path("/proc/mdstat")
    try:
        if mdstat_path.is_file():
            for line in mdstat_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                match = re.match(r"^(md\d+)\s*:", line.strip())
                if match:
                    discovered.add(f"/dev/{match.group(1)}")
    except OSError:
        pass

    try:
        for path_str in glob.glob("/dev/md[0-9]*"):
            if re.match(r"^/dev/md\d+$", path_str):
                discovered.add(path_str)
        for path_str in glob.glob("/dev/md/*"):
            if not path_str.endswith("-part") and not re.search(r"p\d+$", path_str):
                discovered.add(path_str)
    except OSError:
        pass

    return sorted(discovered)


def resolve_raid_device(configured_device: Optional[str] = None) -> Optional[str]:
    """Resolve the target md RAID device path from settings or dynamic discovery."""
    if configured_device is None:
        configured_device = get_app_settings().get("raid_device", "auto")
    cleaned = (configured_device or "").strip()
    discovered = discover_raid_devices()

    if cleaned == "" or cleaned.lower() in ("auto", "none"):
        return discovered[0] if discovered else None

    try:
        exists = Path(cleaned).exists()
    except OSError:
        exists = False

    if exists or cleaned in discovered:
        return cleaned
    if discovered:
        return discovered[0]
    return None


def check_raid_status() -> Tuple[str, str]:
    try:
        raid_device = resolve_raid_device()
        if raid_device is None:
            return "none", "No RAID array detected"
        result = check_output(
            ["mdadm", "--detail", raid_device], stderr=STDOUT
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
        mount_path = get_app_settings().get("mount_path") or "/mnt/media/"
        # Use --output to show only specific columns for narrower display
        result = check_output(
            ["duf", "--output", "size,used,avail,usage", mount_path],
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
    device_header_match = re.search(r"^(/dev/\S+?):", details, re.MULTILINE)
    if status == "none":
        raid_device = "None"
    else:
        raid_device = (
            device_header_match.group(1)
            if device_header_match
            else (resolve_raid_device() or "None")
        )
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
        if device_section and "/dev/" in line:
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

    full_state = (
        "No RAID array detected"
        if status == "none"
        else (state_match.group(1) if state_match else "unknown")
    )

    return {
        "raid_device": raid_device,
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
        "full_state": full_state,
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
        "none": 0x95A5A6,
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
    if status == "none":
        logging.info("No RAID array detected; skipping Discord notification")
        return

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

    settings = get_app_settings()
    discord_token = settings.get("discord_token") or config("DISCORD_TOKEN", default="")
    CHANNEL_ID = settings.get("channel_id") or config("CHANNEL_ID", default="")
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
