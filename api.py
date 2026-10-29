import asyncio
import json
from pathlib import Path
import sqlite3
from subprocess import CalledProcessError
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import psutil

import main

app = FastAPI(title="System Alerts Dashboard")

STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        if websocket not in self.active_connections:
            self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        stale: list[WebSocket] = []
        for connection in list(self.active_connections):
            try:
                await connection.send_json(payload)
            except Exception:
                stale.append(connection)
        for connection in stale:
            self.disconnect(connection)


ws_manager = ConnectionManager()


class SetupRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = ""


class LoginRequest(BaseModel):
    username: str
    password: str


class GoogleAuthRequest(BaseModel):
    credential: Optional[str] = None
    id_token: Optional[str] = None


class SettingsUpdateRequest(BaseModel):
    discord_token: Optional[str] = None
    channel_id: Optional[str] = None
    raid_device: Optional[str] = None
    mount_path: Optional[str] = None
    google_client_id: Optional[str] = None
    allowed_google_emails: Optional[str] = None


def _extract_session_token(request: Request) -> Optional[str]:
    cookie_token = request.cookies.get("session_token")
    if cookie_token:
        return cookie_token.strip()
    auth_header = request.headers.get("authorization") or ""
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return None


def require_auth(request: Request) -> str:
    token = _extract_session_token(request)
    try:
        username = main.verify_session(token)
    except (OSError, sqlite3.Error):
        username = None

    if not username:
        raise HTTPException(status_code=401, detail="Authentication required")
    return username


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=main.SESSION_TTL_SECONDS,
        path="/",
    )


