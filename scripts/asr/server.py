"""Offline, loopback-only Qwen3-ASR worker. Never accepts text or file paths from clients."""
import argparse
import hashlib
import hmac
import io
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["DO_NOT_TRACK"] = "1"

REVISION = "7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c"
REPO = "Qwen/Qwen3-ASR-0.6B-hf"
GGUF_REPO = "handy-computer/Qwen3-ASR-1.7B-gguf"
GGUF_REVISION = "0e0a596e3959c3f3f2ab7d443a5b6f0f4a4bba6f"
GGUF_FILE = "Qwen3-ASR-1.7B-Q5_K_M.gguf"
GGUF_SHA = "034c557fe92ff8fcd9a9c041cbdaad347be0a86a58d3a348f63cf3f0180879d0"
RUNTIME_MANIFEST_SHA = "a97d3724c83f815cdab6b6992fba92c6836fa01d158feb7ccfb2e3a6a49468f8"
LIMIT = 16 * 1024 * 1024
MAX_SECONDS = 120
MAX_TOKENS = 1024
EXPECTED = {
    "README.md": (16538, "6bd0dfad309578014c4f1c669c23e5a3fdb4e849"),
    "chat_template.jinja": (1434, "491fff331513a97316daf53591c7b9b9da53ef8c"),
    "config.json": (2398, "3b4221f651b59ec21f545e5852b4d6cb23420b09"),
    "generation_config.json": (165, "3ed98c80087572bad932a83279c5602e58bbfc5c"),
    "model.safetensors": (1564928088, "d3f212dd20abecd315d830bc54ae3865e56ebfc3276484e57b771288ba27fd35"),
    "processor_config.json": (487, "a07dff48032bed341260501d6688036c6fd7f3ef"),
    "tokenizer.json": (11429653, "fe1fad59be22a41ee293363fcf95fdedbc7c93f3b49270b1d2e18bd1399a7a05"),
    "tokenizer_config.json": (998, "aa62b6c06ab8a704dc0895420fb1d2515954a49c"),
}


class PythonSocketGuard:
    """Block outbound non-loopback Python socket use, not native or OS calls."""
    def __init__(self):
        self.denied = 0
        self.lock = threading.Lock()

    def deny(self):
        with self.lock:
            self.denied += 1
        raise PermissionError("outbound network denied by Python socket guard")

    def is_loopback(self, host):
        try:
            if isinstance(host, bytes):
                host = host.decode("ascii")
            ip = ipaddress.ip_address(host)
            return ip.is_loopback or bool(getattr(ip, "ipv4_mapped", None) and ip.ipv4_mapped.is_loopback)
        except (ValueError, TypeError, UnicodeError):
            return False

    def check_address(self, family, address):
        if family == getattr(socket, "AF_UNIX", None):
            return
        if family not in (socket.AF_INET, socket.AF_INET6) or not isinstance(address, tuple) or not address or not self.is_loopback(address[0]):
            self.deny()

    def install(self):
        original_connect, original_connect_ex = socket.socket.connect, socket.socket.connect_ex
        original_sendto = socket.socket.sendto
        original_sendmsg = getattr(socket.socket, "sendmsg", None)
        original_getaddrinfo = socket.getaddrinfo
        original_getnameinfo = socket.getnameinfo
        guard = self

        def connect(sock, address):
            guard.check_address(sock.family, address)
            return original_connect(sock, address)

        def connect_ex(sock, address):
            guard.check_address(sock.family, address)
            return original_connect_ex(sock, address)

        def sendto(sock, *args):
            guard.check_address(sock.family, args[-1])
            return original_sendto(sock, *args)

        def sendmsg(sock, *args, **kwargs):
            address = args[3] if len(args) >= 4 else kwargs.get("address")
            if address is not None:
                guard.check_address(sock.family, address)
            return original_sendmsg(sock, *args, **kwargs)

        def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
            if host is None:
                guard.deny()
            local_name = host in ("localhost", b"localhost")
            if not local_name and not guard.is_loopback(host):
                guard.deny()
            if local_name:
                host = "::1" if family == socket.AF_INET6 else "127.0.0.1"
            rows = original_getaddrinfo(host, port, family, type, proto, flags | socket.AI_NUMERICHOST)
            if any(not guard.is_loopback(row[4][0]) for row in rows):
                guard.deny()
            return rows

        def gethostbyname(host):
            if host not in ("localhost", b"localhost") and not guard.is_loopback(host):
                guard.deny()
            return "127.0.0.1" if host in ("localhost", b"localhost") else (host.decode("ascii") if isinstance(host, bytes) else str(host))

        def gethostbyname_ex(host):
            if host not in ("localhost", b"localhost") and not guard.is_loopback(host):
                guard.deny()
            address = "127.0.0.1" if host in ("localhost", b"localhost") else (host.decode("ascii") if isinstance(host, bytes) else str(host))
            return ("localhost", [], [address])

        def gethostbyaddr(host):
            if not guard.is_loopback(host):
                guard.deny()
            return ("localhost", [], [host.decode("ascii") if isinstance(host, bytes) else host])

        def getnameinfo(address, flags):
            guard.check_address(socket.AF_INET6 if len(address) == 4 else socket.AF_INET, address)
            return original_getnameinfo(address, flags | socket.NI_NUMERICHOST | socket.NI_NUMERICSERV)

        socket.socket.connect, socket.socket.connect_ex = connect, connect_ex
        socket.socket.sendto = sendto
        if original_sendmsg:
            socket.socket.sendmsg = sendmsg
        socket.getaddrinfo = getaddrinfo
        socket.gethostbyname, socket.gethostbyname_ex = gethostbyname, gethostbyname_ex
        socket.gethostbyaddr, socket.getnameinfo = gethostbyaddr, getnameinfo

    def report(self):
        with self.lock:
            return {"scope": "Python socket DNS and outbound connections/datagrams; loopback and Unix sockets allowed; native calls not covered", "denied": self.denied}


