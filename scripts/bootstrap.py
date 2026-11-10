"""Prepare the runtime of a released Horon build artifact — no repository, no network, no git.

    python bootstrap.py [--force]

Runs inside an unpacked artifact (the directory that holds `app/`, `wheels/` and
`requirements.lock.txt`) and does only one thing: create `app/.venv` and install the pinned
requirements from the bundled wheels, so the plugin can start `python -m uvicorn horon_web_app:app`
from `app/` afterwards.

Offline first: `pip install --no-index --find-links wheels` uses exactly the wheels the release
shipped. If the artifact carries no wheels (a developer build), it falls back to the pinned lock
over the network and says so.

Idempotent: a second run with the same lock, interpreter and platform exits immediately.
If `venv` is unavailable (some minimal Debian/Ubuntu images), it installs into `app/vendor`
instead and reports `"mode": "vendor"`; the plugin puts that directory on PYTHONPATH.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP = ROOT / "app"
LOCK = ROOT / "requirements.lock.txt"
WHEELS = ROOT / "wheels"
READY = APP / ".ready.json"

# pip decodes a requirements file with the *locale* encoding: on a Chinese Windows console that is
# cp936, and a UTF-8 requirements file then dies on its first non-ASCII byte. UTF-8 mode also makes
# pip's own output safe on the same console.
CHILD_ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


def stamp() -> dict:
    payload = LOCK.read_bytes() if LOCK.exists() else b""
    digest = hashlib.sha256(payload + sys.version.encode() + platform.machine().encode()).hexdigest()
    return {"stamp": digest, "python": sys.version.split()[0], "machine": platform.machine()}


def python_in(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def say(message: str) -> None:
    print(f"[bootstrap] {message}", flush=True)


def install(target: Path, extra: list[str]) -> None:
    command = [str(target), "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", *extra]
    say(" ".join(command))
    done = subprocess.run(command, env=CHILD_ENV)
    if done.returncode != 0:
        raise SystemExit(f"bootstrap: pip install failed with {done.returncode}")


def healthy(python: Path) -> bool:
    probe = "import fastapi, uvicorn, numpy, dotenv, pydantic, json_repair"
    done = subprocess.run([str(python), "-c", probe], capture_output=True, env=CHILD_ENV)
    return done.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description="prepare the Horon runtime inside a build artifact")
    parser.add_argument("--force", action="store_true", help="reinstall even when the stamp matches")
    parser.add_argument("--no-verify", action="store_true", help="skip the final import check")
    args = parser.parse_args()

    if not APP.is_dir():
        say(f"no app/ next to {Path(__file__).name}; run this from an unpacked artifact")
        return 2

    expected = stamp()
    if not args.force and READY.exists():
        try:
            recorded = json.loads(READY.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            recorded = {}
        mode = recorded.get("mode")
        interpreter = python_in(APP / ".venv") if mode == "venv" else Path(sys.executable)
        if recorded.get("stamp") == expected["stamp"] and interpreter.exists() and (args.no_verify or healthy(interpreter)):
            say(f"runtime already ready ({mode})")
            return 0

    wheels = sorted(WHEELS.glob("*.whl")) if WHEELS.is_dir() else []
    extra = ["-r", str(LOCK)] if LOCK.exists() else ["-r", str(APP / "requirements.txt")]

    if wheels:
        say(f"installing {len(wheels)} bundled wheels offline")
        offline = ["--no-index", "--find-links", str(WHEELS)]
    else:
        say("no wheels/ in this artifact; installing the pinned lock over the network")
        offline = []

    mode = "venv"
    venv = APP / ".venv"
    if args.force:
        import shutil

        shutil.rmtree(venv, ignore_errors=True)
    try:
        if not python_in(venv).exists():
            say(f"creating {venv}")
            subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True, env=CHILD_ENV)
        install(python_in(venv), [*offline, *extra])
        interpreter = python_in(venv)
    except (SystemExit, subprocess.CalledProcessError) as error:
        say(f"venv route failed ({error}); falling back to app/vendor")
        mode = "vendor"
        vendor = APP / "vendor"
        vendor.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir",
             "--target", str(vendor), *offline, *extra],
            check=True,
            env=CHILD_ENV,
        )
        interpreter = Path(sys.executable)

    if not args.no_verify and not healthy(interpreter):
        say("the interpreter cannot import fastapi/uvicorn after the install")
        return 3

    READY.write_text(json.dumps({**expected, "mode": mode, "interpreter": str(interpreter)}, indent=2), encoding="utf-8")
    say(f"runtime ready: {interpreter} ({mode})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