def verify_google_id_token(id_token: str) -> dict[str, Any]:
    url = f"https://oauth2.googleapis.com/tokeninfo?{urlencode({'id_token': id_token})}"
    try:
        with urlopen(url, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            if not isinstance(payload, dict):
                raise HTTPException(status_code=401, detail="Invalid Google token payload")
            return payload
    except (HTTPError, URLError, ValueError, OSError) as exc:
        raise HTTPException(status_code=401, detail=f"Invalid Google ID token: {exc}") from exc


def _is_google_email_allowed(email: str, settings: dict[str, str]) -> bool:
    clean_email = email.strip().lower()
    if not clean_email:
        return False

    allowed_raw = settings.get("allowed_google_emails", "")
    allowed_set = {
        item.strip().lower() for item in allowed_raw.split(",") if item.strip()
    }
    if clean_email in allowed_set:
        return True

    try:
        conn = main._connect_state_db()
        try:
            row = conn.execute(
                "SELECT 1 FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?",
                (clean_email, clean_email),
            ).fetchone()
            if row:
                return True
        finally:
            conn.close()
    except (OSError, sqlite3.Error):
        pass

    try:
        if not allowed_set and not main.has_any_user():
            return True
    except (OSError, sqlite3.Error):
        pass

    return False


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


def _get_formatted_history(limit: int = 20) -> list[dict[str, Any]]:
    try:
        rows = main.get_notification_history(limit)
    except (OSError, sqlite3.Error):
        rows = []

    return [
        {
            "status": status,
            "sent_at": float(sent_at),
            "sent_at_formatted": main.format_timestamp(float(sent_at)),
            "weekly": bool(weekly),
            "kind": "weekly summary" if weekly else "alert",
        }
        for status, sent_at, weekly in rows
    ]


def _get_raid_summary() -> dict[str, Any]:
    raid_status, raid_details = main.check_raid_status()
    duf_output = main.get_duf_output()
    raid_summary = main._extract_raid_summary_data(
        raid_status, raid_details, duf_output
    )
    raid_summary.setdefault("raid_device", main.resolve_raid_device() or "None")
    return raid_summary


def _build_full_snapshot() -> dict[str, Any]:
    return {
        "type": "snapshot",
        "raid": _get_raid_summary(),
        "system": get_system_metrics(),
        "notification_state": _get_formatted_notification_state(),
        "history": _get_formatted_history(20),
        "version": main.get_current_version_info(),
    }


def _build_module_update(module_name: str) -> dict[str, Any]:
    mod = (module_name or "").strip().lower()
    if mod == "system":
        return {
            "type": "module_update",
            "module": "system",
            "system": get_system_metrics(),
        }
    if mod in ("raid", "disks"):
        return {
            "type": "module_update",
            "module": mod,
            "raid": _get_raid_summary(),
        }
    if mod in ("schedule", "notification_state"):
        return {
            "type": "module_update",
            "module": mod,
            "notification_state": _get_formatted_notification_state(),
        }
    if mod == "history":
        return {
            "type": "module_update",
            "module": "history",
            "history": _get_formatted_history(20),
        }
    return _build_full_snapshot()


def _format_settings_response(settings: dict[str, str]) -> dict[str, Any]:
    raw_token = settings.get("discord_token", "")
    discord_token_configured = bool(raw_token)
    if len(raw_token) > 4:
        discord_token_masked = f"••••{raw_token[-4:]}"
    elif raw_token:
        discord_token_masked = "••••"
    else:
        discord_token_masked = ""

    configured_raid_device = settings.get("raid_device", "auto") or "auto"
    return {
        "channel_id": settings.get("channel_id", ""),
        "discord_token_configured": discord_token_configured,
        "discord_token_masked": discord_token_masked,
        "raid_device": configured_raid_device,
        "available_raid_devices": main.discover_raid_devices(),
        "resolved_raid_device": main.resolve_raid_device(configured_raid_device),
        "mount_path": settings.get("mount_path", "/mnt/media/") or "/mnt/media/",
        "google_client_id": settings.get("google_client_id", ""),
        "allowed_google_emails": settings.get("allowed_google_emails", ""),
    }


@app.get("/api/auth/status")
def api_auth_status(request: Request) -> dict[str, Any]:
    token = _extract_session_token(request)
    try:
        username = main.verify_session(token)
    except (OSError, sqlite3.Error):
        username = None

    try:
        setup_required = not main.has_any_user()
    except (OSError, sqlite3.Error):
        setup_required = True

    settings = main.get_app_settings()
    return {
        "authenticated": username is not None,
        "username": username,
        "setup_required": setup_required,
        "google_client_id": settings.get("google_client_id", ""),
    }


@app.post("/api/auth/setup")
def api_auth_setup(payload: SetupRequest, response: Response) -> dict[str, Any]:
    if main.has_any_user():
        raise HTTPException(
            status_code=400, detail="Initial admin setup has already been completed."
        )

    username = payload.username.strip()
    password = payload.password
    if not username or len(password) < 4:
        raise HTTPException(
            status_code=400,
            detail="Username is required and password must be at least 4 characters.",
        )

    main.create_user(username, password, email=payload.email or "")
    token = main.create_session(username)
    _set_session_cookie(response, token)
    return {
        "authenticated": True,
        "username": username,
        "token": token,
    }


@app.post("/api/auth/login")
def api_auth_login(payload: LoginRequest, response: Response) -> dict[str, Any]:
    username = payload.username.strip()
    if not main.verify_user(username, payload.password):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    token = main.create_session(username)
    _set_session_cookie(response, token)
    return {
        "authenticated": True,
        "username": username,
        "token": token,
    }


@app.post("/api/auth/google")
def api_auth_google(payload: GoogleAuthRequest, response: Response) -> dict[str, Any]:
    raw_token = (payload.credential or payload.id_token or "").strip()
    if not raw_token:
        raise HTTPException(status_code=400, detail="Missing Google ID token")

    token_info = verify_google_id_token(raw_token)
    email = str(token_info.get("email") or "").strip().lower()
    email_verified = str(token_info.get("email_verified") or "").lower() in (
        "true",
        "1",
    )
    if not email or not email_verified:
        raise HTTPException(status_code=401, detail="Google account email is not verified")

    settings = main.get_app_settings()
    expected_client_id = settings.get("google_client_id", "").strip()
    if expected_client_id and token_info.get("aud") != expected_client_id:
        raise HTTPException(status_code=401, detail="Google client ID mismatch")

    if not _is_google_email_allowed(email, settings):
        raise HTTPException(
            status_code=403,
            detail="Google email is not authorized for this dashboard",
        )

    username = main.get_or_create_google_user(email)
    session_token = main.create_session(username)
    _set_session_cookie(response, session_token)
    return {
        "authenticated": True,
        "username": username,
        "token": session_token,
    }


@app.post("/api/auth/logout")
def api_auth_logout(request: Request, response: Response) -> dict[str, Any]:
    token = _extract_session_token(request)
    if token:
        try:
            main.delete_session(token)
        except (OSError, sqlite3.Error):
            pass
    response.delete_cookie(key="session_token", path="/")
    return {"authenticated": False}


@app.get("/api/status")
def api_status(_user: str = Depends(require_auth)) -> dict[str, Any]:
    return {
        "raid": _get_raid_summary(),
        "system": get_system_metrics(),
        "notification_state": _get_formatted_notification_state(),
        "version": main.get_current_version_info(),
    }


@app.get("/api/history")
def api_history(
    limit: int = Query(default=20, ge=1),
    _user: str = Depends(require_auth),
) -> dict[str, list[dict[str, Any]]]:
    return {"history": _get_formatted_history(limit)}


def _extract_ws_token(websocket: WebSocket) -> Optional[str]:
    cookie_token = websocket.cookies.get("session_token")
    if cookie_token:
        return cookie_token.strip()
    query_token = websocket.query_params.get("token")
    if query_token:
        return query_token.strip()
    auth_header = websocket.headers.get("authorization") or ""
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return None


@app.websocket("/api/ws")
async def api_websocket(websocket: WebSocket) -> None:
    token = _extract_ws_token(websocket)
    try:
        username = main.verify_session(token)
    except (OSError, sqlite3.Error):
        username = None

    if not username:
        await websocket.accept()
        await websocket.close(code=4401)
        return

    await ws_manager.connect(websocket)
    try:
        await websocket.send_json(_build_full_snapshot())
        tick = 0
        while True:
            try:
                raw_text = await asyncio.wait_for(
                    websocket.receive_text(), timeout=2.0
                )
                try:
                    data = json.loads(raw_text)
                except ValueError:
                    data = {}
                if isinstance(data, dict):
                    action = data.get("action")
                    if action == "refresh":
                        await websocket.send_json(_build_full_snapshot())
                    elif action == "refresh_module":
                        await websocket.send_json(
                            _build_module_update(str(data.get("module") or ""))
                        )
            except asyncio.TimeoutError:
                tick += 1
                if tick % 5 == 0:
                    await websocket.send_json(_build_full_snapshot())
                else:
                    await websocket.send_json(_build_module_update("system"))
    except WebSocketDisconnect:
        pass
    finally:
        ws_manager.disconnect(websocket)


@app.get("/api/settings")
def api_get_settings(_user: str = Depends(require_auth)) -> dict[str, Any]:
    settings = main.get_app_settings()
    return _format_settings_response(settings)


@app.post("/api/settings")
def api_update_settings(
    payload: SettingsUpdateRequest,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if payload.discord_token is not None and payload.discord_token.strip() != "":
        updates["discord_token"] = payload.discord_token.strip()
    if payload.channel_id is not None:
        updates["channel_id"] = payload.channel_id.strip()
    if payload.raid_device is not None and payload.raid_device.strip() != "":
        updates["raid_device"] = payload.raid_device.strip()
    if payload.mount_path is not None and payload.mount_path.strip() != "":
        updates["mount_path"] = payload.mount_path.strip()
    if payload.google_client_id is not None:
        updates["google_client_id"] = payload.google_client_id.strip()
    if payload.allowed_google_emails is not None:
        updates["allowed_google_emails"] = payload.allowed_google_emails.strip()

    updated = main.update_app_settings(updates)
    result = _format_settings_response(updated)
    result["saved"] = True
    return result


@app.get("/api/update/check")
def api_update_check(_user: str = Depends(require_auth)) -> dict[str, Any]:
    return main.check_for_release_update()


@app.post("/api/update/apply")
def api_update_apply(_user: str = Depends(require_auth)) -> dict[str, Any]:
    try:
        return main.apply_release_update()
    except (CalledProcessError, OSError) as exc:
        detail = (
            exc.output.decode("utf-8", errors="replace")
            if isinstance(exc, CalledProcessError) and exc.output
            else str(exc)
        )
        raise HTTPException(
            status_code=500, detail=f"Failed to apply release update: {detail}"
        ) from exc


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
