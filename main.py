import time
import discord
import logging
from decouple import config
from discord.ext import tasks
from subprocess import check_output, CalledProcessError, STDOUT
from typing import Tuple

# Configure logging
logging.basicConfig(
    filename='/var/log/raid_monitor.log',  # Log file path
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Discord bot token and channel ID
DISCORD_TOKEN = config('DISCORD_TOKEN')
CHANNEL_ID = config('CHANNEL_ID')

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
        result = check_output(['mdadm', '--detail', '/dev/md127'], stderr=STDOUT).decode()
        if 'State : clean' in result:
            return 'clean', result
        elif 'State : active' in result:
            return 'active', result
        elif 'State : degraded' in result:
            return 'degraded', result
        elif 'State : recovering' in result:
            return 'recovering', result
        elif 'State : resyncing' in result:
            return 'resyncing', result
        elif 'State : failed' in result:
            return 'failed', result
        else:
            return 'unknown', result
    except CalledProcessError as e:
        logging.error(f"Error checking RAID status: {e.output.decode()}")
        return 'error', e.output.decode()

@client.event
async def on_ready() -> None:
    logging.info(f'Logged in as {client.user}')
    monitor_raid.start()

@tasks.loop(minutes=1)
async def monitor_raid() -> None:
    status, details = check_raid_status()
    if status in ['clean', 'active']:
        if not hasattr(monitor_raid, 'last_clean_notification') or \
           time.time() - monitor_raid.last_clean_notification > 86400:
            logging.info(f'RAID Array {status.capitalize()} Sending Message')
            await send_message(f'``` \n RAID Array {status.capitalize()}:\n{details} \n ```')
            monitor_raid.last_clean_notification = time.time()
    else:
        logging.info(f'RAID Array {status.capitalize()} Sending Message')
        await send_message(f'``` \n RAID Array {status.capitalize()}:\n{details} \n ```')

client.run(DISCORD_TOKEN)