"""Synthesizes the trailer soundtrack (pads, pops, blips) to assets/soundtrack.wav.

Timings mirror the timeline in trailer.html. Run: python3 trailer/soundtrack.py
"""
import wave
from pathlib import Path

import numpy as np

SR = 48_000
DUR = 36.0
t = np.arange(int(SR * DUR)) / SR
mix = np.zeros_like(t)


def hz(note: str) -> float:
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    name, octave = note[:-1], int(note[-1])
    return 440.0 * 2 ** ((names[name] + 12 * (octave + 1) - 69) / 12)


def envelope(start: float, end: float, attack: float, release: float) -> np.ndarray:
    env = np.clip((t - start) / attack, 0, 1) * np.clip((end - t) / release, 0, 1)
    return env * ((t >= start) & (t <= end))


# Warm pad: detuned sines + a soft octave, one chord per scene.
CHORDS = [
    (0.0, 8.6, ["A2", "E3", "A3", "C4", "E4"]),
    (8.2, 13.0, ["F2", "C3", "F3", "A3", "E4"]),
    (12.6, 18.2, ["C3", "G3", "C4", "E4", "G4"]),
    (17.8, 23.4, ["G2", "D3", "G3", "B3", "D4"]),
    (23.0, 28.6, ["A2", "E3", "A3", "C4", "E4"]),
    (28.2, 31.8, ["F2", "C3", "F3", "A3", "C4"]),
    (31.4, 36.0, ["C3", "G3", "C4", "E4", "G4", "D5"]),
]
for start, end, notes in CHORDS:
    env = envelope(start, end, 1.2, 1.4)
    for i, note in enumerate(notes):
        f = hz(note)
        voice = sum(np.sin(2 * np.pi * f * d * t + i) for d in (0.997, 1.0, 1.003)) / 3
        voice += 0.25 * np.sin(2 * np.pi * f * 2 * t)
        mix += 0.05 * env * voice * (1 + 0.15 * np.sin(2 * np.pi * 0.2 * t + i))

# A slow sub pulse that builds under the chat scene.
pulse = np.sin(2 * np.pi * hz("C2") * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 1.0 * t)) ** 2
mix += 0.05 * pulse * envelope(9.0, 23.0, 2.0, 1.0)


def pluck(at: float, note: str, gain: float = 0.22, decay: float = 7.0, length: float = 1.2) -> None:
    f = hz(note)
    i0 = int(at * SR)
    n = min(int(length * SR), len(t) - i0)
    tt = np.arange(n) / SR
    tone = np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(2 * np.pi * f * 2 * tt) + 0.12 * np.sin(2 * np.pi * f * 3 * tt)
    attack = np.clip(tt / 0.004, 0, 1)
    mix[i0 : i0 + n] += gain * tone * attack * np.exp(-decay * tt)


def pop(at: float, note: str) -> None:
    """A bubbly 'bloop': pitch glides up quickly."""
    i0 = int(at * SR)
    n = min(int(0.35 * SR), len(t) - i0)
    tt = np.arange(n) / SR
    f0 = hz(note)
    freq = f0 * (0.6 + 0.4 * np.clip(tt / 0.05, 0, 1))
    phase = 2 * np.pi * np.cumsum(freq) / SR
    mix[i0 : i0 + n] += 0.22 * np.sin(phase) * np.exp(-12 * tt) * np.clip(tt / 0.003, 0, 1)


def tick(at: float) -> None:
    i0 = int(at * SR)
    n = int(0.03 * SR)
    rng = np.random.default_rng(int(at * 1000))
    noise = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 180)
    mix[i0 : i0 + n] += 0.035 * np.convolve(noise, np.ones(6) / 6, mode="same")


pop(0.5, "E5")                                         # alice appears
for i, k in enumerate(np.linspace(4.9, 6.5, 22)):        # typing the address
    tick(float(k) + (0.02 if i % 3 == 0 else 0))
pluck(6.8, "E5"); pluck(6.95, "A5", gain=0.18)          # verified
pluck(9.0, "C5", gain=0.14, decay=6)                    # a post lands
for at, note in [(10.9, "E5"), (11.4, "G5"), (11.9, "A5"), (12.4, "C6")]:
    pop(at, note)                                       # reactions
for at, note in [(14.7, "G5"), (15.9, "E5"), (17.0, "A5")]:
    pluck(at, note, gain=0.15, decay=9)                 # comments
    pluck(at + 0.07, note[:-1] + str(int(note[-1]) + 1), gain=0.05, decay=12)
for k in np.linspace(17.95, 18.5, 8):                   # swipe to the profile
    tick(float(k))
for i, k in enumerate(np.linspace(18.6, 20.2, 12)):     # stats counting up
    tick(float(k))
for at, note in [(19.6, "C5"), (20.1, "E5"), (20.6, "G5"), (21.1, "C6")]:
    pop(at, note)                                       # friends
for at in (24.0, 24.9, 25.8):                           # alerts
    pluck(at, "E6", gain=0.12, decay=6); pluck(at + 0.09, "B5", gain=0.10, decay=6)
for at, note in [(28.6, "A4"), (29.4, "E5")]:
    pluck(at, note, gain=0.14, decay=4)

# Logo hit: low boom + bright chord.
i0 = int(32.2 * SR)
tt = np.arange(len(t) - i0) / SR
boom = np.sin(2 * np.pi * (55 + 40 * np.exp(-tt * 18)) * tt) * np.exp(-tt * 2.4)
mix[i0:] += 0.45 * boom
for note in ["C5", "E5", "G5", "C6"]:
    pluck(32.2, note, gain=0.09, decay=1.2, length=3.6)

# Soft room: a few short echoes.
for delay, g in [(0.11, 0.25), (0.23, 0.15), (0.37, 0.08)]:
    d = int(delay * SR)
    mix[d:] += g * mix[:-d].copy()

mix *= np.clip(t / 0.4, 0, 1) * np.clip((DUR - t) / 1.2, 0, 1)
mix = np.tanh(mix * 1.4)
mix *= 0.89 / np.max(np.abs(mix))
stereo = np.stack([mix, np.roll(mix, int(0.012 * SR))], axis=1)

out = Path(__file__).parent / "assets" / "soundtrack.wav"
with wave.open(str(out), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype("<i2").tobytes())
print("wrote", out)
