"""Genera karaoke_timings.json para todo el catálogo."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from karaoke_ia import sync_track

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "catalogo.json"
OUTPUT_PATH = ROOT / "karaoke_timings.json"


def load_env_key() -> str:
    env_path = ROOT / ".env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    return os.getenv("OPENAI_API_KEY", "").strip()


def main() -> None:
    parser = argparse.ArgumentParser(description="Genera timings de karaoke con IA")
    parser.add_argument("--whisper", action="store_true", help="Usar Whisper (requiere OPENAI_API_KEY)")
    parser.add_argument("--limit", type=int, default=0, help="Procesar solo N temas")
    parser.add_argument("--ids", nargs="*", help="Solo estos clip ids")
    args = parser.parse_args()

    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    existing = json.loads(OUTPUT_PATH.read_text(encoding="utf-8")) if OUTPUT_PATH.is_file() else {}
    api_key = load_env_key()
    use_whisper = args.whisper and bool(api_key)
    if args.whisper and not api_key:
        print("OPENAI_API_KEY no configurada: se usa alineación estructural (estructura-ia).")

    selected = [row for row in catalog if row.get("estado") not in {"error"} and str(row.get("letra") or "").strip()]
    if args.ids:
        wanted = set(args.ids)
        selected = [row for row in selected if row["id"] in wanted]
    if args.limit:
        selected = selected[: args.limit]

    total = len(selected)
    for index, row in enumerate(selected, start=1):
        clip_id = row["id"]
        payload = sync_track(
            clip_id=clip_id,
            lyrics=str(row.get("letra") or ""),
            duration_sec=float(row.get("duracion_seg") or 0),
            api_key=api_key,
            use_whisper=use_whisper,
        )
        compact = {
            "lead": payload["lead"],
            "method": payload["method"],
            "starts": payload["starts"],
        }
        existing[clip_id] = compact
        if index % 25 == 0 or index == total:
            print(f"{index}/{total} {clip_id} ({payload['method']})")

    OUTPUT_PATH.write_text(json.dumps(existing, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"listo: {len(existing)} temas en {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
