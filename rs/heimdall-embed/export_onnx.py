"""Export BAAI/bge-small-en-v1.5 (safetensors) -> ONNX for the Rust embed binary.
Run: ~/.heimdall/venv/bin/python3 rs/heimdall-embed/export_onnx.py
Output: rs/heimdall-embed/model/model.onnx + tokenizer.json (copied from cache).
"""
import shutil
from pathlib import Path

HF_CACHE = Path.home() / ".cache/huggingface/hub/models--BAAI--bge-small-en-v1.5/snapshots/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"
OUT = Path(__file__).parent / "model"

def main():
    OUT.mkdir(exist_ok=True)
    from optimum.onnxruntime import ORTModelForFeatureExtraction
    from transformers import AutoTokenizer
    model = ORTModelForFeatureExtraction.from_pretrained(str(HF_CACHE), export=True)
    model.save_pretrained(str(OUT))
    tok = AutoTokenizer.from_pretrained(str(HF_CACHE))
    tok.save_pretrained(str(OUT))
    print("exported ->", OUT)
    for f in sorted(OUT.iterdir()):
        print("  ", f.name, f.stat().st_size)

if __name__ == "__main__":
    main()