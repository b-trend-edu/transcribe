"""Translate caption cues with a local OPUS-MT model through CTranslate2.

stdin:  {"model_dir": "...", "texts": ["...", ...]}
stdout: {"texts": ["...", ...], "device": "cuda", "seconds": 12.3}

One cue in, one cue out, same order — alignment is by construction, which is
the property the LLM path had to check for. CTranslate2 is already in the image
for faster-whisper, so this adds a model, not a runtime.
"""
import json
import sys
import time

import ctranslate2
import sentencepiece as spm


def main() -> None:
    req = json.load(sys.stdin)
    model_dir = req["model_dir"]
    texts = req["texts"]
    batch_size = int(req.get("batch_size", 64))

    device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    translator = ctranslate2.Translator(
        model_dir,
        device=device,
        compute_type="int8_float16" if device == "cuda" else "int8",
    )
    src = spm.SentencePieceProcessor(model_file=f"{model_dir}/source.spm")
    tgt = spm.SentencePieceProcessor(model_file=f"{model_dir}/target.spm")

    started = time.time()
    # Empty cues are passed through rather than sent: the model hallucinates on
    # empty input, and an empty cue must stay empty.
    idx = [i for i, t in enumerate(texts) if t.strip()]
    tokens = [src.encode(texts[i], out_type=str) + ["</s>"] for i in idx]
    results = translator.translate_batch(
        tokens,
        max_batch_size=batch_size,
        beam_size=4,
        # A cue is one or two sentences; cap runaway repetition on garbled audio.
        max_decoding_length=256,
        repetition_penalty=1.1,
    )
    out = list(texts)
    for i, r in zip(idx, results):
        out[i] = tgt.decode(r.hypotheses[0]).strip()

    json.dump(
        {"texts": out, "device": device, "seconds": round(time.time() - started, 2)},
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()
