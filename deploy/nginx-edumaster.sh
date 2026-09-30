#!/usr/bin/env bash
# Points /edumaster/ at this app (:18290) and sends the old addresses there: /edumasterv2/<path> → /edumaster/<path>
# (links to the public comparison page keep working), /edumasterv1/ → /edumaster/. Replaces the three EduMaster
# route pairs (v1 gateway :18280, v2 :18290, /edumaster/ → v1) in both server blocks. Run on the server with sudo:
#   sudo bash ~/apps/edumaster/deploy/nginx-edumaster.sh
set -euo pipefail
SITE=/etc/nginx/sites-available/aieng
if grep -q 'rewrite ^/edumasterv2' "$SITE"; then echo "already configured"; exit 0; fi
BACKUP="$SITE.edumaster-backup-$(date +%Y%m%d-%H%M%S)"
cp "$SITE" "$BACKUP"
python3 - "$SITE" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
pair = lambda name: rf"    location = /{name} \{{[^}}]*\}}\n    location /{name}/ \{{[^}}]*\}}\n"
old = re.compile(pair('edumasterv1') + r"\s*\n" + pair('edumasterv2') + r"\s*\n" + pair('edumaster'))
new = """    location = /edumaster { return 302 /edumaster/; }
    location /edumaster/ {
        proxy_pass http://127.0.0.1:18290/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        client_max_body_size 20m;
    }

    location /edumasterv2 { rewrite ^/edumasterv2/?(.*)$ /edumaster/$1 permanent; }
    location /edumasterv1 { return 301 /edumaster/; }
"""
text, count = old.subn(lambda m: new, text)
if count != 2:
    sys.exit(f"expected the EduMaster routes in 2 server blocks, found {count}; nothing changed")
open(path, 'w', encoding='utf-8').write(text)
print("replaced in 2 server blocks")
PY
if nginx -t; then systemctl reload nginx; echo "nginx reloaded: /edumaster/ is this app; /edumasterv1/ and /edumasterv2/ redirect"; else
  echo "nginx -t failed; restoring $BACKUP"; cp "$BACKUP" "$SITE"; exit 1; fi
