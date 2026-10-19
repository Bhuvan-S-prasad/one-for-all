// The engine's Python, written into the runner's work folder when first used
// (ADR-0049), so a computer needs only ffmpeg and the Python packages, not a
// copy of the engine. Bump SCRIPTS_VERSION when a script changes.

export const SCRIPTS_VERSION = 3;

/**
 * Beats, downbeats, energy per beat and sections by energy. Beat This! when
 * it is installed, else librosa. Downbeats from librosa assume 4/4: the
 * phase whose beats are strongest.
 */
export const MUSIC_PY = `import json, os, subprocess, sys, tempfile
import numpy as np


def smooth(values, width):
    if len(values) == 0:
        return values
    kernel = np.ones(width) / width
    padded = np.pad(values, (width // 2, width - 1 - width // 2), mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def main():
    src, out = sys.argv[1], sys.argv[2]
    # The song's real tempo, when the caller knows it: trackers often lock onto 2/3 or
    # 3/2 of it (a 150 BPM song read as 99), which puts every cut off the real beat.
    hint = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None
    ffmpeg = os.environ.get("OFA_VIDEO_FFMPEG", "ffmpeg")
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "audio.wav")
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "22050", wav], check=True)
        tracker = "librosa"
        beats = None
        downbeats = None
        try:
            from beat_this.inference import File2Beats
            b, d = File2Beats(device="cpu", dbn=False)(wav)
            beats = [float(x) for x in b]
            downbeats = [float(x) for x in d]
            tracker = "beat_this"
        except Exception:
            pass
        import librosa
        y, sr = librosa.load(wav, sr=22050, mono=True)
    duration = float(len(y)) / sr
    hop = 512
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    if beats is None:
        _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=hop, bpm=hint)
        tracker = "librosa" if hint is None else "librosa, tempo given"
        beats = [float(t) for t in librosa.frames_to_time(frames, sr=sr, hop_length=hop)]
    beats = sorted(t for t in beats if 0 <= t < duration)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    edges = beats + [duration]
    energy = []
    strength = []
    for i, start in enumerate(beats):
        mask = (times >= start) & (times < edges[i + 1])
        energy.append(float(rms[mask].mean()) if mask.any() else 0.0)
        k = min(len(onset) - 1, int(round(start * sr / hop)))
        strength.append(float(onset[k]) if k >= 0 else 0.0)
    energy = np.array(energy)
    if len(energy) and energy.max() > 0:
        energy = energy / energy.max()
    if downbeats is None:
        downbeats = []
        if beats:
            scores = [sum(strength[i] for i in range(p, len(beats), 4)) / max(1, len(range(p, len(beats), 4))) for p in range(4)]
            phase = int(np.argmax(scores))
            downbeats = [beats[i] for i in range(phase, len(beats), 4)]
    gaps = np.diff(beats) if len(beats) > 1 else np.array([0.5])
    tempo = float(60.0 / np.median(gaps)) if len(gaps) and np.median(gaps) > 0 else 0.0
    sections = []
    if len(beats):
        level_of = []
        smoothed = smooth(energy, 8)
        peak = smoothed.max() if smoothed.max() > 0 else 1.0
        for v in smoothed / peak:
            level_of.append("low" if v < 0.6 else ("mid" if v < 0.85 else "high"))
        runs = []
        for i, level in enumerate(level_of):
            if runs and runs[-1][1] == level:
                runs[-1][2] = i
            else:
                runs.append([i, level, i])
        merged = []
        for run in runs:
            if merged and run[2] - run[0] + 1 < 8:
                merged[-1][2] = run[2]
            else:
                merged.append(run)
        # Smoothing blurs where a section starts: move each change to the
        # sharpest jump in energy within four beats, so a drop lands on it.
        for j in range(1, len(merged)):
            b = merged[j][0]
            lo, hi = max(1, b - 4), min(len(energy) - 1, b + 4)
            if hi >= lo:
                k = max(range(lo, hi + 1), key=lambda i: abs(energy[i] - energy[i - 1]))
                if merged[j - 1][0] < k:
                    merged[j][0] = k
                    merged[j - 1][2] = k - 1
        for j, (first, level, last) in enumerate(merged):
            start = 0.0 if j == 0 else beats[first]
            end = duration if j == len(merged) - 1 else beats[merged[j + 1][0]]
            sections.append({"start": round(start, 3), "end": round(end, 3), "level": level})
    result = {
        "duration": round(duration, 3),
        "tempo": round(tempo, 2),
        "beats": [round(t, 3) for t in beats],
        "downbeats": [round(t, 3) for t in downbeats],
        "energy": [round(float(v), 3) for v in energy],
        "sections": sections,
        "tracker": tracker,
    }
    with open(out, "w") as f:
        json.dump(result, f)


main()
`;

/** Words with times, from faster-whisper (the base model unless OFA_VIDEO_WHISPER says). */
export const TRANSCRIBE_PY = `import json, os, sys
from faster_whisper import WhisperModel


def main():
    src, out = sys.argv[1], sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    model = WhisperModel(
        os.environ.get("OFA_VIDEO_WHISPER", "base"),
        device="cpu",
        compute_type="int8",
        download_root=os.environ.get("OFA_VIDEO_MODELS") or None,
    )
    segments, info = model.transcribe(src, word_timestamps=True, vad_filter=True, language=language)
    words = []
    for segment in segments:
        for w in segment.words or []:
            words.append({"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
    with open(out, "w") as f:
        json.dump({"language": info.language, "duration": round(info.duration, 3), "words": words}, f)


main()
`;
