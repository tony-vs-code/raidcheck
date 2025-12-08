## Setup

The bot will check the RAID status every 2 hours, however, it will only send a clean raid summary once a week. As soon as it sees a degraded state, it will send a message. I would highly reccomend setting this up in `/usr/local/bin/`.

1. **Clone the repository:**

    ```sh
    git clone https://github.com/tony-vs-code/raidcheck
    cd raidcheck
    ```

2. **Create and activate a virtual environment:**

    ```sh
    uv venv
    source .venv/bin/activate  # On Windows use `.venv\Scripts\activate`
    ```

3. **Install the dependencies:**

    ```sh
    uv pip install -r requirements.txt
    ```

4. **Configure environment variables:**

    Create a `.env` file in the root directory with the following content:

    ```env
    DISCORD_TOKEN=<your-discord-bot-token>
    CHANNEL_ID=<your-discord-channel-id>
    ```

## Usage

>[!NOTE]
>Please make sure to replace `<your-discord-bot-token>` and `<your-discord-channel-id>` in the `.env` file with your actual Discord bot token and channel ID before running.

### Run the bot:

    ```sh
    python main.py
    ```
    
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
ExecStart=/bin/sh -c '/usr/local/bin/raidcheck/.venv/bin/python /usr/local/bin/raidcheck/main.py'
Restart=always

[Install]
WantedBy=multi-user.target
```

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
