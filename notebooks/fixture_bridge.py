"""Own one synthetic loopback bridge and restore the notebook environment on close."""

from __future__ import annotations

import atexit
import json
import os
import selectors
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen


class FixtureBridge:
    def __init__(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("MOCK_", "HUE_"))}
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("mock_bridge.py"))],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env=env,
        )
        atexit.register(self.close)
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=15):
                self.close()
                raise RuntimeError("Synthetic bridge did not start within 15 seconds")
        line = self.process.stdout.readline().strip()
        if not line.startswith("PORT:"):
            self.close()
            raise RuntimeError("Synthetic bridge did not report its local port")
        self.url = f"http://127.0.0.1:{int(line.split(':')[1])}"
        self.previous = os.environ.get("NOTEBOOK_HUE_BRIDGE")
        os.environ["NOTEBOOK_HUE_BRIDGE"] = self.url

    def writes(self):
        with urlopen(self.url + "/debug/puts", timeout=5) as response:
            return json.load(response)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if hasattr(self, "previous"):
            if self.previous is None:
                os.environ.pop("NOTEBOOK_HUE_BRIDGE", None)
            else:
                os.environ["NOTEBOOK_HUE_BRIDGE"] = self.previous
