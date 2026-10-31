"""Alineación letra ↔ audio para karaoke (Whisper + estructura de secciones)."""

from __future__ import annotations

import json
import os
import re
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CLOUD_AUDIO = "https://d2lwuy8qc234o3.cloudfront.net/1/clip/{id}.m4a"
SUNO_EMBED_LEAD = 1.15

SECTION_KIND = {
    "intro": "intro",
    "outro": "outro",
    "verse": "verse",
    "chorus": "chorus",
    "bridge": "bridge",
    "pre-chorus": "pre",
    "pre chorus": "pre",
    "hook": "chorus",
    "refrain": "chorus",
    "drop": "instrumental",
    "instrumental": "instrumental",
    "break": "instrumental",
    "interlude": "instrumental",
    "solo": "instrumental",
    "classical": "intro",
}


@dataclass
class LyricItem:
    kind: str  # section | line | note
    text: str
    section: str = "verse"
    line_index: int = -1


def normalize_section(label: str) -> str:
    raw = re.sub(r"[^\w\s–-]", " ", label.lower()).strip()
    raw = raw.replace("–", "-")
    for key, kind in SECTION_KIND.items():
        if key in raw:
            return kind
    if "verse" in raw:
        return "verse"
    if "chorus" in raw:
        return "chorus"
    return "verse"


def parse_lyric_items(text: str) -> list[LyricItem]:
    items: list[LyricItem] = []
    current_section = "verse"
    line_index = 0
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            inner = line[1:-1].strip()
            if re.match(r"^(verse|chorus|bridge|intro|outro|pre|hook|drop|instrumental|build|solo)", inner, re.I):
                current_section = normalize_section(inner)
                items.append(LyricItem(kind="section", text=line, section=current_section))
                continue
            if len(inner) > 48 or " " in inner and not re.match(r"^(verse|chorus)", inner, re.I):
                items.append(LyricItem(kind="note", text=line, section=current_section))
                continue
            current_section = normalize_section(inner)
            items.append(LyricItem(kind="section", text=line, section=current_section))
            continue
        items.append(
            LyricItem(kind="line", text=line, section=current_section, line_index=line_index),
        )
        line_index += 1
    return items


def section_time_budget(duration_sec: float, sections: list[str]) -> dict[str, float]:
    duration = max(float(duration_sec or 0), 1.0)
    weights: dict[str, float] = {}
    for section in sections:
        if section == "intro":
            weights[section] = weights.get(section, 0) + 0.07
        elif section == "outro":
            weights[section] = weights.get(section, 0) + 0.06
        elif section == "instrumental":
            weights[section] = weights.get(section, 0) + 0.09
        elif section == "chorus":
            weights[section] = weights.get(section, 0) + 0.14
        elif section == "pre":
            weights[section] = weights.get(section, 0) + 0.08
        elif section == "bridge":
            weights[section] = weights.get(section, 0) + 0.1
        else:
            weights[section] = weights.get(section, 0) + 0.18
    total = sum(weights.values()) or 1.0
    scale = (duration * 0.88) / total
    return {key: value * scale for key, value in weights.items()}


def line_weight(text: str) -> float:
    words = len(re.findall(r"\w+", text, flags=re.UNICODE))
    chars = len(text)
    return max(words * 1.15 + chars * 0.04, 6.0)


def build_structure_timeline(items: list[LyricItem], duration_sec: float) -> list[dict[str, Any]]:
    duration = max(float(duration_sec or 0), 1.0)
    intro_pad = min(10.0, max(5.5, duration * 0.055))
    lines = [item for item in items if item.kind == "line"]
    if not lines:
        return []

    section_order: list[str] = []
    for item in items:
        if item.kind == "line" and item.section not in section_order:
            section_order.append(item.section)
    budgets = section_time_budget(duration, section_order)

    by_section: dict[str, list[LyricItem]] = {}
    for item in lines:
        by_section.setdefault(item.section, []).append(item)

    starts: dict[int, float] = {}
    ends: dict[int, float] = {}
    cursor = intro_pad

    for section in section_order:
        group = by_section.get(section, [])
        if not group:
            continue
        budget = budgets.get(section, duration * 0.15)
        weights = [line_weight(item.text) for item in group]
        total_w = sum(weights) or 1.0
        for item, weight in zip(group, weights):
            span = max(budget * (weight / total_w), 1.8)
            starts[item.line_index] = cursor
            cursor += span
            ends[item.line_index] = cursor
        if section in {"chorus", "pre"}:
            cursor += min(1.2, budget * 0.08)

    if cursor > duration * 0.98 and lines:
        scale = (duration * 0.96 - intro_pad) / max(cursor - intro_pad, 1.0)
        for index in starts:
            starts[index] = intro_pad + (starts[index] - intro_pad) * scale
            ends[index] = intro_pad + (ends[index] - intro_pad) * scale

    timeline: list[dict[str, Any]] = []
    for item in items:
        if item.kind == "section":
            timeline.append(
                {
                    "kind": "section",
                    "text": item.text,
                    "startSec": 0.0,
                    "endSec": 0.0,
                    "lineIndex": -1,
                },
            )
            continue
        if item.kind != "line":
            continue
        start = starts.get(item.line_index, intro_pad)
        end = ends.get(item.line_index, start + 2.5)
        timeline.append(
            {
                "kind": "line",
                "text": item.text,
                "startSec": round(start, 2),
                "endSec": round(min(end, duration), 2),
                "lineIndex": item.line_index,
            },
        )
    return timeline


