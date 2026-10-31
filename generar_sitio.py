"""Genera el sitio estático para GitHub Pages."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from servidor import extract_tags

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "catalogo.json"
WEB_DIR = ROOT / "web"
DOCS_DIR = ROOT / "docs"


def build_tracks() -> dict:
    raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    tracks: list[dict] = []
    for item in raw:
        if item.get("estado") not in {"bajado", "ya_existia"}:
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
                "letra": item.get("letra") or "",
            }
        )
    tracks.sort(key=lambda track: track["creado"], reverse=True)
    labels: list[str] = []
    for track in tracks:
        for label in track["etiquetas"]:
            if label not in labels:
                labels.append(label)
    return {"total": len(tracks), "etiquetas": labels, "temas": tracks}


def main() -> None:
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    payload = build_tracks()
    catalog = json.dumps(payload, ensure_ascii=False)
    (DOCS_DIR / "temas.json").write_text(catalog, encoding="utf-8")
    (WEB_DIR / "temas.json").write_text(catalog, encoding="utf-8")
    for name in ("index.html", "estilos.css", "app.js"):
        shutil.copy2(WEB_DIR / name, DOCS_DIR / name)
    (DOCS_DIR / ".nojekyll").write_text("", encoding="utf-8")
    print(f"sitio listo: {payload['total']} temas en {DOCS_DIR}")


if __name__ == "__main__":
    main()