def verify_model(data, backend="transformers"):
    base = data / "local-asr"
    manifest_name = "model-manifest.gguf.json" if backend == "gguf" else "model-manifest.json"
    manifest = json.loads((base / manifest_name).read_text(encoding="utf-8"))
    repo = GGUF_REPO if backend == "gguf" else REPO
    revision = GGUF_REVISION if backend == "gguf" else REVISION
    expected = {GGUF_FILE: (1517290464, GGUF_SHA)} if backend == "gguf" else EXPECTED
    configured = os.environ.get("WEREWOLF_ASR_MODEL_DIR")
    if not configured and os.name == "nt":
        configured = "D:/QWEN/Qwen3-ASR-1.7B-Q5_K_M" if backend == "gguf" else "D:/QWEN/Qwen3-ASR-0.6B-hf"
    if not configured or not Path(configured).is_absolute():
        raise ValueError("WEREWOLF_ASR_MODEL_DIR must be an absolute model directory")
    model = Path(configured).resolve()
    if (manifest.get("format"), manifest.get("version"), manifest.get("repo"), manifest.get("revision")) != ("werewolf-local-asr-model", 1, repo, revision):
        raise ValueError("model manifest identity mismatch")
    if not Path(manifest["directory"]).is_absolute() or Path(manifest["directory"]).resolve() != model:
        raise ValueError("model manifest directory mismatch")
    files = manifest.get("files")
    if not isinstance(files, list) or len(files) != len(expected) or {x.get("file") for x in files} != set(expected):
        raise ValueError("model manifest files mismatch")
    for entry in files:
        name = entry["file"]
        size, known = expected[name]
        path = model / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != size or entry.get("bytes") != size:
            raise ValueError("missing or incorrect model file: " + name)
        sha = hashlib.sha256()
        git = hashlib.sha1(f"blob {size}\0".encode())
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                sha.update(chunk)
                if len(known) == 40:
                    git.update(chunk)
        digest = sha.hexdigest()
        if digest != entry.get("sha256") or (digest if len(known) == 64 else git.hexdigest()) != known:
            raise ValueError("model checksum mismatch: " + name)
    return model


