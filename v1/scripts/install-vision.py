"""Install official local OCR weights. Generation remains Gemma 4 12B."""
import concurrent.futures,urllib.request
from pathlib import Path
repository="Qwen/Qwen3-VL-4B-Instruct-GGUF"
directory=Path(__file__).resolve().parent.parent/"tools/models/ocr"
directory.mkdir(parents=True,exist_ok=True)
def download(pair):
 name,size=pair;target=directory/name
 if target.exists() and target.stat().st_size==size:return name+" verified"
 temporary=target.with_suffix(".part")
 with urllib.request.urlopen("https://huggingface.co/"+repository+"/resolve/main/"+name+"?download=true&edumaster=1",timeout=30) as response,temporary.open("wb") as output:
  while block:=response.read(4*1024*1024):output.write(block)
 if temporary.stat().st_size!=size:raise RuntimeError("Incomplete download: "+name)
 temporary.replace(target);return name+" verified"
files=[("Qwen3VL-4B-Instruct-Q4_K_M.gguf",2497281664),("mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",453974304)]
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
 for result in executor.map(download,files):print(result,flush=True)

import runpy
runpy.run_path(str(Path(__file__).with_name("install-gemma-vision.py")),run_name="__main__")