def _normalize_token(value: str) -> str:
    return re.sub(r"[^\w\s]", "", value.lower(), flags=re.UNICODE).strip()


def align_lines_to_whisper_segments(
    lines: list[str],
    segments: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    if not lines or not segments:
        return []
    seg_texts = [_normalize_token(str(seg.get("text") or "")) for seg in segments]
    seg_starts = [float(seg.get("start") or 0) for seg in segments]
    seg_ends = [float(seg.get("end") or seg_starts[i] + 0.5) for i, seg in enumerate(segments)]

    results: list[tuple[float, float]] = []
    seg_i = 0
    for line in lines:
        target = _normalize_token(line)
        if not target:
            results.append((results[-1][1] if results else 0.0, (results[-1][1] if results else 0.0) + 2.0))
            continue
        best_j = seg_i
        best_score = -1.0
        window_end = min(len(segments), seg_i + 8)
        for j in range(seg_i, window_end):
            score = _overlap_score(target, seg_texts[j])
            if score > best_score:
                best_score = score
                best_j = j
        start = seg_starts[best_j]
        end = seg_ends[min(best_j + max(1, len(target.split()) // 4), len(segments) - 1)]
        if results and start < results[-1][0]:
            start = results[-1][1]
        if end <= start:
            end = start + max(2.0, len(line) * 0.07)
        results.append((start, end))
        seg_i = min(best_j + 1, len(segments) - 1)
    return results


def _overlap_score(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    aw = set(a.split())
    bw = set(b.split())
    if not aw or not bw:
        return 0.0
    return len(aw & bw) / len(aw)


def download_clip(clip_id: str, target: Path) -> None:
    url = CLOUD_AUDIO.format(id=clip_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        target.write_bytes(response.read())


def transcribe_whisper_openai(audio_path: Path, api_key: str) -> list[dict[str, Any]]:
    import urllib.request as req

    boundary = "----KaraokeBoundary7MA4YWxkTrZu0gW"
    body_parts: list[bytes] = []
    for name, value in (
        ("model", "whisper-1"),
        ("response_format", "verbose_json"),
        ("timestamp_granularities[]", "segment"),
    ):
        body_parts.append(f"--{boundary}\r\n".encode())
        body_parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body_parts.append(f"{value}\r\n".encode())
    file_bytes = audio_path.read_bytes()
    body_parts.append(f"--{boundary}\r\n".encode())
    body_parts.append(
        f'Content-Disposition: form-data; name="file"; filename="{audio_path.name}"\r\n'.encode(),
    )
    body_parts.append(b"Content-Type: audio/m4a\r\n\r\n")
    body_parts.append(file_bytes)
    body_parts.append(f"\r\n--{boundary}--\r\n".encode())
    payload = b"".join(body_parts)
    request = req.Request(
        "https://api.openai.com/v1/audio/transcriptions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    with req.urlopen(request, timeout=300) as response:
        data = json.loads(response.read().decode("utf-8"))
    return list(data.get("segments") or [])


def build_whisper_timeline(
    items: list[LyricItem],
    duration_sec: float,
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    lines = [item for item in items if item.kind == "line"]
    pairs = align_lines_to_whisper_segments([item.text for item in lines], segments)
    if not pairs:
        return build_structure_timeline(items, duration_sec)
    by_index = {item.line_index: pair for item, pair in zip(lines, pairs)}
    timeline: list[dict[str, Any]] = []
    for item in items:
        if item.kind == "section":
            timeline.append(
                {"kind": "section", "text": item.text, "startSec": 0.0, "endSec": 0.0, "lineIndex": -1},
            )
            continue
        if item.kind != "line":
            continue
        start, end = by_index.get(item.line_index, (0.0, 2.0))
        timeline.append(
            {
                "kind": "line",
                "text": item.text,
                "startSec": round(max(0.0, start), 2),
                "endSec": round(min(end, duration_sec), 2),
                "lineIndex": item.line_index,
            },
        )
    return timeline


def sync_track(
    *,
    clip_id: str,
    lyrics: str,
    duration_sec: float,
    api_key: str = "",
    use_whisper: bool = False,
) -> dict[str, Any]:
    items = parse_lyric_items(lyrics)
    method = "estructura-ia"
    timeline = build_structure_timeline(items, duration_sec)
    if use_whisper and api_key and lyrics.strip():
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / f"{clip_id}.m4a"
            try:
                download_clip(clip_id, audio_path)
                segments = transcribe_whisper_openai(audio_path, api_key)
                if segments:
                    timeline = build_whisper_timeline(items, duration_sec, segments)
                    method = "whisper-1"
            except Exception:
                pass
    line_starts = [
        round(item["startSec"], 2)
        for item in timeline
        if item.get("kind") == "line" and item.get("lineIndex", -1) >= 0
    ]
    return {
        "lead": SUNO_EMBED_LEAD,
        "method": method,
        "starts": line_starts,
        "timeline": timeline,
    }
