"""A local model on a rented GPU (Modal, modal.com), to measure with the eval harness what a model would do on a PC
we do not have (e.g. an RTX 5090): the same llama-server settings as scripts/start-local-model.ps1, the model files
kept in a Modal volume so the GPU is paid only while it answers.

  modal run eval/modal-llm.py::download --key qwen36-q8        # once per model, CPU only
  modal run eval/modal-llm.py::serve --key qwen36-q8           # prints the address; Ctrl+C (or --minutes) stops the GPU
  # on the server, the PC provider pointed at that address for one evaluation:
  EDUMASTER_GEMMA_ENDPOINT=<address>/v1 node eval/run.js --providers gemma --cases chem-molar-mass --stage full

The model names itself "modal-<model>-<quant>" so its results are kept apart from the PC's (server/llm.js pcModelKey).
"""
import subprocess
import time
import urllib.request

import modal

app = modal.App("edumaster-llm-eval")
volume = modal.Volume.from_name("edumaster-models", create_if_missing=True)

# What a 5090 (32 GB) PC can run: a dense 27B wholly on the GPU at 6 bits, the 35B MoE at 8 bits with part of its
# experts in RAM, and the 125B MoE at 3.5 bits through Strata on 64 GB of RAM.
MODELS = {
    "qwen38-27b-q6": {"repo": "unsloth/Qwen3.8-27B-GGUF", "model": "Qwen3.8-27B-UD-Q6_K_XL.gguf",
                      "mmproj": "mmproj-F16.gguf", "gpu": "L40S", "alias": "modal-qwen3.8-27b-q6",
                      "extra": ["--fit", "off", "-ngl", "99", "-ctk", "q8_0", "-ctv", "q8_0"]},
    "qwen36-q8": {"repo": "unsloth/Qwen3.6-35B-A3B-GGUF", "model": "Qwen3.6-35B-A3B-Q8_0.gguf",
                  "mmproj": "mmproj-F16.gguf", "gpu": "L40S", "alias": "modal-qwen3.6-35b-a3b-q8",
                  "extra": ["--fit", "on", "--fit-target", "3072"]},
    "flashnext-iq3s": {"repo": "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF",
                       "model": "IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf",
                       "more": ["IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf"],
                       "mmproj": "mmproj-Qwen3.8-Flash-Next-BF16.gguf", "gpu": "H100",
                       "alias": "modal-qwen3.8-flash-next-iq3_s", "extra": ["--fit", "on", "--fit-target", "3072"]},
}
QWEN_IMAGE = ["--image-min-tokens", "1024", "--image-max-tokens", "4096"]

fetch_image = modal.Image.debian_slim().pip_install("huggingface_hub[hf_transfer]").env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
server_image = modal.Image.from_registry("ghcr.io/ggml-org/llama.cpp:server-cuda", add_python="3.12").entrypoint([])


@app.function(image=fetch_image, volumes={"/models": volume}, timeout=3 * 3600, cpu=4, memory=4096)
def fetch(key: str):
    from huggingface_hub import hf_hub_download
    m = MODELS[key]
    for name in [m["model"], *m.get("more", []), m["mmproj"]]:
        path = hf_hub_download(m["repo"], name, local_dir=f"/models/{key}")
        print("ready", path)
    volume.commit()


def run_server(key: str, minutes: int):
    m = MODELS[key]
    folder = f"/models/{key}"
    args = ["/app/llama-server", "-m", f"{folder}/{m['model']}", "--mmproj", f"{folder}/{m['mmproj']}",
            "--host", "0.0.0.0", "--port", "8080", "--alias", m["alias"], "-c", "49152", "-fa", "on", "-np", "1",
            "-b", "2048", "-ub", "2048", "--no-warmup", "--jinja", "--reasoning", "auto", "--reasoning-budget", "-1",
            *QWEN_IMAGE, *m["extra"]]
    server = subprocess.Popen(args)
    for _ in range(600):
        if server.poll() is not None:
            raise RuntimeError(f"llama-server exited ({server.returncode})")
        try:
            urllib.request.urlopen("http://127.0.0.1:8080/v1/models", timeout=3)
            break
        except Exception:
            time.sleep(2)
    with modal.forward(8080) as tunnel:
        print(f"ADDRESS {tunnel.url}", flush=True)
        deadline = time.time() + minutes * 60
        while time.time() < deadline and server.poll() is None:
            time.sleep(10)
    server.terminate()


# One function per GPU size (Modal fixes the GPU per function).
@app.function(image=server_image, volumes={"/models": volume}, gpu="L40S", memory=65536, timeout=4 * 3600)
def serve_l40s(key: str, minutes: int):
    run_server(key, minutes)


@app.function(image=server_image, volumes={"/models": volume}, gpu="H100", memory=131072, timeout=4 * 3600)
def serve_h100(key: str, minutes: int):
    run_server(key, minutes)


@app.local_entrypoint()
def download(key: str):
    fetch.remote(key)


@app.local_entrypoint()
def serve(key: str, minutes: int = 120):
    (serve_h100 if MODELS[key]["gpu"] == "H100" else serve_l40s).remote(key, minutes)
