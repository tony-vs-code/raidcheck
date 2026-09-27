## Setup

The bot checks RAID status every 2 hours and sends a clean or active summary at most once a week. Other RAID states are sent as alerts on each check. The weekly due time and sent-notification history are stored in SQLite. I would highly reccomend setting this up in `/usr/local/bin/`.

1. **Clone the repository:**

    ```sh
    git clone https://github.com/tony-vs-code/raidcheck
    cd raidcheck
    ```

2. **Create the environment and install dependencies:**

    ```sh
    uv sync
    ```

    This creates `.venv` using the Python version in `.python-version` and installs the locked dependencies from `pyproject.toml` and `uv.lock`.

3. **Configure environment variables:**

    Create a `.env` file in the root directory with the following content:

    ```env
    DISCORD_TOKEN=<your-discord-bot-token>
    CHANNEL_ID=<your-discord-channel-id>
    RAID_STATE_DB=/var/lib/raidcheck/raid_monitor.sqlite3
    RAID_LOG_MAX_BYTES=10485760
    RAID_LOG_BACKUP_COUNT=5
    ```

    `RAID_STATE_DB` stores the last successful weekly summary, its next due time, and notification history in SQLite. The bot creates the database directory if needed; the service user must be able to write to it. Keep this database on persistent storage so restarts do not reset the weekly limit.

    The application log rotates at 10 MiB by default and keeps five rotated files, for an approximate 60 MiB total cap. Adjust `RAID_LOG_MAX_BYTES` and `RAID_LOG_BACKUP_COUNT` to change that limit.

## Usage

>[!NOTE]
>Please make sure to replace `<your-discord-bot-token>` and `<your-discord-channel-id>` in the `.env` file with your actual Discord bot token and channel ID before running.

### Run the bot:

    ```sh
    uv run main.py
    ```

### Check notification status and history from a terminal:

    ```sh
    uv run main.py status
    uv run main.py logs --limit 20
    ```

The status and history commands do not require Discord credentials. To follow the application log file while the bot runs and across rotations, use `sudo tail -F /var/log/raid_monitor.log`. Rotated files are kept alongside it as `raid_monitor.log.1` through `raid_monitor.log.5`. For service output, use `sudo journalctl -u raidcheck -f`.
    
### Run as a service:

1. Create a new service unit file using a text editor:

```sudo nano /etc/systemd/system/raidcheck.service```

2. Add the following content to the file:

```
[Unit]
Description=Raidcheck Discord Bot
After=network.target

[Service]
User=root
Group=root
WorkingDirectory=/usr/local/bin/raidcheck/
ExecStart=/usr/local/bin/raidcheck/.venv/bin/python /usr/local/bin/raidcheck/main.py
Restart=always

[Install]
WantedBy=multi-user.target
```

The systemd service uses the virtual environment created by `uv`; `uv` itself does not need to run as part of the service.

3. Reload systemctl

```sh
sudo systemctl daemon-reload
```

4. Start the service

```sh
sudo systemctl start raidcheck
```

5. Enable the service to auto start

```sh
sudo systemctl enable raidcheck
```

Now the bot will run as a service and automatically start on boot. You can check the status of the service using the following command:

```sh
sudo systemctl status raidcheck
```

To stop the bot service, use:

```sh
sudo systemctl stop raidcheck
```

To disable the bot service from starting on boot, use:

```sh
sudo systemctl disable raidcheck
```

## Code Overview

- `main.py`: Contains the main logic for the Discord bot, including functions to check RAID status and send messages.
- `.env`: Stores environment variables for the Discord bot token and channel ID.
- `requirements.txt`: Lists the Python dependencies for the project.

## Functions

- `check_raid_status()`: Checks the status of the RAID array using [`mdadm`]
- `monitor_raid()`: Periodically checks the RAID status and sends notifications to Discord.
- `send_message(message)`: Sends a message to the specified Discord channel.

## Logging

Logs are written to `/var/log/raid_monitor.log` so you can always validate it's running.
