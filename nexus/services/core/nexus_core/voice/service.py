"""Local speech-to-text and text-to-speech. Nothing leaves the machine.

STT engines (first available wins in `auto`):
  * mlx  – `mlx_whisper` Python package (Apple Silicon GPU). Optional extra.
  * whispercpp – `whisper-cli` (Homebrew `whisper-cpp`) + a ggml model file.
TTS engines:
  * piper – `piper` binary + an .onnx voice (if configured via NEXUS_PIPER_VOICE)
  * say   – macOS built-in `say`, always available on macOS.

Audio from the webview arrives as webm/opus or wav; ffmpeg converts it to
16 kHz mono wav when needed. The microphone is only ever opened by the UI on
push-to-talk; this service never records.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ..config import IS_MACOS
from ..settings_store import SettingsStore


class VoiceUnavailable(Exception):
    pass


def _which(name: str) -> str | None:
    return shutil.which(name) or next(
        (p for p in (f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}") if os.path.exists(p)), None
    )


class VoiceService:
    def __init__(self, settings: SettingsStore, work_dir: Path):
        self.settings = settings
        self.work_dir = work_dir
        self._voices: list[dict[str, str]] | None = None

    # -- capability detection ----------------------------------------------
    def status(self) -> dict[str, Any]:
        mlx = importlib.util.find_spec("mlx_whisper") is not None
        whisper_cli = _which("whisper-cli") or _which("whisper-cpp")
        whisper_model = self.settings.get("voice.whisper_model") or os.environ.get("NEXUS_WHISPER_MODEL", "")
        ffmpeg = _which("ffmpeg")
        piper = _which("piper")
        piper_voice = os.environ.get("NEXUS_PIPER_VOICE", "")
        say = IS_MACOS and Path("/usr/bin/say").exists()
        stt = []
        if mlx:
            stt.append("mlx")
        if whisper_cli and whisper_model and Path(whisper_model).exists():
            stt.append("whispercpp")
        tts = []
        if piper and piper_voice and Path(piper_voice).exists():
            tts.append("piper")
        if say:
            tts.append("say")
        return {
            "stt_engines": stt,
            "tts_engines": tts,
            "stt_available": bool(stt),
            "tts_available": bool(tts),
            "ffmpeg": bool(ffmpeg),
            "details": {
                "mlx_whisper_installed": mlx,
                "whisper_cli": whisper_cli,
                "whisper_model": whisper_model or None,
                "piper": piper,
                "piper_voice": piper_voice or None,
                "say": say,
            },
            "tts_enabled": bool(self.settings.get("voice.tts_enabled")),
        }

    # -- speech to text -----------------------------------------------------
    async def transcribe(self, audio: bytes, filename: str = "audio.webm") -> dict[str, Any]:
        st = self.status()
        pref = self.settings.get("voice.stt_engine") or "auto"
        engines = st["stt_engines"] if pref == "auto" else [e for e in st["stt_engines"] if e == pref]
        if not engines:
            raise VoiceUnavailable(
                "No local speech recognition engine is installed. Install `pip install mlx-whisper` (Apple Silicon) "
                "or `brew install whisper-cpp` and set a ggml model path in Settings → Voice."
            )
        with tempfile.TemporaryDirectory(dir=self.work_dir) as tmp:
            src = Path(tmp) / ("input" + (Path(filename).suffix or ".webm"))
            src.write_bytes(audio)
            wav = await self._to_wav(src, Path(tmp) / "input16k.wav")
            engine = engines[0]
            if engine == "mlx":
                text = await asyncio.to_thread(self._mlx_transcribe, wav)
            else:
                text = await self._whispercpp(wav, st["details"]["whisper_cli"], st["details"]["whisper_model"])
        return {"text": text.strip(), "engine": engine}

    async def _to_wav(self, src: Path, dest: Path) -> Path:
        if src.suffix.lower() == ".wav":
            return src
        ffmpeg = _which("ffmpeg")
        if not ffmpeg:
            raise VoiceUnavailable("ffmpeg is required to convert recorded audio (`brew install ffmpeg`).")
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-y", "-loglevel", "error", "-i", str(src), "-ar", "16000", "-ac", "1", str(dest),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        _, err = await asyncio.wait_for(proc.communicate(), timeout=60)
        if proc.returncode != 0:
            raise VoiceUnavailable(f"Audio conversion failed: {err.decode(errors='replace')[:300]}")
        return dest

    def _mlx_transcribe(self, wav: Path) -> str:
        import mlx_whisper  # type: ignore[import-not-found]

        repo = self.settings.get("voice.whisper_model") or "mlx-community/whisper-small-mlx"
        if os.path.exists(repo) and repo.endswith(".bin"):
            repo = "mlx-community/whisper-small-mlx"
        result = mlx_whisper.transcribe(str(wav), path_or_hf_repo=repo)
        return str(result.get("text", ""))

    async def _whispercpp(self, wav: Path, binary: str, model: str) -> str:
        proc = await asyncio.create_subprocess_exec(
            binary, "-m", model, "-f", str(wav), "-nt", "-np",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=180)
        if proc.returncode != 0:
            raise VoiceUnavailable(f"whisper.cpp failed: {err.decode(errors='replace')[:300]}")
        return out.decode(errors="replace")

    # -- text to speech -----------------------------------------------------
    async def voices(self) -> list[dict[str, str]]:
        if self._voices is not None:
            return self._voices
        voices: list[dict[str, str]] = []
        if IS_MACOS and Path("/usr/bin/say").exists():
            proc = await asyncio.create_subprocess_exec("/usr/bin/say", "-v", "?", stdout=asyncio.subprocess.PIPE)
            out, _ = await proc.communicate()
            for line in out.decode(errors="replace").splitlines():
                parts = line.split("#", 1)[0].split()
                if len(parts) >= 2:
                    voices.append({"id": " ".join(parts[:-1]), "locale": parts[-1], "engine": "say"})
        self._voices = voices
        return voices

    async def speak(self, text: str, voice: str | None = None) -> tuple[bytes, str]:
        st = self.status()
        if not st["tts_engines"]:
            raise VoiceUnavailable("No local text-to-speech engine available (macOS `say` or Piper).")
        text = text.strip()[:4000]
        if not text:
            raise VoiceUnavailable("Nothing to speak")
        with tempfile.TemporaryDirectory(dir=self.work_dir) as tmp:
            out = Path(tmp) / "speech.wav"
            if "piper" in st["tts_engines"]:
                proc = await asyncio.create_subprocess_exec(
                    st["details"]["piper"], "--model", st["details"]["piper_voice"], "--output_file", str(out),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc.communicate(text.encode()), timeout=120)
            else:
                v = voice or self.settings.get("voice.voice") or None
                known = {x["id"] for x in await self.voices()}
                args = ["/usr/bin/say", "-o", str(out), "--data-format=LEI16@22050"]
                if v and v in known:
                    args += ["-v", v]
                # `--` ends option parsing so text starting with "-" is never treated as a flag.
                proc = await asyncio.create_subprocess_exec(*args, "--", text, stderr=asyncio.subprocess.PIPE)
                await asyncio.wait_for(proc.communicate(), timeout=120)
            if not out.exists():
                raise VoiceUnavailable("Speech synthesis produced no audio")
            return out.read_bytes(), "audio/wav"
