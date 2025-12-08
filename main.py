import time
import discord
import logging
from decouple import config
from discord.ext import tasks
from subprocess import check_output, CalledProcessError, STDOUT
from typing import Tuple
import re

# Configure logging
logging.basicConfig(
    filename="/var/log/raid_monitor.log",  # Log file path
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

# Discord bot token and channel ID
DISCORD_TOKEN = config("DISCORD_TOKEN")
CHANNEL_ID = config("CHANNEL_ID")

if not DISCORD_TOKEN or not CHANNEL_ID:
    logging.error("DISCORD_TOKEN or CHANNEL_ID not set in environment variables.")
    exit(1)

client = discord.Client(intents=discord.Intents.default())


async def send_message(message: str) -> None:
    try:
        channel = client.get_channel(int(CHANNEL_ID))
        if channel:
            await channel.send(message)
        else:
            logging.error(f"Channel with ID {CHANNEL_ID} not found.")
    except Exception as e:
        logging.error(f"Failed to send message: {e}")


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
        failed_devices_match = re.search(r"Failed Devices : (\d+)", details)
        update_time_match = re.search(r"Update Time : (.+)", details)
        persistence_match = re.search(r"Persistence : (.+)", details)

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

        # --- FIX: Correctly parse duf's formatted table output ---
        storage_info = "N/A"
        for line in duf_output.split("\n"):
            # Find the data line, which contains the box characters and size units
            if "│" in line and ("T" in line or "G" in line):
                # Clean the line by removing the box characters and splitting
                # Example line: │ 63.4T │ 16.4T │ 43.8T │ [#####...]  25.9% │
                parts = line.replace("│", " ").strip().split()
                # Resulting parts: ['63.4T', '16.4T', '43.8T', '[#####...]', '25.9%']
                if len(parts) >= 5:
                    size, used, avail, usage_percent = (
                        parts[0],
                        parts[1],
                        parts[2],
                        parts[-1],
                    )
                    storage_info = f"{used}/{size} ({usage_percent}) | {avail} free"
                    break  # Found the data, no need to continue

        # Build values
        raid_level = level_match.group(1) if level_match else "unknown"
        array_size = array_size_match.group(1) if array_size_match else "unknown"
        active_devices = active_devices_match.group(1) if active_devices_match else "0"
        failed_devices = failed_devices_match.group(1) if failed_devices_match else "0"
        update_time = update_time_match.group(1) if update_time_match else "unknown"
        persistence = persistence_match.group(1) if persistence_match else "unknown"

        # --- Create unified table format with corrected widths ---
        content_width = 43
        full_width = 61

        header = f"╭{'─' * full_width}╮"
        title = (
            f"│ RAID {raid_level.upper()} SYSTEM STATUS - {status.upper()}".ljust(
                full_width
            )
            + " │"
        )
        separator = f"├───────────────┬{'─' * (content_width + 2)}┤"

        rows = [
            f"│ Status        │ {status.capitalize():<{content_width}} │",
            f"│ Array Size    │ {array_size:<{content_width}} │",
            f"│ Devices       │ {f'{active_devices} active, {failed_devices} failed':<{content_width}} │",
            f"│ Persistence   │ {persistence:<{content_width}} │",
            f"│ Last Update   │ {update_time:<{content_width}} │",
            f"│ Storage Usage │ {storage_info:<{content_width}} │",
        ]

        # Add Active Disks section as full-width nested table
        device_separator = f"├{'─' * full_width}┤"
        rows.append(device_separator)
        rows.append(f"│ Active Disks{' ' * (full_width - 12)}│")

        device_header_sep = f"├─────┬────────┬{'─' * (content_width - 6)}┤"
        rows.append(device_header_sep)
        rows.append(f"│ No. │ Device │ State{' ' * (content_width - 12)}│")
        rows.append(device_header_sep)

        if devices:
            for device in devices:
                device_num = device["number"].rjust(3)
                device_name = device["device"].ljust(6)
                device_state = device["state"]

                state_width = content_width - 8
                if len(device_state) > state_width:
                    device_state = device_state[: state_width - 3] + "..."
                else:
                    device_state = device_state.ljust(state_width)

                rows.append(f"│ {device_num} │ {device_name} │ {device_state} │")
        else:
            rows.append(
                f"│     │        │ {'No device information available':<{content_width - 8}} │"
            )

        footer = f"╰─────┴────────┴{'─' * (content_width - 6)}╯"

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
        if (
            not hasattr(monitor_raid, "last_clean_notification")
            or time.time() - monitor_raid.last_clean_notification > 604800
        ):  # 604800 seconds = 1 week
            logging.info(f"RAID Array {status.capitalize()} Sending Message")
            await send_message(f"```\n{message_content}\n```")
            monitor_raid.last_clean_notification = time.time()
    else:
        logging.info(f"RAID Array {status.capitalize()} Sending Message")
        await send_message(f"```\n{message_content}\n```")


client.run(DISCORD_TOKEN)
