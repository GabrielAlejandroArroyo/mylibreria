"""Reproductor local de la biblioteca Suno."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "catalogo.json"
WEB_DIR = ROOT / "web"

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
    tracks: list[dict] = []
    for item in raw:
        if item.get("estado") != "bajado":
            continue
        relative = str(item.get("archivo") or "")
        audio_path = (ROOT / relative).resolve()
        if not audio_path.is_file() or ROOT not in audio_path.parents:
            continue
        style = str(item.get("estilo") or "").strip()
        tracks.append(
            {
                "id": item["id"],
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
            }
        )
    tracks.sort(key=lambda track: track["creado"], reverse=True)
    _cache["mtime"] = mtime
    _cache["tracks"] = tracks
    _cache["by_id"] = {track["id"]: track for track in tracks}
    _cache["raw_by_id"] = {item["id"]: item for item in raw}
    return tracks


def track_or_404(track_id: str) -> dict:
    load_tracks()
    track = _cache["by_id"].get(track_id)  # type: ignore[union-attr]
    if not track:
        raise HTTPException(status_code=404, detail="Tema no encontrado")
    return track


app = FastAPI(title="Biblioteca Suno")
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/")
def inicio() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


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
    raw = _cache["raw_by_id"][track_id]  # type: ignore[index]
    audio_path = (ROOT / str(raw["archivo"])).resolve()
    if not audio_path.is_file():
        raise HTTPException(status_code=404, detail="Audio no encontrado")
    return FileResponse(audio_path, media_type="audio/mp4", filename=audio_path.name)
