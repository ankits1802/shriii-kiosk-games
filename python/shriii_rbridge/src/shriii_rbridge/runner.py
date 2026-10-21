"""Process runners for the shriiipsy CLI: a pinned Docker image or a local ``Rscript`` with shriiipsy installed.

A runner receives a prepared work directory containing ``request.json`` (and any data files the request
references by relative path), executes ``shriiipsy run`` on it and returns the parsed ``response.json``.
Runners never interpret results; they only report process-level failures as :class:`RRunError`.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import sys
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from shriii_rbridge._version import DEFAULT_IMAGE

__all__ = [
    "DockerRunner",
    "LocalRscriptRunner",
    "RRunError",
    "RRunner",
    "docker_available",
    "docker_image_present",
    "local_shriiipsy_available",
]

REQUEST_FILE = "request.json"
RESPONSE_FILE = "response.json"
_STDERR_TAIL = 4000


class RRunError(RuntimeError):
    """The R process could not be run or produced no parseable response."""

    def __init__(self, message: str, *, returncode: int | None = None, stderr: str = "") -> None:
        super().__init__(message)
        self.returncode = returncode
        self.stderr = stderr


@runtime_checkable
class RRunner(Protocol):
    """Executes one shriiipsy request held in ``workdir``."""

    @property
    def kind(self) -> str: ...

    def describe(self) -> dict[str, Any]: ...

    def run(self, workdir: Path, *, timeout: float | None = None) -> dict[str, Any]: ...


def _read_response(workdir: Path, proc: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    path = workdir / RESPONSE_FILE
    if not path.exists():
        raise RRunError(
            f"shriiipsy produced no response (exit {proc.returncode})",
            returncode=proc.returncode,
            stderr=proc.stderr[-_STDERR_TAIL:],
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RRunError(f"unparseable shriiipsy response: {exc}", returncode=proc.returncode) from exc
    if not isinstance(data, dict):
        raise RRunError("shriiipsy response is not a JSON object", returncode=proc.returncode)
    return data


def _execute(
    cmd: list[str],
    workdir: Path,
    timeout: float | None,
    env: dict[str, str] | None = None,
    on_timeout: Callable[[], None] | None = None,
) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RRunError(f"executable not found: {cmd[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        if on_timeout is not None:
            on_timeout()
        raise RRunError(f"shriiipsy timed out after {timeout} s") from exc
    except OSError as exc:
        raise RRunError(f"could not start {cmd[0]}: {exc}") from exc
    return _read_response(workdir, proc)


def docker_available() -> bool:
    """True when the docker CLI exists and the daemon answers."""
    exe = shutil.which("docker")
    if exe is None:
        return False
    try:
        proc = subprocess.run(
            [exe, "info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True, timeout=60, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0 and bool(proc.stdout.strip())


def docker_image_present(image: str) -> bool:
    """True when ``image`` exists in the local docker image store."""
    exe = shutil.which("docker")
    if exe is None:
        return False
    try:
        proc = subprocess.run(
            [exe, "image", "inspect", "--format", "{{.Id}}", image],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


def local_shriiipsy_available(rscript: str | None = None) -> bool:
    """True when a local ``Rscript`` can load the shriiipsy package."""
    exe = rscript or shutil.which("Rscript")
    if exe is None:
        return False
    try:
        proc = subprocess.run(
            [exe, "-e", "quit(status = if (requireNamespace('shriiipsy', quietly = TRUE)) 0 else 1)"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


@dataclass(frozen=True, slots=True)
class DockerRunner:
    """Runs the shriiipsy image with the work directory bind-mounted at ``/work`` and no network.

    The container is hardened: the image is never pulled implicitly (a missing local image fails instead of
    fetching a same-named image from a registry and handing it the data), all capabilities are dropped,
    privilege escalation is disabled and the root filesystem is read-only (``/tmp`` is a tmpfs). Each run
    gets a unique container name so a timed-out analysis is killed rather than left running.
    """

    image: str = DEFAULT_IMAGE
    docker: str = "docker"
    memory: str | None = None
    cpus: float | None = None
    extra_args: tuple[str, ...] = ()
    kind: str = field(default="docker", init=False)

    def describe(self) -> dict[str, Any]:
        return {"runner": self.kind, "image": self.image}

    def command(self, workdir: Path, name: str | None = None) -> list[str]:
        cmd = [
            self.docker,
            "run",
            "--rm",
            "--network",
            "none",
            "--pull",
            "never",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,exec",
            "--mount",
            f"type=bind,source={workdir.resolve()},target=/work",
            "-e",
            "HOME=/tmp",
        ]
        if name:
            cmd += ["--name", name]
        if sys.platform != "win32" and hasattr(os, "getuid"):
            cmd += ["--user", f"{os.getuid()}:{os.getgid()}"]
        if self.memory:
            cmd += ["--memory", self.memory]
        if self.cpus:
            cmd += ["--cpus", str(self.cpus)]
        cmd += list(self.extra_args)
        cmd += [self.image, "run", "--request", f"/work/{REQUEST_FILE}", "--response", f"/work/{RESPONSE_FILE}"]
        return cmd

    def _kill(self, name: str) -> None:
        with contextlib.suppress(OSError, subprocess.TimeoutExpired):
            subprocess.run([self.docker, "kill", name], capture_output=True, timeout=60, check=False)

    def run(self, workdir: Path, *, timeout: float | None = None) -> dict[str, Any]:
        name = f"shriiipsy-{uuid.uuid4().hex[:16]}"
        return _execute(self.command(workdir, name), workdir, timeout, on_timeout=lambda: self._kill(name))


@dataclass(frozen=True, slots=True)
class LocalRscriptRunner:
    """Runs ``Rscript`` on this machine (shriiipsy must be installed in its library)."""

    rscript: str = "Rscript"
    kind: str = field(default="local", init=False)

    def describe(self) -> dict[str, Any]:
        return {"runner": self.kind, "rscript": self.rscript}

    def command(self, workdir: Path) -> list[str]:
        return [
            self.rscript,
            "-e",
            "quit(save = 'no', status = shriiipsy::cli_main(commandArgs(TRUE)))",
            "run",
            "--request",
            str(workdir / REQUEST_FILE),
            "--response",
            str(workdir / RESPONSE_FILE),
        ]

    def run(self, workdir: Path, *, timeout: float | None = None) -> dict[str, Any]:
        env = dict(os.environ)
        env.setdefault("OPENBLAS_NUM_THREADS", "1")
        env.setdefault("OMP_NUM_THREADS", "1")
        return _execute(self.command(workdir), workdir, timeout, env=env)
