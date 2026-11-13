"""Hardware and power-state probe used to pick ASR settings automatically.

Static facts (chip, cores, memory, compute devices) are probed once per process.
Power/thermal state is cheap to re-read and is polled by the runtime governor.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import subprocess
from dataclasses import asdict, dataclass, field
from urllib.parse import urlparse

import llm_provider
import transcribe_cpp


def _run(*cmd: str) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=2).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


@dataclass
class ComputeDevice:
    kind: str          # metal | cuda | vulkan | rocm | cpu
    name: str
    memory_gb: float


@dataclass
class HardwareInfo:
    os: str
    arch: str
    chip: str
    perf_cores: int
    total_cores: int
    memory_gb: float
    devices: list[ComputeDevice] = field(default_factory=list)
    engine_version: str = ""

    @property
    def gpu(self) -> ComputeDevice | None:
        return next((d for d in self.devices if d.kind != "cpu"), None)

    def fingerprint(self) -> str:
        """Calibration cache key: changes when hardware or the inference engine changes."""
        key = json.dumps([self.chip, self.total_cores, round(self.memory_gb),
                          [(d.kind, d.name) for d in self.devices], self.engine_version])
        return hashlib.sha1(key.encode()).hexdigest()[:16]

    def to_json(self) -> dict:
        return {**asdict(self), "gpu": asdict(self.gpu) if self.gpu else None}


@dataclass
class PowerState:
    on_battery: bool = False
    low_power_mode: bool = False
    thermal_pressure: bool = False   # OS reports throttling / thermal warning

    @property
    def constrained(self) -> bool:
        return self.low_power_mode or self.thermal_pressure


def probe_hardware() -> HardwareInfo:
    system = platform.system()
    chip, perf, total, mem = platform.processor() or platform.machine(), 0, os.cpu_count() or 1, 0.0
    if system == "Darwin":
        chip = _run("sysctl", "-n", "machdep.cpu.brand_string") or chip
        perf = int(_run("sysctl", "-n", "hw.perflevel0.physicalcpu") or 0)
        mem = int(_run("sysctl", "-n", "hw.memsize") or 0) / 2**30
    elif system == "Linux":
        try:
            info = open("/proc/cpuinfo").read()
            m = re.search(r"model name\s*:\s*(.+)", info)
            chip = m.group(1) if m else chip
            mem = int(re.search(r"MemTotal:\s+(\d+)", open("/proc/meminfo").read()).group(1)) / 2**20
        except Exception:  # noqa: BLE001
            pass
    elif system == "Windows":
        try:
            import psutil  # optional
            mem = psutil.virtual_memory().total / 2**30
            perf = psutil.cpu_count(logical=False) or 0
        except ImportError:
            pass
    devices = []
    try:
        for d in transcribe_cpp.backends():
            devices.append(ComputeDevice(d.kind, d.description or d.name, round((d.memory_total or 0) / 2**30, 1)))
    except Exception:  # noqa: BLE001
        devices.append(ComputeDevice("cpu", chip, mem))
    return HardwareInfo(system, platform.machine(), chip, perf or total, total, round(mem, 1), devices,
                        getattr(transcribe_cpp, "__version__", ""))


def read_power_state() -> PowerState:
    system = platform.system()
    st = PowerState()
    if system == "Darwin":
        st.on_battery = "Battery Power" in _run("pmset", "-g", "batt")
        st.low_power_mode = bool(re.search(r"lowpowermode\s+1", _run("pmset", "-g")))
        therm = _run("pmset", "-g", "therm")
        st.thermal_pressure = bool(re.search(r"(CPU_Speed_Limit\s*=\s*([0-8]?\d)\b|warning level\s*=\s*[1-9])", therm))
    elif system == "Linux":
        try:
            for ps in os.listdir("/sys/class/power_supply"):
                p = f"/sys/class/power_supply/{ps}/online"
                if ps.startswith(("AC", "ADP")) and os.path.exists(p):
                    st.on_battery = open(p).read().strip() == "0"
        except Exception:  # noqa: BLE001
            pass
    elif system == "Windows":
        try:
            import psutil
            b = psutil.sensors_battery()
            st.on_battery = bool(b and not b.power_plugged)
        except ImportError:
            pass
    return st


def llm_is_local(llm_api_url: str) -> bool:
    """Shares this Mac's GPU (0.0.0.0 also connects to this machine)."""
    host = (urlparse(llm_api_url).hostname or "").lower()
    return host == "0.0.0.0" or llm_provider.is_loopback_host(host)
