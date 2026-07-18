#!/usr/bin/env python3
"""
transcribe-fw.py - reference transcription engine (faster-whisper, int8, CPU).

Prints the transcript to stdout and nothing else, so the caller can capture it
with a plain shell redirect. Any diagnostics go to stderr.

Why int8 on CPU instead of fp16 on a GPU:
  whisper.cpp pads every clip to a fixed 30-second window, so a 3-second voice
  note costs the same as a 30-second one. For a workload made almost entirely of
  short notes, most of the time was spent transcribing silence. CTranslate2 runs
  int8 kernels that use the AVX-512 VNNI instructions already present in modern
  server CPUs, and voice-activity detection removes the silence before the model
  ever sees it. Measured on the same audio, same machine: 34.3s -> 4.8s at the
  engine, ~3.2x end to end once model load and format conversion are counted.

Usage:
    transcribe-fw.py <audio-file> [model] [threads]

Defaults: model=large-v3-turbo, threads=4
"""
import sys

from faster_whisper import WhisperModel

MODEL = "large-v3-turbo"
THREADS = 4
LANG = "es"
MIN_SILENCE_MS = 500


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: transcribe-fw.py <audio-file> [model] [threads]\n")
        return 2

    audio = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else MODEL
    threads = int(sys.argv[3]) if len(sys.argv) > 3 else THREADS

    model = WhisperModel(
        model_size,
        device="cpu",
        compute_type="int8",
        cpu_threads=threads,
    )

    segments, _info = model.transcribe(
        audio,
        language=LANG,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=MIN_SILENCE_MS),
    )

    # Join lazily: segments is a generator, transcription happens as we consume it.
    text = " ".join(seg.text for seg in segments).strip()

    # Nothing but the transcript on stdout. An empty result is a valid answer
    # (silence), and the caller decides what that means - see the note on
    # failure handling in the README.
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
