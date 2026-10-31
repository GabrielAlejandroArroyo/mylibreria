"""Trae temas nuevos de tu cuenta Suno, los deja reproducibles y actualiza el sitio."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from descargar_y_catalogar import AUDIO_DIR, CATALOG_JSON, SOURCE, audio_url, catalog_row, download_file, safe_stem, write_catalog
from generar_sitio import main as generar_sitio
from suno_cliente import (
    CLOUD_AUDIO,
    decrypt_media,
    es_audio_reproducible,
    obtener_sesion,
    request_bytes,
)

ROOT = Path(__file__).resolve().parent
PLAYABLE_DIR = ROOT / "playable"
DOCS_AUDIO = ROOT / "docs" / "audio"
STATE_PATH = ROOT / "sync_estado.json"
MAX_WEB_AUDIO = 12 * 1024 * 1024


def load_json(path: Path, default):
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def playable_path(clip_id: str) -> Path:
    return PLAYABLE_DIR / f"{clip_id}.m4a"


def by_clip_from_library(track_id: str) -> dict | None:
    library = load_json(SOURCE, [])
    for clip in library:
        if clip.get("id") == track_id:
            return clip
    catalog = load_json(CATALOG_JSON, [])
    row = next((item for item in catalog if item.get("id") == track_id), None)
    if not row:
        return None
    return {
        "id": track_id,
        "title": row.get("titulo") or "Sin título",
        "created_at": row.get("creado") or "",
        "updated_at": row.get("actualizado") or "",
        "model_name": row.get("modelo") or "",
        "major_model_version": row.get("version_modelo") or "",
        "is_public": row.get("publica"),
        "is_liked": row.get("me_gusta"),
        "play_count": row.get("reproducciones") or 0,
        "display_name": row.get("autor") or "",
        "handle": row.get("usuario") or "",
        "image_large_url": row.get("portada") or "",
        "metadata": {
            "duration": row.get("duracion_seg"),
            "tags": row.get("estilo") or "",
            "prompt": row.get("letra") or "",
            "gpt_description_prompt": row.get("descripcion") or "",
            "make_instrumental": row.get("instrumental"),
        },
        "media_urls": [{"url": f"https://d2lwuy8qc234o3.cloudfront.net/1/clip/{track_id}.m4a", "content_type": "m4a-opus"}],
    }


def web_audio_path(clip_id: str) -> Path:
    return DOCS_AUDIO / f"{clip_id}.m4a"


def encrypted_path(clip: dict) -> Path:
    return AUDIO_DIR / f"{safe_stem(clip.get('title') or '', clip['id'])}.m4a"


def ensure_encrypted(clip: dict) -> Path | None:
    destination = encrypted_path(clip)
    if destination.is_file() and destination.stat().st_size > 1000:
        return destination
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    url = audio_url(clip) or CLOUD_AUDIO.format(id=clip["id"])
    temporary = destination.with_suffix(".m4a.part")
    try:
        download_file(url, temporary)
        if temporary.stat().st_size < 1000:
            temporary.unlink(missing_ok=True)
            return None
        temporary.replace(destination)
        return destination
    except Exception:
        temporary.unlink(missing_ok=True)
        return None


def materializar_audio(sesion, clip: dict) -> Path | None:
    clip_id = clip["id"]
    ready = playable_path(clip_id)
    if ready.is_file() and ready.stat().st_size > 1000:
        return ready

    source = ensure_encrypted(clip)
    if source is None:
        try:
            source_bytes = request_bytes(CLOUD_AUDIO.format(id=clip_id))
        except Exception:
            return None
    else:
        source_bytes = source.read_bytes()

    if es_audio_reproducible(source_bytes):
        PLAYABLE_DIR.mkdir(parents=True, exist_ok=True)
        ready.write_bytes(source_bytes)
        return ready

    try:
        rights = sesion.derechos(clip_id)
        plain = decrypt_media(clip_id, source_bytes, rights)
    except Exception:
        return None
    if not es_audio_reproducible(plain):
        return None
    PLAYABLE_DIR.mkdir(parents=True, exist_ok=True)
    ready.write_bytes(plain)
    return ready


def publicar_audio_web(ready: Path, clip_id: str) -> str:
    if ready.stat().st_size > MAX_WEB_AUDIO:
        return ""
    DOCS_AUDIO.mkdir(parents=True, exist_ok=True)
    target = web_audio_path(clip_id)
    if not target.is_file() or target.stat().st_size != ready.stat().st_size:
        target.write_bytes(ready.read_bytes())
    return f"audio/{clip_id}.m4a"


def merge_catalog(clips: list[dict], _known_ids: set[str]) -> tuple[list[dict], list[str]]:
    by_id = {row["id"]: row for row in load_json(CATALOG_JSON, [])}
    nuevos: list[str] = []
    for clip in clips:
        clip_id = clip.get("id")
        if not clip_id:
            continue
        audio = encrypted_path(clip)
        if audio.is_file():
            row = catalog_row(clip, audio, "bajado")
        else:
            row = catalog_row(clip, None, "pendiente")
        if clip_id not in by_id:
            nuevos.append(clip_id)
        by_id[clip_id] = {**by_id.get(clip_id, {}), **row}
    rows = list(by_id.values())
    write_catalog(rows)
    SOURCE.write_text(json.dumps(clips, ensure_ascii=False), encoding="utf-8")
    return rows, nuevos


def sincronizar(*, publicar_web: bool = False, limitar_nuevos: int = 0) -> dict:
    sesion = obtener_sesion()
    clips = [clip for clip in sesion.listar_biblioteca() if clip.get("status") == "complete"]
    state = load_json(STATE_PATH, {"conocidos": [], "nuevos": []})
    known = set(state.get("conocidos") or [])
    rows, nuevos = merge_catalog(clips, known)

    pendientes = list(nuevos)
    if limitar_nuevos:
        pendientes = pendientes[:limitar_nuevos]

    reproducibles = 0
    publicados = 0
    by_clip = {clip["id"]: clip for clip in clips}
    for clip_id in pendientes:
        clip = by_clip.get(clip_id)
        if not clip:
            continue
        ready = materializar_audio(sesion, clip)
        if ready is None:
            continue
        reproducibles += 1
        if publicar_web and publicar_audio_web(ready, clip_id):
            publicados += 1

    generar_sitio()
    todos = [clip["id"] for clip in clips]
    save_json(
        STATE_PATH,
        {
            "conocidos": todos,
            "nuevos": nuevos,
            "ultima_sync": datetime.now(timezone.utc).isoformat(),
            "total": len(clips),
        },
    )
    return {
        "total": len(clips),
        "nuevos": len(nuevos),
        "titulos_nuevos": [by_clip[item]["title"] for item in nuevos if item in by_clip],
        "reproducibles": reproducibles,
        "publicados_web": publicados,
        "ids_nuevos": nuevos,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Sincroniza tu biblioteca de Suno")
    parser.add_argument("--publicar-web", action="store_true", help="Copia audios nuevos chicos a docs/audio")
    parser.add_argument("--limitar", type=int, default=0, help="Procesa como máximo N temas")
    args = parser.parse_args()
    from suno_cliente import load_env

    if not load_env().get("SUNO_COOKIE"):
        print(json.dumps({"ok": False, "error": "Falta SUNO_COOKIE"}, ensure_ascii=False))
        return
    resultado = sincronizar(publicar_web=args.publicar_web, limitar_nuevos=args.limitar)
    print(json.dumps(resultado, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
