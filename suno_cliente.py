"""Sesión de tu cuenta Suno: listar biblioteca y descifrar tus propios temas."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
CLERK_BASE = "https://auth.suno.com"
CLERK_JS = "5.117.0"
SUNO_API = "https://studio-api-prod.suno.com"
CLOUD_AUDIO = "https://d2lwuy8qc234o3.cloudfront.net/1/clip/{id}.m4a"


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if ENV_PATH.is_file():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    values.update({key: value for key, value in os.environ.items() if value})
    return values


def save_cookie(cookie: str) -> None:
    current = load_env()
    current["SUNO_COOKIE"] = cookie.strip()
    lines = [f"{key}={value}" for key, value in current.items() if key.startswith("SUNO_")]
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def normalize_cookie(raw: str) -> str:
    token = (raw or "").strip()
    if not token:
        return ""
    if "__client=" in token:
        for part in token.split(";"):
            piece = part.strip()
            if piece.startswith("__client="):
                return piece
    if token.startswith("eyJ") or token.startswith("__client="):
        return token if token.startswith("__client=") else f"__client={token}"
    return token


def request_json(url: str, *, method: str = "GET", headers: dict[str, str] | None = None, body: bytes | None = None) -> dict:
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(f"{exc.code} {url.split('?')[0]} {detail}") from exc
    if not payload:
        return {}
    return json.loads(payload.decode("utf-8"))


def request_bytes(url: str, *, headers: dict[str, str] | None = None) -> bytes:
    request = urllib.request.Request(url, headers=headers or {"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


class SunoSesion:
    def __init__(self, cookie: str) -> None:
        self.cookie = normalize_cookie(cookie)
        if not self.cookie:
            raise RuntimeError("Falta la cookie de Suno")
        self.jwt = ""
        self.session_id = ""
        self.user_id = ""

    def _clerk_headers(self) -> dict[str, str]:
        return {
            "Cookie": self.cookie,
            "Origin": "https://suno.com",
            "Referer": "https://suno.com/",
            "User-Agent": "Mozilla/5.0",
        }

    def conectar(self) -> dict[str, str]:
        client = request_json(
            f"{CLERK_BASE}/v1/client?_clerk_js_version={CLERK_JS}",
            headers=self._clerk_headers(),
        )
        response = client.get("response") or {}
        self.session_id = str(response.get("last_active_session_id") or "")
        if not self.session_id:
            raise RuntimeError("La cookie de Suno expiró o no hay sesión activa")
        for session in response.get("sessions") or []:
            if session.get("id") == self.session_id:
                user = session.get("user") or {}
                self.user_id = str(user.get("id") or "")
                break
        tokens = request_json(
            f"{CLERK_BASE}/v1/client/sessions/{self.session_id}/tokens?_clerk_js_version={CLERK_JS}",
            method="POST",
            headers=self._clerk_headers(),
        )
        self.jwt = str(tokens.get("jwt") or "")
        if not self.jwt:
            raise RuntimeError("No se pudo obtener el token de Suno")
        return {"session_id": self.session_id, "user_id": self.user_id}

    def _api_headers(self) -> dict[str, str]:
        if not self.jwt:
            self.conectar()
        return {
            "Authorization": f"Bearer {self.jwt}",
            "Content-Type": "application/json",
            "Origin": "https://suno.com",
            "Referer": "https://suno.com/",
            "User-Agent": "Mozilla/5.0",
        }

    def listar_biblioteca(self) -> list[dict]:
        clips: list[dict] = []
        cursor = ""
        for _ in range(80):
            body: dict = {"limit": 50, "filters": {"trashed": "False"}}
            if cursor:
                body["cursor"] = cursor
            page = request_json(
                f"{SUNO_API}/api/feed/v3",
                method="POST",
                headers=self._api_headers(),
                body=json.dumps(body).encode("utf-8"),
            )
            batch = page.get("clips") or []
            clips.extend(batch)
            if not page.get("has_more"):
                break
            cursor = str(page.get("next_cursor") or "")
            if not cursor:
                break
        return clips

    def derechos(self, clip_id: str) -> dict:
        return request_json(
            f"{SUNO_API}/api/mango/rights",
            method="POST",
            headers=self._api_headers(),
            body=json.dumps({"content_params": {"content_id": clip_id, "content_type": "clip"}}).encode("utf-8"),
        )


def decrypt_media(clip_id: str, ciphertext: bytes, rights: dict) -> bytes:
    glt = str(rights.get("glt") or "")
    if not glt or not rights.get("key") or not rights.get("iv"):
        raise RuntimeError("Suno no devolvió claves de reproducción")
    user_key = hashlib.sha256(glt.encode("utf-8")).digest()
    aesgcm = AESGCM(user_key)
    aad = clip_id.encode("utf-8")
    raw_key = base64.b64decode(rights["key"])
    raw_iv = base64.b64decode(rights["iv"])
    content_key = aesgcm.decrypt(raw_key[:12], raw_key[12:], aad)
    content_iv = aesgcm.decrypt(raw_iv[:12], raw_iv[12:], aad)
    decryptor = Cipher(algorithms.AES(content_key), modes.CTR(content_iv)).decryptor()
    return decryptor.update(ciphertext) + decryptor.finalize()


def es_audio_reproducible(data: bytes) -> bool:
    return b"ftyp" in data[:64] or data[:4] == b"ID3" or data[:3] == b"\xff\xfb"


def obtener_sesion() -> SunoSesion:
    cookie = load_env().get("SUNO_COOKIE", "")
    if not cookie:
        raise RuntimeError("Configurá SUNO_COOKIE en el archivo .env")
    sesion = SunoSesion(cookie)
    sesion.conectar()
    return sesion
