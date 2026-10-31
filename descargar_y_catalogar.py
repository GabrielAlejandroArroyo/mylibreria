"""Baja la biblioteca de Suno ya listada y cataloga cada tema al guardarlo."""

from __future__ import annotations

import csv
import json
import re
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(r"D:\mylibreria")
SOURCE = ROOT / "suno_library.json"
AUDIO_DIR = ROOT / "audio"
CATALOG_JSON = ROOT / "catalogo.json"
CATALOG_CSV = ROOT / "catalogo.csv"
ERRORS_JSON = ROOT / "catalogo_errores.json"

CSV_FIELDS = [
    "id",
    "titulo",
    "archivo",
    "creado",
    "duracion_seg",
    "modelo",
    "estilo",
    "instrumental",
    "publica",
    "me_gusta",
    "reproducciones",
    "url_suno",
    "estado",
]


def safe_stem(title: str, clip_id: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", title or "sin titulo")
    cleaned = " ".join(cleaned.split()).strip(" .")
    if not cleaned:
        cleaned = "sin titulo"
    return f"{cleaned[:80]}__{clip_id[:8]}"


def audio_url(clip: dict) -> str:
    for media in clip.get("media_urls") or []:
        url = media.get("url") or ""
        if url and media.get("content_type") == "m4a-opus":
            return url
    for media in clip.get("media_urls") or []:
        url = media.get("url") or ""
        if url:
            return url
    return f"https://d2lwuy8qc234o3.cloudfront.net/1/clip/{clip['id']}.m4a"


def download_file(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        destination.write_bytes(response.read())


def catalog_row(clip: dict, audio_path: Path | None, status: str, error: str = "") -> dict:
    metadata = clip.get("metadata") or {}
    duration = metadata.get("duration")
    duration_sec = round(float(duration), 1) if isinstance(duration, (int, float)) else None
    return {
        "id": clip.get("id"),
        "titulo": clip.get("title") or "Sin título",
        "archivo": str(audio_path.relative_to(ROOT)) if audio_path else "",
        "creado": clip.get("created_at") or "",
        "actualizado": clip.get("updated_at") or "",
        "duracion_seg": duration_sec,
        "modelo": clip.get("model_name") or "",
        "version_modelo": clip.get("major_model_version") or "",
        "estilo": metadata.get("tags") or "",
        "letra": metadata.get("prompt") or "",
        "descripcion": metadata.get("gpt_description_prompt") or "",
        "instrumental": bool(metadata.get("make_instrumental")),
        "publica": bool(clip.get("is_public")),
        "me_gusta": bool(clip.get("is_liked")),
        "reproducciones": clip.get("play_count") or 0,
        "autor": clip.get("display_name") or "",
        "usuario": clip.get("handle") or "",
        "url_suno": f"https://suno.com/song/{clip.get('id')}",
        "portada": clip.get("image_large_url") or clip.get("image_url") or "",
        "estado": status,
        "error": error,
    }


def write_catalog(rows: list[dict]) -> None:
    ordered = sorted(rows, key=lambda row: row.get("creado") or "", reverse=True)
    CATALOG_JSON.write_text(
        json.dumps(ordered, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    with CATALOG_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(ordered)


def fetch_clip(clip: dict) -> dict:
    clip_id = clip["id"]
    destination = AUDIO_DIR / f"{safe_stem(clip.get('title') or '', clip_id)}.m4a"
    if destination.exists() and destination.stat().st_size > 1000:
        return catalog_row(clip, destination, "ya_existia")

    url = audio_url(clip)
    temporary = destination.with_suffix(".m4a.part")
    try:
        download_file(url, temporary)
        if temporary.stat().st_size < 1000:
            temporary.unlink(missing_ok=True)
            return catalog_row(clip, None, "error", "archivo demasiado chico")
        temporary.replace(destination)
        return catalog_row(clip, destination, "bajado")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        temporary.unlink(missing_ok=True)
        return catalog_row(clip, None, "error", str(exc))


def main() -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    clips = json.loads(SOURCE.read_text(encoding="utf-8"))
    rows: list[dict] = []
    lock = threading.Lock()
    total = len(clips)

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(fetch_clip, clip) for clip in clips]
        for index, future in enumerate(as_completed(futures), start=1):
            row = future.result()
            with lock:
                rows.append(row)
                write_catalog(rows)
            print(
                f"{index}/{total} [{row['estado']}] {row['titulo']} -> {row['archivo'] or row['error']}",
                flush=True,
            )

    errors = [row for row in rows if row["estado"] == "error"]
    ERRORS_JSON.write_text(json.dumps(errors, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"listo bajados={sum(r['estado']=='bajado' for r in rows)} "
        f"existian={sum(r['estado']=='ya_existia' for r in rows)} errores={len(errors)}",
        flush=True,
    )


if __name__ == "__main__":
    main()
