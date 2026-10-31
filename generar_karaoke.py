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


def is_ai_method(method: str) -> bool:
    name = str(method or "")
    return name.startswith("whisper") or name.startswith("gpt-")


def main() -> None:
    parser = argparse.ArgumentParser(description="Genera timings de karaoke con IA")
    parser.add_argument(
        "--whisper",
        action="store_true",
        help="Whisper local/API sobre audio descifrado (requiere SUNO_COOKIE)",
    )
    parser.add_argument("--llm", action="store_true", help="GPT-4o-mini sobre letra + duración (OPENAI_API_KEY)")
    parser.add_argument(
        "--ia",
        action="store_true",
        help="Whisper y, si falla, GPT-4o-mini (recomendado en CI)",
    )
    parser.add_argument("--model", default="tiny", help="Modelo faster-whisper: tiny, base, small")
    parser.add_argument("--limit", type=int, default=0, help="Procesar solo N temas pendientes")
    parser.add_argument("--ids", nargs="*", help="Solo estos clip ids")
    parser.add_argument("--resume", action="store_true", help="Saltear temas ya sincronizados con IA")
    parser.add_argument("--force", action="store_true", help="Reprocesar aunque ya tengan IA")
    args = parser.parse_args()

    use_whisper = args.whisper or args.ia
    use_llm = args.llm or args.ia

    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    existing = json.loads(OUTPUT_PATH.read_text(encoding="utf-8")) if OUTPUT_PATH.is_file() else {}
    api_key = load_env_key()
    if use_whisper and not os.getenv("SUNO_COOKIE") and not (ROOT / ".env").is_file():
        print("Whisper necesita SUNO_COOKIE (audio cifrado de Suno).")
    if use_llm and not api_key:
        print("GPT karaoke necesita OPENAI_API_KEY.")

    selected = [row for row in catalog if row.get("estado") not in {"error"} and str(row.get("letra") or "").strip()]
    if args.ids:
        wanted = set(args.ids)
        selected = [row for row in selected if row["id"] in wanted]
    if args.resume and not args.force:
        selected = [row for row in selected if not is_ai_method(existing.get(row["id"], {}).get("method", ""))]

    if args.limit:
        selected = selected[: args.limit]

    total = len(selected)
    processed = 0
    for index, row in enumerate(selected, start=1):
        clip_id = row["id"]
        payload = sync_track(
            clip_id=clip_id,
            lyrics=str(row.get("letra") or ""),
            duration_sec=float(row.get("duracion_seg") or 0),
            api_key=api_key,
            use_whisper=use_whisper,
            use_llm=use_llm,
            whisper_model=args.model,
            title=str(row.get("titulo") or ""),
            estilo=str(row.get("estilo") or ""),
            modelo=str(row.get("version_modelo") or row.get("modelo") or ""),
        )
        compact = {
            "lead": payload["lead"],
            "method": payload["method"],
            "starts": payload["starts"],
            "ends": payload.get("ends") or [],
            "modelo": payload.get("modelo") or "",
        }
        existing[clip_id] = compact
        processed += 1
        OUTPUT_PATH.write_text(json.dumps(existing, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        if index % 3 == 0 or index == total:
            print(f"{index}/{total} {clip_id} ({payload['method']})", flush=True)

    print(f"listo: {len(existing)} temas en {OUTPUT_PATH} ({processed} procesados en esta corrida)")


if __name__ == "__main__":
    main()
