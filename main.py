import time
import discord
import logging
from decouple import config
from discord.ext import tasks
from subprocess import check_output, CalledProcessError, STDOUT

# Configure logging
logging.basicConfig(level=logging.INFO)

# Discord bot token and channel ID
DISCORD_TOKEN = config('DISCORD_TOKEN')
CHANNEL_ID = config('CHANNEL_ID')

if not DISCORD_TOKEN or not CHANNEL_ID:
    logging.error("DISCORD_TOKEN or CHANNEL_ID not set in environment variables.")
    exit(1)

client = discord.Client(intents=discord.Intents.default())

async def send_message(message):
    try:
        channel = client.get_channel(int(CHANNEL_ID))
        if channel:
            await channel.send(message)
        else:
            logging.error(f"Channel with ID {CHANNEL_ID} not found.")
    except Exception as e:
        logging.error(f"Failed to send message: {e}")

def check_raid_status():
    try:
        result = check_output(['mdadm', '--detail', '/dev/md127'], stderr=STDOUT).decode()
        if 'State : clean' in result:
            return 'clean', result
        else:
            return 'degraded', result
    except CalledProcessError as e:
        logging.error(f"Error checking RAID status: {e.output.decode()}")
        return 'error', e.output.decode()

@client.event
async def on_ready():
    logging.info(f'Logged in as {client.user}')
    monitor_raid.start()

@tasks.loop(minutes=1)
async def monitor_raid():
    status, details = check_raid_status()
    if status == 'degraded':
        await send_message(f'``` \n RAID Array Degraded:\n{details} \n ```')
    elif status == 'clean':
        if not hasattr(monitor_raid, 'last_clean_notification') or \
           time.time() - monitor_raid.last_clean_notification > 86400:
            await send_message(f'``` \n RAID Array Clean:\n{details} \n ```')
            monitor_raid.last_clean_notification = time.time()
    elif status == 'error':
        await send_message(f'``` \n Error checking RAID status:\n{details} \n ```')

client.run(DISCORD_TOKEN)