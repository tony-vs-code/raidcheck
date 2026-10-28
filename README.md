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

### Run the FastAPI web dashboard:

    ```sh
    uv run main.py web --host 0.0.0.0 --port 8000
    ```

Once running, open [http://localhost:8000](http://localhost:8000) in your browser to view the dashboard locally. Real-time system metrics (`psutil` CPU, memory, disk usage, and uptime) and notification history work out-of-the-box on any machine, even in local development environments where `mdadm` or `duf` are not installed.

### API Endpoints

- `GET /`: Serves the web dashboard (`static/index.html`), with static assets mounted at `/static`.
- `GET /api/status`: Returns a JSON payload with `raid` summary details, real-time `system` metrics (`cpu_percent`, `memory`, `disk`, `boot_time`), and `notification_state` (`sent_at`, `sent_at_formatted`, `due_at`, `due_at_formatted`, `status`).
- `GET /api/history`: Returns recent notification history (`?limit=20` by default) as `{"history": [{"status", "sent_at", "sent_at_formatted", "weekly", "kind"}]}`.

### Run the test suite:

    ```sh
    uv run pytest -v
    ```
    
### Run as a service:

1. Create the Discord bot service unit file:

```sh
sudo nano /etc/systemd/system/raidcheck.service
```

2. Add the following content to `/etc/systemd/system/raidcheck.service`:

```ini
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

3. (Optional) Create the FastAPI Web Dashboard service unit file:

```sh
sudo nano /etc/systemd/system/raidcheck-web.service
```

4. Add the following content to `/etc/systemd/system/raidcheck-web.service`:

```ini
[Unit]
Description=Raidcheck FastAPI Web Dashboard
After=network.target

[Service]
User=root
Group=root
WorkingDirectory=/usr/local/bin/raidcheck/
ExecStart=/usr/local/bin/raidcheck/.venv/bin/python /usr/local/bin/raidcheck/main.py web --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
```

The systemd services use the virtual environment created by `uv`; `uv` itself does not need to run as part of the service.

5. Reload `systemctl`:

```sh
sudo systemctl daemon-reload
```

6. Start both services:

```sh
sudo systemctl start raidcheck raidcheck-web
```

7. Enable both services to auto-start on boot:

```sh
sudo systemctl enable raidcheck raidcheck-web
```

Now both the Discord bot and web dashboard will run as services and automatically start on boot. You can check their status using:

```sh
sudo systemctl status raidcheck raidcheck-web
```

To stop the services, use:

```sh
sudo systemctl stop raidcheck raidcheck-web
```

To disable the services from starting on boot, use:

```sh
sudo systemctl disable raidcheck raidcheck-web
```

## Code Overview

- `main.py`: Contains the main logic for the Discord bot, CLI subcommands (`status`, `logs`, `web`), and functions to check RAID status, parse storage metrics, and send messages.
- `api.py`: FastAPI application exposing system metrics (`psutil`), RAID status, notification history, and serving the web dashboard.
- `static/`: Frontend dashboard static assets (`index.html`, styles, and client scripts).
- `pyproject.toml`: Project metadata and Python dependency definitions managed with `uv`.
- `test_main.py`: Unit and API test suite for RAID formatting, notification state, and FastAPI endpoints.
- `.env`: Stores environment variables for the Discord bot token, channel ID, and SQLite database path.

## Functions

- `check_raid_status()`: Checks the status of the RAID array using [`mdadm`]
- `monitor_raid()`: Periodically checks the RAID status and sends notifications to Discord.
- `send_message(message)`: Sends a message to the specified Discord channel.

## Logging

Logs are written to `/var/log/raid_monitor.log` so you can always validate it's running.