class RealBackend:
    def __init__(self, data, device):
        model_path = verify_model(data)
        import torch
        import transformers
        # This audio-only pipeline consumes decoded arrays. Avoid importing incompatible,
        # unused torchaudio/torchvision native extensions in this process only.
        import transformers.utils as tu
        import transformers.utils.import_utils as tiu
        tu.is_torchaudio_available = tiu.is_torchaudio_available = lambda: False
        tu.is_torchvision_available = tiu.is_torchvision_available = lambda: False
        from transformers import AutoModelForMultimodalLM, AutoProcessor
        if device == "cuda:0":
            if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
                raise RuntimeError("cuda:0 with BF16 support is required")
            dtype = torch.bfloat16
        elif device == "cpu":
            dtype = torch.float32
        else:
            raise ValueError("device must be cuda:0 or cpu")
        self.torch, self.device, self.dtype = torch, device, dtype
        self.processor = AutoProcessor.from_pretrained(str(model_path), local_files_only=True)
        self.model = AutoModelForMultimodalLM.from_pretrained(
            str(model_path), local_files_only=True, dtype=dtype, attn_implementation="sdpa"
        ).to(device).eval()
        self.versions = {"python": sys.version.split()[0], "torch": torch.__version__, "transformers": transformers.__version__}
        self.model_info = {"repo": REPO, "revision": REVISION, "backend": "transformers"}
        self.runtime_info = {"deviceName": torch.cuda.get_device_name(device) if device.startswith("cuda") else "CPU", "deviceType": "gpu" if device.startswith("cuda") else "cpu"}

    def transcribe(self, audio, language):
        torch = self.torch
        inputs = self.processor.apply_transcription_request(audio=audio, language=None if language == "auto" else language).to(self.device, self.dtype)
        start = time.perf_counter()
        if self.device.startswith("cuda"):
            torch.cuda.reset_peak_memory_stats(self.device)
        with torch.inference_mode():
            result = self.model.generate(**inputs, max_new_tokens=MAX_TOKENS, max_time=110, do_sample=False)
        if self.device.startswith("cuda"):
            torch.cuda.synchronize(self.device)
        inference = time.perf_counter() - start
        generated = result[:, inputs["input_ids"].shape[1]:]
        raw = self.processor.decode(generated)[0]
        parsed = self.processor.decode(generated, return_format="parsed")[0]
        # Forced-language output has the language in the prompt, not generated tokens.
        if language != "auto":
            parsed = {"language": None, "transcription": self.processor.decode(generated, return_format="transcription_only")[0]}
        ids = generated[0]
        eos = self.model.generation_config.eos_token_id
        eos_ids = set(eos if isinstance(eos, list) else [eos])
        ended = len(ids) > 0 and int(ids[-1]) in eos_ids
        truncated = not ended
        peak = torch.cuda.max_memory_allocated(self.device) if self.device.startswith("cuda") else None
        return raw, parsed, truncated, inference, peak


def verify_gguf_runtime():
    bindings = Path(os.environ.get("WEREWOLF_ASR_BINDINGS_DIR", "D:/QWEN/runtime/transcribe-cpp-0.4.1/python"))
    library = Path(os.environ.get("TRANSCRIBE_LIBRARY", "D:/QWEN/runtime/transcribe-cpp-0.4.1/native/transcribe-native-windows-x86_64-cpu-vulkan/transcribe.dll"))
    if not bindings.is_absolute() or not library.is_absolute():
        raise ValueError("GGUF bindings and library paths must be absolute")
    bindings, library = bindings.resolve(), library.resolve()
    root = bindings.parent
    manifest_bytes = (root / "runtime-manifest.json").read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != RUNTIME_MANIFEST_SHA:
        raise ValueError("GGUF runtime manifest checksum mismatch")
    manifest = json.loads(manifest_bytes)
    if manifest.get("release") != "v0.4.1" or library != (root / "native/transcribe-native-windows-x86_64-cpu-vulkan/transcribe.dll").resolve():
        raise ValueError("GGUF runtime location mismatch")
    for entry in manifest["files"]:
        path = root / entry["file"]
        if path.is_symlink() or not path.is_file() or path.stat().st_size != entry["bytes"]:
            raise ValueError("missing or incorrect GGUF runtime file")
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("GGUF runtime file checksum mismatch")
    expected_dlls = {Path(e["file"]).name.lower() for e in manifest["files"] if e["file"].endswith(".dll")}
    if {p.name.lower() for p in library.parent.glob("*.dll")} != expected_dlls:
        raise ValueError("unexpected GGUF runtime DLL")
    expected_py = {Path(e["file"]).name for e in manifest["files"] if e["file"].startswith("python/transcribe_cpp/") and e["file"].endswith(".py")}
    if {p.name for p in (bindings / "transcribe_cpp").glob("*.py")} != expected_py:
        raise ValueError("unexpected GGUF binding module")
    return bindings, library


