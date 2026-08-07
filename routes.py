"""Local persistence, diagnostics, card export, and training-upload routes."""

import json
import os
import re
import secrets
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from fastapi import HTTPException, Request

# Curated upload destination; settings reads it from the config route.
_PCLOUD_UPLOAD_CODE = "itd7ZwmOK8S2D6XSAE1Q9cUPaF5c9WFfk"
_PCLOUD_DEFAULT_URL = "https://e.pcloud.com/#/puplink?code=" + _PCLOUD_UPLOAD_CODE
_PCLOUD_UPLOAD_URL = "https://eapi.pcloud.com/uploadtolink"

_PCLOUD_CODE_RE = re.compile(r"code=([A-Za-z0-9_-]+)")

_PCLOUD_BARE_RE = re.compile(r"^[A-Za-z0-9_-]+$")

_PCLOUD_NAME_STEM_RE = re.compile(r"[^a-z0-9]+")
_PCLOUD_NAME_DASH_COLLAPSE_RE = re.compile(r"-+")

def _sanitize_pcloud_filename(name: str) -> str:
    p = Path(name)
    stem = (p.stem or "training").lower()
    ext = (p.suffix or ".zip").lower()
    stem = _PCLOUD_NAME_STEM_RE.sub("-", stem)
    stem = _PCLOUD_NAME_DASH_COLLAPSE_RE.sub("-", stem).strip("-")
    if not stem:
        stem = "training"
    if len(stem) > 80:
        stem = stem[:80].rstrip("-")

    if not re.fullmatch(r"\.[a-z0-9]{1,8}", ext):
        ext = ".bin"
    return stem + ext

# These limits bound memory, disk, and upload work.
_BUNDLE_MAX_BYTES = 64 * 1024 * 1024

_TRAINING_BODY_MAX_BYTES = 16 * 1024 * 1024

_PCLOUD_TIMEOUT_S = 300

_RECORDINGS_REL = "note_detect_recordings"

_SLUG_RE = re.compile(r"[^A-Za-z0-9_-]+")
_SLUG_MAX = 40

_MAX_BYTES = 32 * 1024 * 1024

_LIVE_JUDGMENT_MAX_BYTES = 8 * 1024

_LIVE_FILE_MAX_BYTES = 8 * 1024 * 1024

_CARD_MAX_BYTES = 16 * 1024 * 1024

_CARD_NAME_RE = re.compile(r"[^A-Za-z0-9 ._&(),'-]+")

def _default_pictures_dir() -> Path:
    """Return the default results-card directory."""
    return Path.home() / "Pictures"

def _resolve_card_dir(raw: str, auto: bool = False) -> Path:
    """Resolve an absolute card destination, using Pictures by default."""
    raw = (raw or "").strip()
    if not raw:
        base = _default_pictures_dir()
        return base / "feedBack Cards" if auto else base
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise HTTPException(400, "save folder must be an absolute path")
    return p

def _sanitize_card_filename(name: str) -> str:

    base = Path(str(name or "")).name
    base = _CARD_NAME_RE.sub("-", base)
    base = re.sub(r"\s+", " ", base).strip(" -_.") or "score-card"
    if not base.lower().endswith(".png"):
        base = re.sub(r"\.[^.]*$", "", base) + ".png"
    return base[:120]

def _parse_pcloud_code(upload_url: str | None) -> str | None:
    """Extract a pCloud upload code; reject malformed non-empty values."""
    if not upload_url:
        return _PCLOUD_UPLOAD_CODE
    s = upload_url.strip()
    if not s:
        return _PCLOUD_UPLOAD_CODE
    m = _PCLOUD_CODE_RE.search(s)
    if m:
        return m.group(1)
    if _PCLOUD_BARE_RE.fullmatch(s):
        return s
    return None

def _sanitize_slug(s: str, default: str = "recording") -> str:

    s = (s or "").strip()
    s = _SLUG_RE.sub("_", s)[:_SLUG_MAX].strip("_")
    return s or default

async def _read_capped_body(request: Request, max_bytes: int) -> bytes:
    """Read a request body without buffering more than the configured limit."""
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > max_bytes:
                raise HTTPException(
                    413, f"request body too large ({cl} bytes > {max_bytes})")
        except ValueError:
            pass
    chunks: list = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                413, f"request body too large (> {max_bytes} bytes)")
        chunks.append(chunk)
    return b"".join(chunks)

