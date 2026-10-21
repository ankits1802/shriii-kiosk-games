"""SHRIII closed-vocabulary ASR bake-off harness (VOX-06).

Compares candidate engines (sherpa-onnx keyword spotting, Whisper variants via sherpa-onnx, an ONNX CTC
model such as IndicConformer with constrained decoding, and an MFCC/DTW floor baseline) on
closed-vocabulary accuracy by SNR, false accepts on keyword-free audio, latency, CPU and subgroup
fairness, applies the YAML policy and emits the language pack's ASR configuration.
"""

__version__ = "0.1.0"