class GgufBackend:
    def __init__(self, data, device):
        model_path = verify_model(data, "gguf") / GGUF_FILE
        bindings, library = verify_gguf_runtime()
        os.environ["TRANSCRIBE_LIBRARY"] = str(library)
        sys.path.insert(0, str(bindings))
        import transcribe_cpp as tc
        tc.set_log_callback(None)
        if device == "cpu":
            kind, wanted = "cpu", lambda d: d.kind == "cpu" and d.device_type == "cpu"
        else:
            kind = "vulkan"
            wanted = lambda d: d.kind == "vulkan" and d.device_type == "gpu" and "nvidia" in (d.name + d.description).lower() and "5060" in (d.name + d.description).lower()
        matches = [d for d in tc.backends() if wanted(d)]
        if len(matches) != 1:
            raise RuntimeError("requested GGUF compute device is missing or ambiguous")
        self.tc = tc
        self.model = tc.Model(str(model_path), backend=kind, device=matches[0])
        try:
            selected = self.model.device
            reported_backend = self.model.backend
            requested = matches[0]
            same_device = (selected.kind, selected.device_type, selected.name, selected.description) == (requested.kind, requested.device_type, requested.name, requested.description)
            if selected.device_id is not None and requested.device_id is not None:
                same_device = same_device and selected.device_id == requested.device_id
            backend_matches = reported_backend.lower() in (kind, selected.name.lower())
            if not backend_matches or not wanted(selected) or not same_device:
                raise RuntimeError(f"GGUF selected-device mismatch (backend={reported_backend}, kind={selected.kind}, type={selected.device_type}, name={selected.name}, description={selected.description})")
            self.device = kind
            self.dtype = "Q5_K_M"
            self.versions = {"python": sys.version.split()[0], "transcribe_cpp": tc.__version__, "native": tc.native_version(), "nativeCommit": tc.native_commit()}
            self.model_info = {"repo": GGUF_REPO, "revision": GGUF_REVISION, "backend": "gguf", "file": GGUF_FILE,
                               "sha256": GGUF_SHA, "arch": self.model.arch, "variant": self.model.variant}
            self.runtime_info = {"backend": kind, "reportedBackend": reported_backend, "deviceName": selected.name, "deviceDescription": selected.description,
                                 "deviceType": selected.device_type, "deviceId": selected.device_id,
                                 "runtimeManifestSha256": RUNTIME_MANIFEST_SHA}
        except Exception:
            self.model.close()
            raise

    def transcribe(self, audio, language):
        import numpy as np
        start = time.perf_counter()
        truncated = None
        with self.model.session() as session:
            timer = threading.Timer(110, session.cancel)
            timer.daemon = True
            timer.start()
            try:
                try:
                    result = session.run(np.ascontiguousarray(audio, dtype=np.float32), language=None if language == "auto" else language, timestamps="none")
                except self.tc.OutputTruncated as error:
                    result = error.partial_result
                    truncated = True
                except self.tc.Aborted as error:
                    raise InferenceTimeout("GGUF inference timed out") from error
            finally:
                timer.cancel()
        parsed = {"language": (result.language or None) if language == "auto" else None, "transcription": result.text}
        return result.raw_text, parsed, truncated, time.perf_counter() - start, None

    def close(self):
        self.model.close()


class InferenceTimeout(Exception):
    pass


class FakeBackend:
    device = "test"
    dtype = "test"
    versions = {"python": sys.version.split()[0], "backend": "explicit-test-only"}
    model_info = {"repo": REPO, "revision": REVISION, "backend": "test"}
    runtime_info = {}

    def transcribe(self, audio, language):
        time.sleep(0.35)
        return "language English<asr_text>test", {"language": "English", "transcription": "test"}, True, 0.35, None


