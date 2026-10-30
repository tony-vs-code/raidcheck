import asyncio
from contextlib import asynccontextmanager
import json
import logging
from pathlib import Path
import re
import sqlite3
from subprocess import CalledProcessError
import time
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

import aiohttp
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

STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

_docker_events_task: Optional[asyncio.Task] = None


async def docker_events_listener(
    socket_path: str = "/var/run/docker.sock",
    max_backoff: float = 60.0,
) -> None:
    """Stream real-time Docker events over Unix domain socket and notify WebSockets."""
    backoff = 2.0
    while True:
        try:
            if not Path(socket_path).exists():
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)
                continue

            connector = aiohttp.UnixConnector(path=socket_path)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.get("http://localhost/events") as resp:
                    if resp.status != 200:
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, max_backoff)
                        continue

                    backoff = 2.0
                    async for line in resp.content:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line.decode("utf-8"))
                        except (ValueError, UnicodeDecodeError):
                            continue

                        event_type = event.get("Type", "")
                        action = event.get("Action", "")

                        lifecycle_actions = {
                            "start",
                            "stop",
                            "die",
                            "restart",
                            "kill",
                            "destroy",
                            "pause",
                            "unpause",
                            "health_status",
                            "create",
                        }
                        is_lifecycle = (
                            event_type == "container"
                            and (
                                action in lifecycle_actions
                                or action.startswith("health_status")
                            )
                        )

                        if is_lifecycle:
                            main.docker_manager.invalidate_cache()
                            actor = event.get("Actor", {})
                            attributes = actor.get("Attributes", {})
                            notification_payload = {
                                "type": "docker_event",
                                "event": {
                                    "action": action,
                                    "type": event_type,
                                    "id": str(actor.get("ID", ""))[:12],
                                    "name": attributes.get("name", ""),
                                    "time": event.get("time", time.time()),
                                },
                                "docker": main.docker_mgr.get_status(),
                            }
                            await ws_manager.broadcast(notification_payload)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logging.debug(f"Docker events listener error: {exc}")
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                break
            backoff = min(backoff * 2, max_backoff)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _docker_events_task
    if _docker_events_task is None or _docker_events_task.done():
        _docker_events_task = asyncio.create_task(docker_events_listener())
    try:
        yield
    finally:
        if _docker_events_task and not _docker_events_task.done():
            _docker_events_task.cancel()
            try:
                await _docker_events_task
            except (asyncio.CancelledError, Exception):
                pass


app = FastAPI(title="SystemAlerts Server Manager", lifespan=lifespan)


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
    discord_enabled: Optional[bool] = None
    raid_device: Optional[str] = None
    mount_path: Optional[str] = None
    google_client_id: Optional[str] = None
    allowed_google_emails: Optional[str] = None
    refresh_system_sec: Optional[int | str] = None
    refresh_raid_sec: Optional[int | str] = None
    refresh_notifications_sec: Optional[int | str] = None
    refresh_docker_sec: Optional[int | str] = None
    docker_auto_update_frequency: Optional[str] = None
    timezone: Optional[str] = None


class StackCreateRequest(BaseModel):
    name: str
    compose_yaml: str
    deploy: Optional[bool] = True


class StackActionRequest(BaseModel):
    action: str


class ContainerActionRequest(BaseModel):
    action: str


class ImagePullRequest(BaseModel):
    image: Optional[str] = None
    image_tag: Optional[str] = None


class ImagePruneRequest(BaseModel):
    all: Optional[bool] = False


class UpdatesConfigRequest(BaseModel):
    frequency: str


class UpdatesApplyRequest(BaseModel):
    containers: Optional[list[str]] = None
    stacks: Optional[list[str]] = None


class UpdateScheduleRequest(BaseModel):
    enabled: Optional[bool] = False
    day: Optional[str] = "daily"
    time: Optional[str] = "03:00"
    notify_discord: Optional[bool] = True


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
            "kind": (
                "test notification"
                if status == "test"
                else ("weekly summary" if weekly else "alert")
            ),
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
    settings = main.get_app_settings()
    tz = settings.get("timezone", "UTC")
    return {
        "type": "snapshot",
        "raid": _get_raid_summary(),
        "system": get_system_metrics(),
        "notification_state": _get_formatted_notification_state(),
        "history": _get_formatted_history(20),
        "version": main.get_current_version_info(),
        "refresh_intervals": main.get_refresh_intervals(),
        "timezone": tz,
        "settings": {
            "timezone": tz,
        },
        "docker": main.docker_mgr.get_status(),
    }


