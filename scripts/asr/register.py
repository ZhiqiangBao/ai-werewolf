"""Register pinned, already-downloaded ASR files without network or model imports."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid

import server

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_COPY = Path(__file__).with_name("runtime-manifest.v0.4.1.json")


def absolute_directory(value, label):
    path = Path(value).expanduser()
    if not path.is_absolute() or not path.is_dir():
        raise ValueError(f"{label} must be an existing absolute directory")
    return path.resolve()


def file_hashes(path, size, git_blob=False):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != size:
        raise ValueError(f"missing or incorrect file: {path.name}")
    sha = hashlib.sha256()
    git = hashlib.sha1(f"blob {size}\0".encode()) if git_blob else None
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            sha.update(chunk)
            if git is not None:
                git.update(chunk)
    return sha.hexdigest(), git.hexdigest() if git else None


def model_manifest(backend, model):
    expected = server.EXPECTED if backend == "transformers" else {server.GGUF_FILE: (server.GGUF_SIZE, server.GGUF_SHA)}
    entries = []
    for name, (size, known) in expected.items():
        if Path(name).name != name or len(known) not in (40, 64):
            raise ValueError("invalid pinned model file definition")
        sha, git = file_hashes(model / name, size, len(known) == 40)
        if (git if len(known) == 40 else sha) != known:
            raise ValueError(f"model checksum mismatch: {name}")
        entries.append({"file": name, "bytes": size, "sha256": sha})
    return {"format": "werewolf-local-asr-model", "version": 1,
            "repo": server.REPO if backend == "transformers" else server.GGUF_REPO,
            "revision": server.REVISION if backend == "transformers" else server.GGUF_REVISION,
            "directory": str(model), "files": entries}


def check_runtime(root):
    trusted = RUNTIME_COPY.read_bytes()
    if hashlib.sha256(trusted).hexdigest() != server.RUNTIME_MANIFEST_SHA:
        raise ValueError("bundled runtime manifest checksum mismatch")
    manifest = json.loads(trusted)
    if manifest.get("release") != "v0.4.1" or not isinstance(manifest.get("files"), list):
        raise ValueError("invalid bundled runtime manifest")
    target = root / "runtime-manifest.json"
    if target.is_symlink() or (target.exists() and target.read_bytes() != trusted):
        raise ValueError("existing runtime manifest differs; not overwritten")
    for entry in manifest["files"]:
        name = entry["file"]
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or not relative.parts:
            raise ValueError("invalid runtime file path")
        path = root / relative
        # Reject symlinks in intermediate directories as well as in the file.
        if any((root.joinpath(*relative.parts[:i])).is_symlink() for i in range(1, len(relative.parts) + 1)):
            raise ValueError("runtime symlinks are not accepted")
        digest, _ = file_hashes(path, entry["bytes"])
        if digest != entry["sha256"]:
            raise ValueError(f"runtime checksum mismatch: {name}")
    library_dir = root / "native/transcribe-native-windows-x86_64-cpu-vulkan"
    bindings_dir = root / "python/transcribe_cpp"
    dlls = {Path(e["file"]).name.lower() for e in manifest["files"] if e["file"].endswith(".dll")}
    modules = {Path(e["file"]).name for e in manifest["files"] if e["file"].startswith("python/transcribe_cpp/") and e["file"].endswith(".py")}
    if {p.name.lower() for p in library_dir.glob("*.dll")} != dlls or {p.name for p in bindings_dir.glob("*.py")} != modules:
        raise ValueError("unexpected GGUF runtime DLL or Python binding")
    return target, trusted


def same_model_manifest(path, expected):
    if path.is_symlink():
        return False
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(current, dict):
            return False
        for key in ("format", "version", "repo", "revision"):
            if current.get(key) != expected[key]:
                return False
        if not Path(current["directory"]).is_absolute() or Path(current["directory"]).resolve() != Path(expected["directory"]):
            return False
        files = current["files"]
        return isinstance(files, list) and len(files) == len(expected["files"]) and all(
            any(isinstance(got, dict) and all(got.get(k) == want[k] for k in ("file", "bytes", "sha256")) for got in files)
            for want in expected["files"])
    except (OSError, ValueError, TypeError, KeyError):
        return False


def write_new(path, data):
    # Exclusive creation never overwrites existing user data, even after a race.
    try:
        stream = path.open("xb")
    except FileExistsError:
        raise ValueError(f"existing file differs; not overwritten: {path.name}") from None
    try:
        with stream:
            stream.write(data)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def replace_with_backup(path, data):
    if path.is_symlink() or not path.is_file():
        raise ValueError("existing model manifest must be a regular file")
    old = path.read_bytes()
    backup = path.with_name(path.name + ".backup-" + uuid.uuid4().hex)
    fd, name = tempfile.mkstemp(prefix=path.name + ".tmp-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        write_new(backup, old)
        if path.is_symlink() or not path.is_file() or path.read_bytes() != old:
            raise ValueError("model manifest changed during replacement; not overwritten")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return backup


def register(backend, model_dir, data_dir, runtime_dir=None, replace=False):
    model = absolute_directory(model_dir, "model directory")
    data = Path(data_dir).expanduser().resolve()
    if backend == "transformers" and runtime_dir:
        raise ValueError("runtime directory applies only to gguf")
    if backend == "gguf":
        if not runtime_dir:
            if os.name != "nt":
                raise ValueError("gguf requires --runtime-dir on this platform")
            runtime_dir = "D:/QWEN/runtime/transcribe-cpp-0.4.1"
        runtime = absolute_directory(runtime_dir, "runtime directory")
        runtime_file, trusted = check_runtime(runtime)
    else:
        runtime_file = trusted = None
    manifest = model_manifest(backend, model)
    control = data / "local-asr"
    target = control / ("model-manifest.gguf.json" if backend == "gguf" else "model-manifest.json")
    replace_model = False
    if target.exists() or target.is_symlink():
        if not same_model_manifest(target, manifest):
            if not replace or target.is_symlink() or not target.is_file():
                raise ValueError("existing model manifest differs; not overwritten")
            replace_model = True
        new_model = False
    else:
        new_model = True
    # All files and any existing manifests have been checked before making changes.
    control.mkdir(parents=True, exist_ok=True)
    created_runtime = False
    backup = None
    try:
        if runtime_file is not None and not runtime_file.exists():
            write_new(runtime_file, trusted)
            created_runtime = True
        if new_model:
            write_new(target, (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        elif replace_model:
            backup = replace_with_backup(target, (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    except BaseException:
        if created_runtime and runtime_file.read_bytes() == trusted:
            runtime_file.unlink()
        raise
    return {"backend": backend, "modelManifest": str(target), "modelDirectory": str(model),
            "runtimeDirectory": str(runtime_file.parent) if runtime_file else None, "created": new_model,
            "replaced": replace_model, "backup": str(backup) if backup else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline registration of pinned, already-downloaded local ASR files")
    parser.add_argument("--backend", required=True, choices=("transformers", "gguf"))
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--data-dir", default=str(ROOT / "data"))
    parser.add_argument("--runtime-dir")
    parser.add_argument("--replace", action="store_true", help="Back up and atomically replace an existing differing model manifest after all checks")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(register(args.backend, args.model_dir, args.data_dir, args.runtime_dir, args.replace)))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Registration failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
