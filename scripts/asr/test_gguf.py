"""Isolated contract tests; no native library or model is loaded."""
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

import numpy as np
sys.dont_write_bytecode = True
import server
import socket


class NativeTruncated(Exception):
    pass


class NativeAborted(Exception):
    pass


class FakeSession:
    def __init__(self, model):
        self.model = model

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def cancel(self):
        pass

    def run(self, audio, **options):
        self.model.calls.append((audio, options, self))
        result = SimpleNamespace(text="hello", raw_text="language English<asr_text>hello", language="English")
        if self.model.failure == "truncated":
            error = NativeTruncated()
            error.partial_result = result
            raise error
        if self.model.failure == "aborted":
            raise NativeAborted()
        return result


class FakeModel:
    def __init__(self, path, *, backend, device):
        self.path, self.backend, self.device = path, backend, device
        self.arch, self.variant = "qwen3asr", "1.7B Q8_0"
        self.calls, self.failure = [], None

    def session(self):
        return FakeSession(self)

    def close(self):
        pass


class GgufContract(unittest.TestCase):
    def setUp(self):
        self.cpu = SimpleNamespace(kind="cpu", device_type="cpu", name="CPU", description="CPU", device_id=None)
        self.integrated = SimpleNamespace(kind="vulkan", device_type="igpu", name="Vulkan0", description="Intel UHD 770", device_id="0")
        self.gpu = SimpleNamespace(kind="vulkan", device_type="gpu", name="Vulkan1", description="NVIDIA GeForce RTX 5060 Laptop GPU", device_id="1")
        self.native = SimpleNamespace(__version__="0.4.1", native_version=lambda: "0.4.1", native_commit=lambda: "test", backends=lambda: [self.integrated, self.gpu, self.cpu],
                                      Model=FakeModel, set_log_callback=lambda _: None, OutputTruncated=NativeTruncated, Aborted=NativeAborted)
        self.mock_module = patch.dict(sys.modules, {"transcribe_cpp": self.native})
        self.mock_model = patch.object(server, "verify_model", return_value=Path("/model"))
        self.mock_runtime = patch.object(server, "verify_gguf_runtime", return_value=(Path("/bindings"), Path("/native/transcribe.dll")))
        self.mock_module.start(); self.mock_model.start(); self.mock_runtime.start()
        self.addCleanup(self.mock_module.stop); self.addCleanup(self.mock_model.stop); self.addCleanup(self.mock_runtime.stop)

    def test_selects_discrete_gpu_and_uses_fresh_unprompted_sessions(self):
        backend = server.GgufBackend(Path("/data"), "gpu")
        self.assertIs(backend.model.device, self.gpu)
        self.assertEqual(backend.dtype, "Q8_0")
        self.assertEqual(backend.model_info["file"], "Qwen3-ASR-1.7B-Q8_0.gguf")
        self.assertEqual(backend.model_info["sha256"], "9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7")
        audio = np.zeros(16000, dtype=np.float32)
        first = backend.transcribe(audio, "auto")
        second = backend.transcribe(audio, "ja")
        self.assertEqual(first[:3], ("language English<asr_text>hello", {"language": "English", "transcription": "hello"}, None))
        self.assertIsNone(second[1]["language"])
        self.assertIsNot(backend.model.calls[0][2], backend.model.calls[1][2])
        self.assertEqual(backend.model.calls[0][1], {"language": None, "timestamps": "none"})
        self.assertEqual(backend.model.calls[1][1], {"language": "ja", "timestamps": "none"})
        self.assertNotIn("torch", sys.modules)
        backend.close()

    def test_truncation_timeout_and_missing_gpu_are_explicit(self):
        backend = server.GgufBackend(Path("/data"), "cpu")
        self.assertIs(backend.model.device, self.cpu)
        backend.model.failure = "truncated"
        self.assertTrue(backend.transcribe(np.zeros(1, dtype=np.float32), "auto")[2])
        backend.model.failure = "aborted"
        with self.assertRaises(server.InferenceTimeout):
            backend.transcribe(np.zeros(1, dtype=np.float32), "auto")
        self.native.backends = lambda: [self.integrated, self.cpu]
        with self.assertRaisesRegex(RuntimeError, "missing or ambiguous"):
            server.GgufBackend(Path("/data"), "gpu")

    def test_device_identity_ignores_live_memory_and_checks_reported_backend(self):
        class ChangedSnapshotModel(FakeModel):
            def __init__(self, path, *, backend, device):
                super().__init__(path, backend=backend, device=device)
                self.device = SimpleNamespace(**vars(device), memory_free=100)
                self.backend = device.name
        self.native.Model = ChangedSnapshotModel
        backend = server.GgufBackend(Path("/data"), "gpu")
        self.assertEqual(backend.runtime_info["reportedBackend"], "Vulkan1")
        class WrongModel(ChangedSnapshotModel):
            closed = False
            def __init__(self, path, *, backend, device):
                super().__init__(path, backend=backend, device=device)
                self.device.description = "Other GPU"
            def close(self):
                WrongModel.closed = True
        self.native.Model = WrongModel
        with self.assertRaisesRegex(RuntimeError, "selected-device mismatch"):
            server.GgufBackend(Path("/data"), "gpu")
        self.assertTrue(WrongModel.closed)


class SocketGuardContract(unittest.TestCase):
    def test_dns_and_nonloopback_outbound_are_rejected_before_network(self):
        guard = server.PythonSocketGuard()
        guard.install()
        with self.assertRaises(PermissionError):
            socket.getaddrinfo("example.com", 443)
        with self.assertRaises(PermissionError):
            socket.gethostbyname("example.com")
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as stream:
            with self.assertRaises(PermissionError):
                stream.connect(("203.0.113.1", 443))
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            with self.assertRaises(PermissionError):
                udp.sendto(b"x", ("203.0.113.1", 53))
        self.assertEqual(guard.report()["denied"], 4)
        self.assertTrue(socket.getaddrinfo("127.0.0.1", 80))


if __name__ == "__main__":
    unittest.main()
