from pathlib import Path
import sqlite3
from typing import Any, Optional

from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
import psutil

import main

app = FastAPI(title="System Alerts Dashboard")

STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)


def get_system_metrics() -> dict[str, Any]:
    """Collect real-time system metrics via psutil."""
    cpu_percent = psutil.cpu_percent(interval=None)
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    boot_time = psutil.boot_time()

    return {
        "cpu_percent": cpu_percent,
        "memory": {
            "total": vm.total,
            "used": vm.used,
            "available": vm.available,
            "percent": vm.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
            "percent": disk.percent,
        },
        "boot_time": boot_time,
    }


def _get_formatted_notification_state() -> Optional[dict[str, Any]]:
    try:
        state = main.get_weekly_notification_state()
    except (OSError, sqlite3.Error):
        return None

    if state is None:
        return None

    sent_at, due_at, status = state
    return {
        "sent_at": sent_at,
        "sent_at_formatted": main.format_timestamp(sent_at),
        "due_at": due_at,
        "due_at_formatted": main.format_timestamp(due_at),
        "status": status,
    }


@app.get("/api/status")
def api_status() -> dict[str, Any]:
    raid_status, raid_details = main.check_raid_status()
    duf_output = main.get_duf_output()
    raid_summary = main._extract_raid_summary_data(raid_status, raid_details, duf_output)

    return {
        "raid": raid_summary,
        "system": get_system_metrics(),
        "notification_state": _get_formatted_notification_state(),
    }


@app.get("/api/history")
def api_history(limit: int = Query(default=20, ge=1)) -> dict[str, list[dict[str, Any]]]:
    try:
        rows = main.get_notification_history(limit)
    except (OSError, sqlite3.Error):
        rows = []

    history = [
        {
            "status": status,
            "sent_at": float(sent_at),
            "sent_at_formatted": main.format_timestamp(float(sent_at)),
            "weekly": bool(weekly),
            "kind": "weekly summary" if weekly else "alert",
        }
        for status, sent_at, weekly in rows
    ]
    return {"history": history}


@app.get("/")
def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.is_file():
        return FileResponse(index_file)
    return HTMLResponse(
        content="<!DOCTYPE html><html><head><title>System Alerts</title></head>"
        "<body><h1>System Alerts Dashboard</h1></body></html>",
        status_code=200,
    )


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
