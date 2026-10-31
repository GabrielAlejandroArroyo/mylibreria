"""Reproductor local de la biblioteca Suno."""

from __future__ import annotations

import json
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "catalogo.json"
WEB_DIR = ROOT / "web"
PLAYABLE_DIR = ROOT / "playable"
DOCS_AUDIO = ROOT / "docs" / "audio"
STATE_PATH = ROOT / "sync_estado.json"

STYLE_TAGS: tuple[tuple[str, str], ...] = (
    ("cumbia", "Cumbia"),
    ("reggaeton", "Reggaeton"),
    ("turreo", "Turreo"),
    ("rkt", "RKT"),
    ("trap", "Trap"),
    ("hip-hop", "Hip hop"),
    ("hip hop", "Hip hop"),
    ("rap", "Rap"),
    ("rock", "Rock"),
    ("punk", "Punk"),
    ("metal", "Metal"),
    ("pop", "Pop"),
    ("indie", "Indie"),
    ("jazz", "Jazz"),
    ("blues", "Blues"),
    ("folk", "Folk"),
    ("country", "Country"),
    ("electronic", "Electrónica"),
    ("edm", "EDM"),
    ("house", "House"),
    ("techno", "Techno"),
    ("disco", "Disco"),
    ("funk", "Funk"),
    ("soul", "Soul"),
    ("r&b", "R&B"),
    ("ballad", "Balada"),
    ("tango", "Tango"),
    ("salsa", "Salsa"),
    ("bachata", "Bachata"),
    ("lo-fi", "Lo-fi"),
    ("lofi", "Lo-fi"),
    ("ambient", "Ambient"),
)

_cache: dict[str, object] = {"mtime": -1.0, "tracks": []}
_sync_lock = threading.Lock()


def extract_tags(style: str) -> list[str]:
    lowered = (style or "").lower()
    found: list[str] = []
    for needle, label in STYLE_TAGS:
        if needle in lowered and label not in found:
            found.append(label)
        if len(found) == 3:
            break
    return found


def load_tracks() -> list[dict]:
    if not CATALOG_PATH.is_file():
        return []
    mtime = CATALOG_PATH.stat().st_mtime
    if mtime == _cache["mtime"]:
        return _cache["tracks"]  # type: ignore[return-value]

    raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    state = json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.is_file() else {}
    nuevos = set(state.get("nuevos") or [])
    tracks: list[dict] = []
    for item in raw:
        if item.get("estado") == "error":
            continue
        style = str(item.get("estilo") or "").strip()
        clip_id = item["id"]
        tracks.append(
            {
                "id": clip_id,
                "titulo": item.get("titulo") or "Sin título",
                "duracion_seg": float(item.get("duracion_seg") or 0),
                "creado": item.get("creado") or "",
                "estilo": style,
                "estilo_corto": style[:140],
                "etiquetas": extract_tags(style),
                "instrumental": bool(item.get("instrumental")),
                "me_gusta": bool(item.get("me_gusta")),
                "reproducciones": int(item.get("reproducciones") or 0),
                "autor": item.get("autor") or "Suno",
                "portada": item.get("portada") or "",
                "url_suno": item.get("url_suno") or "",
                "modelo": item.get("version_modelo") or item.get("modelo") or "",
                "nuevo": clip_id in nuevos,
            }
        )
    tracks.sort(key=lambda track: track["creado"], reverse=True)
    _cache["mtime"] = mtime
    _cache["tracks"] = tracks
    _cache["by_id"] = {track["id"]: track for track in tracks}
    _cache["raw_by_id"] = {item["id"]: item for item in raw}
    return tracks


def invalidate_cache() -> None:
    _cache["mtime"] = -1.0


def track_or_404(track_id: str) -> dict:
    load_tracks()
    track = _cache["by_id"].get(track_id)  # type: ignore[union-attr]
    if not track:
        raise HTTPException(status_code=404, detail="Tema no encontrado")
    return track


def resolve_playable(track_id: str) -> Path | None:
    candidates = [
        PLAYABLE_DIR / f"{track_id}.m4a",
        DOCS_AUDIO / f"{track_id}.m4a",
    ]
    for path in candidates:
        if path.is_file() and path.stat().st_size > 1000:
            return path
    return None


def prepare_playable(track_id: str) -> Path:
    ready = resolve_playable(track_id)
    if ready:
        return ready
    from sincronizar import by_clip_from_library, materializar_audio
    from suno_cliente import obtener_sesion

    clip = by_clip_from_library(track_id)
    if not clip:
        raise HTTPException(status_code=404, detail="No hay metadatos de este tema")
    try:
        sesion = obtener_sesion()
        ready = materializar_audio(sesion, clip)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if ready is None:
        raise HTTPException(status_code=409, detail="No se pudo dejar este audio listo para escuchar")
    return ready


def loop_sync() -> None:
    from sincronizar import sincronizar

    if not _sync_lock.acquire(blocking=False):
        return
    try:
        sincronizar(publicar_web=True)
        invalidate_cache()
    except Exception:
        pass
    finally:
        _sync_lock.release()


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield


app = FastAPI(title="Biblioteca Suno", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SesionIn(BaseModel):
    cookie: str = Field(min_length=20)


@app.get("/")
def inicio() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/estilos.css")
def estilos() -> FileResponse:
    return FileResponse(WEB_DIR / "estilos.css")


@app.get("/app.js")
def script() -> FileResponse:
    return FileResponse(WEB_DIR / "app.js")


@app.get("/temas.json")
def catalogo_web() -> FileResponse:
    path = WEB_DIR / "temas.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Generá el sitio con generar_sitio.py")
    return FileResponse(path)


@app.get("/api/ping")
def ping() -> dict:
    from suno_cliente import load_env

    state = json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.is_file() else {}
    return {
        "ok": True,
        "tiene_sesion": bool(load_env().get("SUNO_COOKIE")),
        "ultima_sync": state.get("ultima_sync") or "",
        "nuevos": len(state.get("nuevos") or []),
    }


@app.post("/api/sesion")
def guardar_sesion(payload: SesionIn) -> dict:
    from suno_cliente import SunoSesion, save_cookie

    sesion = SunoSesion(payload.cookie)
    info = sesion.conectar()
    save_cookie(payload.cookie)
    return {"ok": True, **info}


@app.post("/api/sincronizar")
def sincronizar_ahora() -> dict:
    from sincronizar import sincronizar

    if not _sync_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Ya hay una sincronización en curso")
    try:
        resultado = sincronizar(publicar_web=True)
        invalidate_cache()
        return resultado
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    finally:
        _sync_lock.release()


@app.get("/api/temas")
def listar_temas() -> dict:
    tracks = load_tracks()
    labels: list[str] = []
    for track in tracks:
        for label in track["etiquetas"]:
            if label not in labels:
                labels.append(label)
    return {"total": len(tracks), "etiquetas": labels, "temas": tracks}


@app.get("/api/temas/{track_id}")
def detalle_tema(track_id: str) -> dict:
    track = track_or_404(track_id)
    raw = _cache["raw_by_id"][track_id]  # type: ignore[index]
    return {**track, "letra": raw.get("letra") or "", "descripcion": raw.get("descripcion") or ""}


@app.get("/api/audio/{track_id}")
def audio_tema(track_id: str) -> FileResponse:
    track_or_404(track_id)
    audio_path = prepare_playable(track_id)
    return FileResponse(audio_path, media_type="audio/mp4", filename=audio_path.name)