def setup(app, context):
    # Resolve writable storage lazily so registration cannot fail at startup.
    log = context["log"]

    _candidate_dirs = []
    if os.environ.get("STATIC_DIR"):
        _candidate_dirs.append(Path(os.environ["STATIC_DIR"]) / _RECORDINGS_REL)
    if os.environ.get("CONFIG_DIR"):
        _candidate_dirs.append(Path(os.environ["CONFIG_DIR"]) / _RECORDINGS_REL)
    _candidate_dirs.append(Path("/app/static") / _RECORDINGS_REL)

    _resolved_dir: list = [None]

    def _ensure_out_dir() -> Path:
        if _resolved_dir[0] is not None:
            return _resolved_dir[0]
        errors = []
        for cand in _candidate_dirs:
            try:
                cand.mkdir(parents=True, exist_ok=True)

                probe = cand / f".write_test_{os.getpid()}_{secrets.token_hex(6)}"
                probe.write_bytes(b"")
                probe.unlink()
            except OSError as e:
                errors.append(f"{cand}: {e}")
                continue
            _resolved_dir[0] = cand
            log.info("note_detect recordings directory: %s", cand)
            return cand
        raise HTTPException(
            500,
            "could not find a writable recordings directory (tried: "
            + "; ".join(errors) + ")",
        )

    @app.post("/api/plugins/note_detect/recording")
    async def save_recording(request: Request):
        body = await request.body()

        if not body or len(body) < 44:
            raise HTTPException(400, "empty or too-short body (expected a WAV file)")
        if len(body) > _MAX_BYTES:
            raise HTTPException(413, f"recording too large ({len(body)} bytes > {_MAX_BYTES})")
        if body[:4] != b"RIFF" or body[8:12] != b"WAVE":
            raise HTTPException(400, "body is not a WAV file (no RIFF/WAVE header)")

        slug = _sanitize_slug(request.query_params.get("slug", "recording"))

        now = time.time()
        ts = time.strftime("%Y%m%d_%H%M%S", time.localtime(now))
        ms = int((now - int(now)) * 1000)
        suffix = secrets.token_hex(3)
        filename = f"note_detect_{slug}_{ts}_{ms:03d}_{suffix}.wav"
        path = _ensure_out_dir() / filename

        # Publish recordings atomically.
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_bytes(body)
            tmp.replace(path)
        except OSError as e:
            raise HTTPException(
                500,
                f"could not write recording ({tmp}): {e}",
            )

        rel = f"static/{_RECORDINGS_REL}/{filename}"
        log.info(
            "saved recording (%d bytes, slug=%s) to %s",
            len(body), slug, str(path),
        )
        return {
            "path_in_container": str(path),
            "relative_path": rel,
            "filename": filename,
            "bytes": len(body),
        }

    @app.post("/api/plugins/note_detect/live-judgment")
    async def append_live_judgment(request: Request):
        body = await request.body()
        if not body:
            raise HTTPException(400, "empty body (expected a JSON judgment object)")
        if len(body) > _LIVE_JUDGMENT_MAX_BYTES:
            raise HTTPException(
                413,
                f"judgment too large ({len(body)} bytes > {_LIVE_JUDGMENT_MAX_BYTES})",
            )

        try:
            obj = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"body is not valid JSON: {e}")
        if not isinstance(obj, dict):
            raise HTTPException(400, "judgment body must be a JSON object")

        session = _sanitize_slug(request.query_params.get("session", "default"), default="default")
        path = _ensure_out_dir() / f"live_{session}.jsonl"

        try:
            existing = path.stat().st_size
        except FileNotFoundError:
            existing = 0
        except OSError as e:
            raise HTTPException(
                500,
                f"could not stat live-judgment file ({path}): {e}",
            )
        line = json.dumps(obj, separators=(",", ":")) + "\n"
        line_bytes = line.encode("utf-8")
        if existing + len(line_bytes) > _LIVE_FILE_MAX_BYTES:
            raise HTTPException(
                413,
                f"live judgment file at cap ({existing} + {len(line_bytes)} > {_LIVE_FILE_MAX_BYTES})",
            )

        try:
            # Append mode preserves individual JSONL records across clients.
            with path.open("ab") as f:
                f.write(line_bytes)
        except OSError as e:
            raise HTTPException(
                500,
                f"could not write to live-judgment file ({path}): {e}",
            )
        return {"ok": True, "appended": len(line_bytes), "file": f"static/{_RECORDINGS_REL}/{path.name}"}

    @app.post("/api/plugins/note_detect/training-bundle")
    async def upload_training_bundle(request: Request):

        raw = await _read_capped_body(request, _TRAINING_BODY_MAX_BYTES)
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"body is not valid JSON: {e}")
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")

        slug = _sanitize_slug(body.get("slug", ""), default="")
        if not slug:
            raise HTTPException(400, "missing or empty 'slug'")

        session_raw = body.get("session")
        if session_raw is not None and not isinstance(session_raw, str):
            raise HTTPException(400, "'session' must be a string or null")
        session = _sanitize_slug(session_raw, default="") if session_raw else ""

        manifest = body.get("manifest")
        if manifest is None:
            manifest = {}
        elif not isinstance(manifest, dict):
            raise HTTPException(400, "'manifest' must be a JSON object")

        upload_url_override = body.get("upload_url")
        if upload_url_override is not None and not isinstance(upload_url_override, str):
            raise HTTPException(400, "'upload_url' must be a string or null")
        pcloud_code = _parse_pcloud_code(upload_url_override)
        if pcloud_code is None:
            raise HTTPException(
                400,
                "'upload_url' contains no recognisable pCloud upload code "
                "(expected a puplink share URL, an uploadtolink URL, or a "
                "bare code) — clear the field to use the curated default",
            )

        base = _ensure_out_dir()

        wav_filename = body.get("wav_filename")
        if wav_filename is not None and not isinstance(wav_filename, str):
            raise HTTPException(400, "'wav_filename' must be a string or null")
        wav_path = None
        if wav_filename:
            cand = (base / wav_filename).resolve()
            try:
                cand.relative_to(base.resolve())
            except ValueError:
                raise HTTPException(400, "'wav_filename' is outside the recordings directory")
            if not re.fullmatch(r"note_detect_.+\.wav", cand.name):
                raise HTTPException(400, "'wav_filename' is not a note_detect recording")
            if not cand.is_file():
                raise HTTPException(404, f"recording not found: {cand.name}")
            wav_path = cand
        if wav_path is None:

            wav_candidates = sorted(
                base.glob(f"note_detect_{slug}_*.wav"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if not wav_candidates:
                raise HTTPException(
                    404,
                    f"no recording found for slug={slug!r} under {base} — "
                    "POST /recording first, then /training-bundle.",
                )
            wav_path = wav_candidates[0]

        jsonl_path = (base / f"live_{session}.jsonl") if session else None
        has_jsonl = bool(jsonl_path) and jsonl_path.exists() and jsonl_path.is_file()

        manifest = dict(manifest)
        for _sect in ("audio", "detect_stream"):
            if _sect in manifest and not isinstance(manifest[_sect], dict):
                raise HTTPException(
                    400, f"manifest '{_sect}' must be a JSON object if present")

        manifest["schema"] = "note_detect.training_bundle.v1"
        manifest["created_at"] = datetime.now(timezone.utc).isoformat()
        manifest["audio"] = {
            **(manifest.get("audio") or {}),
            "filename": wav_path.name,
            "bytes": wav_path.stat().st_size,
        }

        if has_jsonl:
            manifest["detect_stream"] = {
                **(manifest.get("detect_stream") or {}),
                "filename": jsonl_path.name,
                "bytes": jsonl_path.stat().st_size,
            }
        else:
            manifest.pop("detect_stream", None)

        arrangement = body.get("arrangement")
        if arrangement is not None and not isinstance(arrangement, dict):
            raise HTTPException(400, "'arrangement' must be a JSON object or null")
        arrangement_json = None

        if arrangement is not None:
            arrangement_json = json.dumps(arrangement, indent=2, sort_keys=True)
            notes = arrangement.get("notes")
            chords = arrangement.get("chords")
            manifest["arrangement_chart"] = {
                "filename": "arrangement.json",
                "note_count": len(notes) if isinstance(notes, list) else None,
                "chord_count": len(chords) if isinstance(chords, list) else None,
            }
        else:

            manifest.pop("arrangement_chart", None)

        bundle_name = "training_" + wav_path.stem.removeprefix("note_detect_") + ".zip"
        bundle_path = base / bundle_name
        tmp_path = bundle_path.with_suffix(bundle_path.suffix + ".tmp")
        try:
            with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.write(wav_path, arcname=wav_path.name)
                if has_jsonl:
                    zf.write(jsonl_path, arcname=jsonl_path.name)
                if arrangement_json is not None:
                    zf.writestr("arrangement.json", arrangement_json)
                zf.writestr(
                    "manifest.json",
                    json.dumps(manifest, indent=2, sort_keys=True),
                )
            tmp_path.replace(bundle_path)
        except OSError as e:
            if tmp_path.exists():
                try: tmp_path.unlink()
                except OSError: pass
            raise HTTPException(500, f"could not write training bundle: {e}")

        # Retain failed bundles so retry can send the exact take.
        bundle_size = bundle_path.stat().st_size
        if bundle_size > _BUNDLE_MAX_BYTES:

            raise HTTPException(
                413,
                f"bundle too large ({bundle_size} bytes > {_BUNDLE_MAX_BYTES}); "
                f"retained at {bundle_path}",
            )

        rel = f"static/{_RECORDINGS_REL}/{bundle_name}"
        log.info(
            "wrote training bundle %s (%d bytes); uploading to pCloud",
            bundle_name, bundle_size,
        )
        pcloud_filename = _sanitize_pcloud_filename(bundle_name)
        log.info(
            "uploading bundle to pCloud (local: %s, pcloud_filename: %s)",
            bundle_name, pcloud_filename,
        )
        try:
            pcloud_result = await _upload_to_pcloud(bundle_path, pcloud_filename, pcloud_code)
        except Exception as e:

            log.warning(
                "pCloud upload failed (%s); bundle retained at %s, pcloud_filename=%s",
                e, bundle_path, pcloud_filename,
            )
            return {
                "ok": False,
                "error": str(e),
                "local_bundle": str(bundle_path),
                "relative_path": rel,
                "bundle_filename": bundle_name,

                "pcloud_filename": pcloud_filename,
                "bytes": bundle_size,
            }

        log.info(
            "uploaded training bundle %s (%d bytes) to pCloud: %s",
            bundle_name, bundle_size, pcloud_result,
        )
        return {
            "ok": True,
            "local_bundle": str(bundle_path),
            "relative_path": rel,
            "bundle_filename": bundle_name,
            "bytes": bundle_size,
            "pcloud_result": pcloud_result,
        }

    @app.post("/api/plugins/note_detect/save-card")
    async def save_card(request: Request):

        body = await _read_capped_body(request, _CARD_MAX_BYTES)
        if not body or body[:8] != b"\x89PNG\r\n\x1a\n":
            raise HTTPException(400, "body is not a PNG image")
        auto = request.query_params.get("auto", "") in ("1", "true", "yes")
        target = _resolve_card_dir(request.query_params.get("dir", ""), auto=auto)
        name = _sanitize_card_filename(request.query_params.get("name", "score-card.png"))
        try:
            target.mkdir(parents=True, exist_ok=True)
            path = target / name

            if auto and path.exists():
                stem, suffix = path.stem, path.suffix
                i = 2
                while (target / f"{stem} ({i}){suffix}").exists():
                    i += 1
                path = target / f"{stem} ({i}){suffix}"
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_bytes(body)
            tmp.replace(path)
        except OSError as e:
            raise HTTPException(500, f"could not save card to {target}: {e}")
        log.info("saved results card (%d bytes) to %s", len(body), str(path))
        return {
            "ok": True,
            "path": str(path),
            "dir": str(target),
            "filename": path.name,
            "bytes": len(body),
        }

    @app.get("/api/plugins/note_detect/config")
    async def get_config():

        return {"pcloud_default_url": _PCLOUD_DEFAULT_URL}

    @app.post("/api/plugins/note_detect/training-bundle/retry")
    async def retry_training_bundle(request: Request):

        raw = await _read_capped_body(request, _TRAINING_BODY_MAX_BYTES)
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"body is not valid JSON: {e}")
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")

        local_bundle = body.get("local_bundle")
        if not local_bundle or not isinstance(local_bundle, str):
            raise HTTPException(400, "missing or invalid 'local_bundle'")
        upload_url_override = body.get("upload_url")
        if upload_url_override is not None and not isinstance(upload_url_override, str):
            raise HTTPException(400, "'upload_url' must be a string or null")
        pcloud_code = _parse_pcloud_code(upload_url_override)
        if pcloud_code is None:
            raise HTTPException(
                400,
                "'upload_url' contains no recognisable pCloud upload code "
                "— clear the field to use the curated default",
            )

        base = _ensure_out_dir()

        # Retry accepts only bundles created inside this plugin's storage directory.
        try:
            bundle_path = Path(local_bundle).resolve()
            bundle_path.relative_to(base.resolve())
        except (ValueError, OSError):
            raise HTTPException(400, "'local_bundle' is outside the recordings directory")
        if not (bundle_path.name.startswith("training_")
                and bundle_path.suffix == ".zip"):
            raise HTTPException(400, "'local_bundle' is not a training bundle zip")
        if not bundle_path.is_file():
            raise HTTPException(404, f"bundle not found: {bundle_path}")

        bundle_size = bundle_path.stat().st_size

        if bundle_size > _BUNDLE_MAX_BYTES:
            raise HTTPException(
                413,
                f"bundle too large ({bundle_size} bytes > {_BUNDLE_MAX_BYTES}); "
                f"retained at {bundle_path}",
            )
        rel = f"static/{_RECORDINGS_REL}/{bundle_path.name}"
        pcloud_filename = _sanitize_pcloud_filename(bundle_path.name)
        log.info(
            "retrying pCloud upload for %s (pcloud_filename: %s)",
            bundle_path.name, pcloud_filename,
        )
        try:
            pcloud_result = await _upload_to_pcloud(bundle_path, pcloud_filename, pcloud_code)
        except Exception as e:
            log.warning(
                "pCloud retry upload failed (%s); bundle retained at %s",
                e, bundle_path,
            )
            return {
                "ok": False,
                "error": str(e),
                "local_bundle": str(bundle_path),
                "relative_path": rel,
                "bundle_filename": bundle_path.name,
                "pcloud_filename": pcloud_filename,
                "bytes": bundle_size,
            }

        log.info(
            "retry uploaded training bundle %s (%d bytes) to pCloud: %s",
            bundle_path.name, bundle_size, pcloud_result,
        )
        return {
            "ok": True,
            "local_bundle": str(bundle_path),
            "relative_path": rel,
            "bundle_filename": bundle_path.name,
            "bytes": bundle_size,
            "pcloud_result": pcloud_result,
        }

    async def _upload_to_pcloud(file_path: Path, filename: str, code: str) -> dict:
        # Run urllib in a worker so uploads do not block the event loop.

        import urllib.parse
        import urllib.request
        import anyio

        def _post() -> dict:

            query = urllib.parse.urlencode(
                {"code": code, "nopartial": "1", "names": filename})
            url = f"{_PCLOUD_UPLOAD_URL}?{query}"
            file_bytes = file_path.read_bytes()

            boundary = "----slopsmithND" + secrets.token_hex(16)
            preamble = (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; '
                f'filename="{filename}"\r\n'
                f"Content-Type: application/zip\r\n\r\n"
            ).encode("utf-8")
            epilogue = f"\r\n--{boundary}--\r\n".encode("utf-8")
            body = preamble + file_bytes + epilogue
            req = urllib.request.Request(
                url,
                data=body,
                method="POST",
                headers={
                    "Content-Type": f"multipart/form-data; boundary={boundary}",
                    "Content-Length": str(len(body)),
                },
            )
            with urllib.request.urlopen(req, timeout=_PCLOUD_TIMEOUT_S) as resp:
                status = resp.status
                raw = resp.read()
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                raise RuntimeError(
                    f"pCloud returned non-JSON response (HTTP {status}): "
                    f"{raw[:200]!r}"
                ) from e

            if data.get("result") != 0:
                raise RuntimeError(
                    f"pCloud rejected upload: result={data.get('result')}, "
                    f"error={data.get('error')!r}"
                )
            return data

        return await anyio.to_thread.run_sync(_post)
