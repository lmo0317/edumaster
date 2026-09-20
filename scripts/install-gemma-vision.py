"""Install the official llama.cpp projector for the existing Gemma 4 12B weights."""
import hashlib,json,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parent.parent
repository='ggml-org/gemma-4-12B-it-GGUF'
name='mmproj-gemma-4-12B-it-BF16.gguf'
target=root/'tools/models/gemma-vision'/name
target.parent.mkdir(parents=True,exist_ok=True)
entries=json.load(urllib.request.urlopen('https://huggingface.co/api/models/'+repository+'/tree/main?expand=true',timeout=30))
entry=next(x for x in entries if x.get('path')==name)
size=entry['size']; expected=entry.get('lfs',{}).get('oid')
if not target.exists() or target.stat().st_size!=size:
    temporary=target.with_suffix('.part')
    with urllib.request.urlopen('https://huggingface.co/'+repository+'/resolve/main/'+name+'?download=true&edumaster=vision',timeout=30) as response,temporary.open('wb') as output:
        while block:=response.read(4*1024*1024):output.write(block)
    if temporary.stat().st_size!=size:raise RuntimeError('Incomplete Gemma projector')
    if expected:
        with temporary.open('rb') as stream:
            if hashlib.file_digest(stream,'sha256').hexdigest()!=expected:raise RuntimeError('Gemma projector checksum mismatch')
    temporary.replace(target)
if expected:
    with target.open('rb') as stream:
        if hashlib.file_digest(stream,'sha256').hexdigest()!=expected:raise RuntimeError('Gemma projector checksum mismatch')
print('Gemma 4 12B projector verified:',size,'bytes')
