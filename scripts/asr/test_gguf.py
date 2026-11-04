"""Isolated contract flows. No native library or model is loaded."""
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

sys.dont_write_bytecode = True
import server


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
        self.model.calls.append((self, options))
        result = SimpleNamespace(text="hello", raw_text="language English<asr_text>hello", language="English")
        if self.model.failure == "truncated":
            error = NativeTruncated()
            error.partial_result = result
            raise error
        if self.model.failure == "aborted":
            raise NativeAborted()
        return result


class FakeModel:
    def __init__(self, device):
        self.device = SimpleNamespace(**vars(device), memory_free=100)
        self.backend = device.name
        self.arch, self.variant = "qwen3asr", "1.7B Q8_0"
        self.calls, self.failure, self.closed = [], None, False

    def session(self):
        return FakeSession(self)

    def close(self):
        self.closed = True


class GgufContract(unittest.TestCase):
    def test_selects_discrete_gpu_and_isolates_success_partial_result_and_timeout(self):
        cpu = SimpleNamespace(kind="cpu", device_type="cpu", name="CPU", description="CPU", device_id=None)
        integrated = SimpleNamespace(kind="vulkan", device_type="igpu", name="Vulkan0", description="Intel UHD 770", device_id="0")
        gpu = SimpleNamespace(kind="vulkan", device_type="gpu", name="Vulkan1", description="NVIDIA GeForce RTX 5060 Laptop GPU", device_id="1")
        models = []

        def load_model(_path, *, backend, device):
            self.assertEqual(backend, "vulkan")
            self.assertIs(device, gpu)
            model = FakeModel(device)
            if models:
                model.device.description = "Other GPU"
            models.append(model)
            return model

        native = SimpleNamespace(
            __version__="0.4.1", native_version=lambda: "0.4.1", native_commit=lambda: "test",
            backends=lambda: [integrated, gpu, cpu], Model=load_model, set_log_callback=lambda _: None,
            OutputTruncated=NativeTruncated, Aborted=NativeAborted,
        )
        with (
            patch.dict(sys.modules, {"transcribe_cpp": native}),
            patch.dict(os.environ),
            patch.object(sys, "path", sys.path.copy()),
            patch.object(server, "verify_model", return_value=Path("/model")),
            patch.object(server, "verify_gguf_runtime", return_value=(Path("/bindings"), Path("/native/transcribe.dll"))),
        ):
            backend = server.GgufBackend(Path("/data"), "gpu")
            self.addCleanup(backend.close)
            self.assertEqual(backend.runtime_info["reportedBackend"], "Vulkan1")
            audio = np.zeros(16000, dtype=np.float32)
            self.assertEqual(backend.transcribe(audio, "auto")[:3], (
                "language English<asr_text>hello", {"language": "English", "transcription": "hello"}, None,
            ))

            backend.model.failure = "truncated"
            self.assertEqual(backend.transcribe(audio, "ja")[1:3], ({"language": None, "transcription": "hello"}, True))
            backend.model.failure = "aborted"
            with self.assertRaises(server.InferenceTimeout):
                backend.transcribe(audio, "auto")

            self.assertEqual(len({session for session, _ in backend.model.calls}), 3)
            self.assertEqual([options for _, options in backend.model.calls], [
                {"language": None, "timestamps": "none"},
                {"language": "ja", "timestamps": "none"},
                {"language": None, "timestamps": "none"},
            ])
            with self.assertRaisesRegex(RuntimeError, "selected-device mismatch"):
                server.GgufBackend(Path("/data"), "gpu")
            self.assertTrue(models[-1].closed)


class SocketGuardContract(unittest.TestCase):
    def test_offline_guard_rejects_dns_and_outbound_sockets_but_allows_loopback_resolution(self):
        def resolve_loopback(host, *args):
            self.assertEqual(host, "127.0.0.1")
            return socket.getaddrinfo(host, *args)

        def reject_resolver_call(_host):
            self.fail("outbound name reached the underlying resolver")

        class TestSocket(socket.socket):
            def connect(self, _address):
                raise AssertionError("outbound connection reached the underlying socket")

            def sendto(self, *_args):
                raise AssertionError("outbound datagram reached the underlying socket")

        # Install on a private module-shaped copy so no global socket state escapes this test.
        socket_module = SimpleNamespace(**{**vars(socket), "socket": TestSocket})
        socket_module.getaddrinfo = resolve_loopback
        socket_module.gethostbyname = reject_resolver_call
        guard = server.PythonSocketGuard()
        with patch.object(server, "socket", socket_module):
            guard.install()
            with self.assertRaises(PermissionError):
                socket_module.getaddrinfo("example.com", 443)
            with self.assertRaises(PermissionError):
                socket_module.gethostbyname("example.com")
            with socket_module.socket(socket.AF_INET, socket.SOCK_STREAM) as stream:
                with self.assertRaises(PermissionError):
                    stream.connect(("203.0.113.1", 443))
            with socket_module.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                with self.assertRaises(PermissionError):
                    udp.sendto(b"x", ("203.0.113.1", 53))
            resolved = socket_module.getaddrinfo("localhost", 80)
        self.assertTrue(resolved)
        self.assertEqual({row[4][0] for row in resolved}, {"127.0.0.1"})
        self.assertEqual(guard.report()["denied"], 4)


if __name__ == "__main__":
    unittest.main()