def decode_audio(body):
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    with sf.SoundFile(io.BytesIO(body)) as f:
        if f.format not in ("WAV", "WAVEX") or f.frames <= 0 or not 8000 <= f.samplerate <= 192000 or f.channels < 1 or f.channels > 8:
            raise ValueError("expected a nonempty WAV with at most eight channels")
        if f.frames / f.samplerate > MAX_SECONDS or f.frames * f.channels * 4 > 128 * 1024 * 1024:
            raise ValueError("audio exceeds 120 seconds")
        sample_rate, channels, frames, subtype = f.samplerate, f.channels, f.frames, f.subtype
        samples = f.read(dtype="float32", always_2d=True)
        if len(samples) != frames or not np.isfinite(samples).all():
            raise ValueError("invalid or incomplete WAV")
    samples = samples.mean(axis=1, dtype=np.float32)
    if sample_rate != 16000:
        divisor = math.gcd(sample_rate, 16000)
        samples = resample_poly(samples, 16000 // divisor, sample_rate // divisor).astype(np.float32)
    samples = np.ascontiguousarray(samples, dtype="<f4")
    return samples, {"sourceSampleRate": sample_rate, "sourceChannels": channels, "sourceFrames": frames,
                     "sourceSubtype": subtype, "durationSeconds": frames / sample_rate, "sampleRate": 16000,
                     "channels": 1, "format": "float32-le", "resample": "scipy.signal.resample_poly" if sample_rate != 16000 else "none",
                     "sha256": hashlib.sha256(samples.tobytes()).hexdigest()}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--device", choices=["cuda:0", "gpu", "cpu"])
    parser.add_argument("--backend", choices=["transformers", "gguf"], default="transformers")
    parser.add_argument("--test-backend", action="store_true")
    args = parser.parse_args()
    args.device = args.device or ("gpu" if args.backend == "gguf" else "cuda:0")
    if args.device not in (("gpu", "cpu") if args.backend == "gguf" else ("cuda:0", "cpu")):
        parser.error("device is incompatible with selected backend")
    data = Path(args.data_dir).resolve()
    root = data / "local-asr"
    config = json.loads((root / "service-control.json").read_text(encoding="utf-8"))
    if args.test_backend and (root / "TEST-ONLY").read_text(encoding="utf-8") != "isolated test backend\n":
        raise RuntimeError("test backend requires isolated test marker")
    state = {"status": "loading", "error": None, "backend": None, "loadSeconds": None}
    lock = threading.Lock()
    started = time.perf_counter()
    offline_guard = PythonSocketGuard()
    offline_guard.install()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def response(self, code, payload):
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(encoded)
            self.close_connection = True

        def authorized(self):
            return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + config["token"])

        def do_GET(self):
            if not self.authorized():
                return self.response(401, {"error": "unauthorized"})
            if self.path != "/health":
                return self.response(404, {"error": "not found"})
            backend = state["backend"]
            self.response(200, {"status": state["status"], "error": state["error"], "pid": os.getpid(), "nonce": config["nonce"], "loadSeconds": state["loadSeconds"], "backend": "test" if args.test_backend else args.backend,
                "model": backend.model_info if backend else None,
                "runtime": {"device": backend.device, "dtype": str(backend.dtype), **backend.runtime_info, "versions": backend.versions} if backend else None,
                "offlineGuard": offline_guard.report()})

        def do_POST(self):
            if not self.authorized():
                return self.response(401, {"error": "unauthorized"})
            if self.path == "/shutdown":
                self.response(200, {"status": "stopping", "pid": os.getpid(), "nonce": config["nonce"]})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if self.path != "/v1/transcribe":
                return self.response(404, {"error": "not found"})
            if state["status"] != "ready":
                return self.response(503, {"error": "model not ready"})
            if self.headers.get("Content-Type", "").lower() not in ("audio/wav", "application/octet-stream") or self.headers.get("Transfer-Encoding"):
                return self.response(415, {"error": "WAV bytes required"})
            if any(name.lower().startswith("x-") and name.lower() != "x-asr-language" for name in self.headers):
                return self.response(400, {"error": "unsupported request field"})
            language = self.headers.get("X-ASR-Language", "auto")
            if language not in ("auto", "zh", "en", "ja"):
                return self.response(400, {"error": "unsupported language"})
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self.response(400, {"error": "content length required"})
            if length <= 0 or length > LIMIT:
                return self.response(413, {"error": "WAV must be 1 to 16777216 bytes"})
            if not lock.acquire(blocking=False):
                return self.response(429, {"error": "busy"})
            request_id = uuid.uuid4().hex
            begin = time.perf_counter()
            digest = None
            status = 500
            try:
                deadline = time.monotonic() + 15
                chunks, remaining = [], length
                while remaining:
                    timeout = deadline - time.monotonic()
                    if timeout <= 0:
                        raise socket.timeout("request body timeout")
                    self.connection.settimeout(timeout)
                    chunk = self.rfile.read1(min(remaining, 65536))
                    if not chunk:
                        raise ValueError("incomplete request")
                    chunks.append(chunk)
                    remaining -= len(chunk)
                body = b"".join(chunks)
                digest = hashlib.sha256(body).hexdigest()
                try:
                    samples, conversion = decode_audio(body)
                except (ValueError, RuntimeError, OSError) as error:
                    raise ValueError("invalid WAV") from error
                import psutil
                import numpy
                import scipy
                import soundfile
                proc = psutil.Process()
                cpu_before = proc.cpu_times()
                peak_ram = [proc.memory_info().rss]
                finished = threading.Event()
                def sample_memory():
                    while not finished.wait(0.05):
                        peak_ram[0] = max(peak_ram[0], proc.memory_info().rss)
                sampler = threading.Thread(target=sample_memory, daemon=True)
                sampler.start()
                try:
                    raw, parsed, truncated, infer, gpu_peak = state["backend"].transcribe(samples, language)
                finally:
                    finished.set()
                    sampler.join()
                peak_ram[0] = max(peak_ram[0], proc.memory_info().rss)
                cpu_after = proc.cpu_times()
                backend = state["backend"]
                status = 200
                self.response(status, {"requestId": request_id, "transcription": parsed["transcription"], "language": parsed["language"],
                    "requestedLanguage": language, "rawDecode": raw, "truncated": truncated, "audioSha256": digest,
                    "inputAudio": conversion, "model": backend.model_info,
                    "runtime": {"device": backend.device, "dtype": str(backend.dtype), **backend.runtime_info, "offlineGuard": offline_guard.report(), "versions": {**backend.versions, "numpy": numpy.__version__, "scipy": scipy.__version__, "soundfile": soundfile.__version__, "psutil": psutil.__version__}},
                    "performance": {"loadSeconds": state["loadSeconds"], "processingSeconds": time.perf_counter() - begin, "inferenceSeconds": infer,
                        "processCpuSeconds": (cpu_after.user + cpu_after.system) - (cpu_before.user + cpu_before.system),
                        "processRssPeakBytesSampled": peak_ram[0], "cudaAllocatedPeakBytes": gpu_peak}})
            except Exception as error:
                status = 504 if isinstance(error, InferenceTimeout) else (400 if isinstance(error, (ValueError, socket.timeout)) else 500)
                self.response(status, {"error": "invalid audio or request" if status == 400 else ("inference timed out" if status == 504 else "transcription failed"), "requestId": request_id})
            finally:
                print(json.dumps({"requestId": request_id, "sha256": digest, "length": length, "status": status, "processingSeconds": time.perf_counter() - begin}), flush=True)
                lock.release()

    server = Server(("127.0.0.1", args.port), Handler)
    def load():
        try:
            state["backend"] = FakeBackend() if args.test_backend else (GgufBackend(data, args.device) if args.backend == "gguf" else RealBackend(data, args.device))
            state["loadSeconds"] = time.perf_counter() - started
            state["status"] = "ready"
        except Exception as error:
            state["error"] = f"{type(error).__name__}: {error}"
            state["status"] = "failed"
    threading.Thread(target=load, daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        backend = state["backend"]
        if backend is not None and hasattr(backend, "close"):
            backend.close()


if __name__ == "__main__":
    main()