async def _build_module_update(module_name: str) -> dict[str, Any]:
    mod = (module_name or "").strip().lower()
    if mod == "system":
        return {
            "type": "module_update",
            "module": "system",
            "system": get_system_metrics(),
        }
    if mod in ("raid", "disks"):
        raid = _get_raid_summary()
        adaptive_fast = raid.get("status") in ("recovering", "resyncing", "degraded")
        intervals = main.get_refresh_intervals()
        effective_interval = (
            min(intervals["raid"], 5)
            if adaptive_fast and intervals["raid"] > 0
            else intervals["raid"]
        )
        return {
            "type": "module_update",
            "module": "raid",
            "raid": raid,
            "adaptive_fast": adaptive_fast,
            "effective_interval": effective_interval,
        }
    if mod in ("notifications", "schedule", "notification_state", "history"):
        return {
            "type": "module_update",
            "module": "notifications",
            "notification_state": _get_formatted_notification_state(),
            "history": _get_formatted_history(20),
        }
    if mod in ("docker", "containers"):
        docker_status = await asyncio.to_thread(main.docker_mgr.get_status)
        return {
            "type": "module_update",
            "module": "docker",
            "docker": docker_status,
        }
    return await asyncio.to_thread(_build_full_snapshot)


def _format_settings_response(settings: dict[str, str]) -> dict[str, Any]:
    raw_token = settings.get("discord_token", "")
    discord_token_configured = bool(raw_token)
    if len(raw_token) > 4:
        discord_token_masked = f"••••{raw_token[-4:]}"
    elif raw_token:
        discord_token_masked = "••••"
    else:
        discord_token_masked = ""

    discord_enabled = settings.get("discord_enabled", "false").strip().lower() == "true"
    configured_raid_device = settings.get("raid_device", "auto") or "auto"
    return {
        "channel_id": settings.get("channel_id", ""),
        "discord_token_configured": discord_token_configured,
        "discord_token_masked": discord_token_masked,
        "discord_enabled": discord_enabled,
        "raid_device": configured_raid_device,
        "available_raid_devices": main.discover_raid_devices(),
        "resolved_raid_device": main.resolve_raid_device(configured_raid_device),
        "mount_path": settings.get("mount_path", "/mnt/media/") or "/mnt/media/",
        "google_client_id": settings.get("google_client_id", ""),
        "allowed_google_emails": settings.get("allowed_google_emails", ""),
        "refresh_intervals": main.get_refresh_intervals(settings),
        "docker_auto_update_frequency": settings.get(
            "docker_auto_update_frequency", "disabled"
        ),
        "docker_auto_update_schedule": main.get_docker_auto_update_schedule(),
        "timezone": settings.get("timezone", "UTC"),
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
    settings = main.get_app_settings()
    tz = settings.get("timezone", "UTC")
    return {
        "raid": _get_raid_summary(),
        "system": get_system_metrics(),
        "notification_state": _get_formatted_notification_state(),
        "version": main.get_current_version_info(),
        "timezone": tz,
        "settings": {
            "timezone": tz,
        },
    }


@app.get("/api/history")
def api_history(
    limit: int = Query(default=20, ge=1),
    _user: str = Depends(require_auth),
) -> dict[str, list[dict[str, Any]]]:
    return {"history": _get_formatted_history(limit)}


@app.post("/api/notifications/test")
async def api_send_test_notification(
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    success, message = await main.send_test_notification()
    return {"success": success, "message": message}


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
        initial_snapshot = await asyncio.to_thread(_build_full_snapshot)
        last_raid_status = initial_snapshot.get("raid", {}).get("status", "unknown")
        await websocket.send_json(initial_snapshot)
        elapsed = {"system": 0, "raid": 0, "notifications": 0, "docker": 0}
        while True:
            try:
                raw_text = await asyncio.wait_for(
                    websocket.receive_text(), timeout=1.0
                )
                try:
                    data = json.loads(raw_text)
                except ValueError:
                    data = {}
                if isinstance(data, dict):
                    action = data.get("action")
                    if action == "refresh":
                        snap = await asyncio.to_thread(_build_full_snapshot)
                        last_raid_status = snap.get("raid", {}).get(
                            "status", last_raid_status
                        )
                        elapsed = {"system": 0, "raid": 0, "notifications": 0, "docker": 0}
                        await websocket.send_json(snap)
                    elif action == "refresh_module":
                        mod_payload = await _build_module_update(
                            str(data.get("module") or "")
                        )
                        if (
                            mod_payload.get("module") == "raid"
                            and "raid" in mod_payload
                        ):
                            last_raid_status = mod_payload["raid"].get(
                                "status", last_raid_status
                            )
                        await websocket.send_json(mod_payload)
                    elif action == "set_intervals":
                        raw_intervals = (
                            data.get("intervals")
                            if isinstance(data.get("intervals"), dict)
                            else data
                        )
                        interval_updates: dict[str, str] = {}
                        for key_short, setting_key in (
                            ("system", "refresh_system_sec"),
                            ("raid", "refresh_raid_sec"),
                            ("notifications", "refresh_notifications_sec"),
                            ("docker", "refresh_docker_sec"),
                        ):
                            val = raw_intervals.get(key_short)
                            if val is None:
                                val = raw_intervals.get(setting_key)
                            if val is not None:
                                try:
                                    interval_updates[setting_key] = str(
                                        max(0, int(val))
                                    )
                                except (ValueError, TypeError):
                                    pass
                        if interval_updates:
                            main.update_app_settings(interval_updates)
                        await websocket.send_json(
                            {
                                "type": "intervals_updated",
                                "refresh_intervals": main.get_refresh_intervals(),
                            }
                        )
            except asyncio.TimeoutError:
                intervals = main.get_refresh_intervals()
                elapsed["system"] += 1
                elapsed["raid"] += 1
                elapsed["notifications"] += 1
                elapsed["docker"] += 1

                if (
                    intervals["system"] > 0
                    and elapsed["system"] >= intervals["system"]
                ):
                    elapsed["system"] = 0
                    await websocket.send_json(await _build_module_update("system"))

                adaptive_fast = last_raid_status in (
                    "recovering",
                    "resyncing",
                    "degraded",
                )
                raid_interval = (
                    min(intervals["raid"], 5)
                    if adaptive_fast and intervals["raid"] > 0
                    else intervals["raid"]
                )
                if raid_interval > 0 and elapsed["raid"] >= raid_interval:
                    elapsed["raid"] = 0
                    raid_msg = await _build_module_update("raid")
                    last_raid_status = raid_msg.get("raid", {}).get(
                        "status", last_raid_status
                    )
                    await websocket.send_json(raid_msg)

                if (
                    intervals["notifications"] > 0
                    and elapsed["notifications"] >= intervals["notifications"]
                ):
                    elapsed["notifications"] = 0
                    await websocket.send_json(await _build_module_update("notifications"))

                docker_interval = intervals.get("docker", 5)
                if (
                    docker_interval > 0
                    and elapsed["docker"] >= docker_interval
                ):
                    elapsed["docker"] = 0
                    await websocket.send_json(await _build_module_update("docker"))
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
    if payload.discord_enabled is not None:
        updates["discord_enabled"] = "true" if payload.discord_enabled else "false"
    if payload.raid_device is not None and payload.raid_device.strip() != "":
        updates["raid_device"] = payload.raid_device.strip()
    if payload.mount_path is not None and payload.mount_path.strip() != "":
        updates["mount_path"] = payload.mount_path.strip()
    if payload.google_client_id is not None:
        updates["google_client_id"] = payload.google_client_id.strip()
    if payload.allowed_google_emails is not None:
        updates["allowed_google_emails"] = payload.allowed_google_emails.strip()
    if payload.refresh_system_sec is not None:
        try:
            updates["refresh_system_sec"] = str(
                max(0, int(payload.refresh_system_sec))
            )
        except (ValueError, TypeError):
            pass
    if payload.refresh_raid_sec is not None:
        try:
            updates["refresh_raid_sec"] = str(max(0, int(payload.refresh_raid_sec)))
        except (ValueError, TypeError):
            pass
    if payload.refresh_notifications_sec is not None:
        try:
            updates["refresh_notifications_sec"] = str(
                max(0, int(payload.refresh_notifications_sec))
            )
        except (ValueError, TypeError):
            pass
    if payload.refresh_docker_sec is not None:
        try:
            updates["refresh_docker_sec"] = str(
                max(0, int(payload.refresh_docker_sec))
            )
        except (ValueError, TypeError):
            pass
    if payload.docker_auto_update_frequency is not None:
        updates["docker_auto_update_frequency"] = (
            payload.docker_auto_update_frequency.strip().lower()
        )
    if payload.timezone is not None and payload.timezone.strip():
        updates["timezone"] = payload.timezone.strip()

    updated = main.update_app_settings(updates)
    result = _format_settings_response(updated)
    result["saved"] = True
    return result


@app.get("/api/update/check")
def api_update_check(_user: str = Depends(require_auth)) -> dict[str, Any]:
    return main.check_for_release_update()


@app.get("/api/changelog")
def api_changelog(_user: str = Depends(require_auth)) -> dict[str, Any]:
    return {"changelog": main.get_full_changelog()}


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


@app.get("/api/docker/status")
async def api_docker_status(_user: str = Depends(require_auth)) -> dict[str, Any]:
    return await asyncio.to_thread(main.docker_manager.get_status)


@app.post("/api/docker/install")
async def api_docker_install(_user: str = Depends(require_auth)) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(main.docker_manager.install_docker)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/stacks")
async def api_docker_stacks(_user: str = Depends(require_auth)) -> dict[str, Any]:
    stacks = await asyncio.to_thread(main.docker_manager.list_stacks)
    return {"stacks": stacks}


@app.post("/api/docker/stacks")
async def api_docker_create_stack(
    payload: StackCreateRequest,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        stack = await asyncio.to_thread(
            main.docker_manager.save_stack,
            payload.name,
            payload.compose_yaml,
            deploy=bool(payload.deploy),
        )
        return {"success": True, "stack": stack}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.put("/api/docker/stacks/{name}")
async def api_docker_update_stack(
    name: str,
    payload: StackCreateRequest,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        stack = await asyncio.to_thread(
            main.docker_manager.save_stack,
            name,
            payload.compose_yaml,
            deploy=bool(payload.deploy),
        )
        return {"success": True, "stack": stack}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/stacks/{name}")
async def api_docker_get_stack(
    name: str,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    stack = await asyncio.to_thread(main.docker_manager.get_stack, name)
    if not stack:
        raise HTTPException(status_code=404, detail=f"Stack '{name}' not found")
    return {"stack": stack}


@app.post("/api/docker/stacks/{name}/action")
async def api_docker_stack_action(
    name: str,
    payload: StackActionRequest,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            main.docker_manager.execute_stack_action, name, payload.action
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/api/docker/stacks/{name}")
async def api_docker_delete_stack(
    name: str,
    down: bool = Query(True),
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        await asyncio.to_thread(main.docker_manager.delete_stack, name, down=down)
        return {"success": True, "deleted": name}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/containers")
async def api_docker_containers(
    all: bool = Query(True),
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    containers = await asyncio.to_thread(main.docker_manager.list_containers, all=all)
    return {"containers": containers}


@app.post("/api/docker/containers/{id}/action")
async def api_docker_container_action(
    id: str,
    payload: ContainerActionRequest,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            main.docker_manager.execute_container_action, id, payload.action
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/containers/{id}/logs")
async def api_docker_container_logs(
    id: str,
    tail: int = Query(200, ge=1, le=5000),
    timestamps: bool = Query(True),
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        logs = await asyncio.to_thread(
            main.docker_manager.get_container_logs,
            id,
            tail=tail,
            timestamps=timestamps,
        )
        return {"logs": logs}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/containers/{id}/stats")
async def api_docker_container_stats(
    id: str,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        stats = await asyncio.to_thread(main.docker_manager.get_container_stats, id)
        return {"stats": stats}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/images")
async def api_docker_images(_user: str = Depends(require_auth)) -> dict[str, Any]:
    images = await asyncio.to_thread(main.docker_manager.list_images)
    return {"images": images}


@app.post("/api/docker/images/pull")
async def api_docker_pull_image(
    payload: ImagePullRequest,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    image_name = (payload.image or payload.image_tag or "").strip()
    if not image_name:
        raise HTTPException(status_code=400, detail="Image tag is required")
    try:
        return await asyncio.to_thread(main.docker_manager.pull_image, image_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/api/docker/images/{id}")
async def api_docker_remove_image(
    id: str,
    force: bool = Query(False),
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            main.docker_manager.remove_image, id, force=force
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/docker/images/prune")
async def api_docker_prune_images(
    payload: Optional[ImagePruneRequest] = None,
    all: bool = Query(False),
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    prune_all = all or (payload.all if payload else False)
    try:
        return await asyncio.to_thread(
            main.docker_manager.prune_images, all_images=prune_all
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/volumes")
async def api_docker_volumes(_user: str = Depends(require_auth)) -> dict[str, Any]:
    volumes = await asyncio.to_thread(main.docker_manager.list_volumes)
    return {"volumes": volumes}


@app.get("/api/docker/volumes/{name}")
async def api_docker_inspect_volume(
    name: str,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        data = await asyncio.to_thread(main.docker_manager.inspect_volume, name)
        result = dict(data)
        result["volume"] = data
        return result
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/api/docker/volumes/{name}")
async def api_docker_remove_volume(
    name: str,
    force: bool = Query(False),
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            main.docker_manager.remove_volume, name, force=force
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/networks")
async def api_docker_networks(_user: str = Depends(require_auth)) -> dict[str, Any]:
    networks = await asyncio.to_thread(main.docker_manager.list_networks)
    return {"networks": networks}


@app.delete("/api/docker/networks/{id}")
async def api_docker_remove_network(
    id: str,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(main.docker_manager.remove_network, id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/updates")
async def api_docker_updates(
    force: bool = False,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    return await asyncio.to_thread(main.docker_manager.check_updates, force=force)


@app.post("/api/docker/updates/apply")
async def api_docker_updates_apply(
    payload: Optional[UpdatesApplyRequest] = None,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    containers = payload.containers if payload else None
    stacks = payload.stacks if payload else None
    try:
        return await asyncio.to_thread(
            main.docker_manager.apply_updates,
            containers=containers,
            stacks=stacks,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/docker/updates/config")
def api_docker_get_updates_config(
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    return main.docker_manager.get_auto_update_config()


@app.post("/api/docker/updates/config")
def api_docker_updates_config(
    payload: UpdatesConfigRequest,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        return main.docker_manager.set_auto_update_config(payload.frequency)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/docker/updates/schedule")
def api_docker_get_update_schedule(
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    schedule = main.get_docker_auto_update_schedule()
    return {
        "schedule": schedule,
        "enabled": schedule.get("enabled", False),
        "day": schedule.get("day", "daily"),
        "time": schedule.get("time", "03:00"),
        "notify_discord": schedule.get("notify_discord", True),
    }


@app.post("/api/docker/updates/schedule")
def api_docker_set_update_schedule(
    payload: UpdateScheduleRequest,
    _user: str = Depends(require_auth),
) -> dict[str, Any]:
    try:
        schedule = main.set_docker_auto_update_schedule(payload.model_dump())
        return {
            "success": True,
            "schedule": schedule,
            "enabled": schedule.get("enabled", False),
            "day": schedule.get("day", "daily"),
            "time": schedule.get("time", "03:00"),
            "notify_discord": schedule.get("notify_discord", True),
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class CacheControlStaticFiles(StaticFiles):
    def file_response(
        self,
        full_path: Any,
        stat_result: Any,
        scope: Any,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(
            full_path, stat_result, scope, status_code=status_code
        )
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


@app.get("/")
def serve_index():
    headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }
    index_file = STATIC_DIR / "index.html"
    if index_file.is_file():
        content = index_file.read_text(encoding="utf-8")
        current_version = main.get_current_version_info()["current_version"]
        content = re.sub(
            r"/static/styles\.css(\?[^\"'>\s]*)?",
            f"/static/styles.css?v={current_version}",
            content,
        )
        content = re.sub(
            r"/static/app\.js(\?[^\"'>\s]*)?",
            f"/static/app.js?v={current_version}",
            content,
        )
        return HTMLResponse(content=content, status_code=200, headers=headers)
    return HTMLResponse(
        content="<!DOCTYPE html><html><head><title>SystemAlerts Server Manager</title></head>"
        "<body><h1>SystemAlerts Server Manager</h1></body></html>",
        status_code=200,
        headers=headers,
    )


app.mount(
    "/static", CacheControlStaticFiles(directory=str(STATIC_DIR)), name="static"
)
