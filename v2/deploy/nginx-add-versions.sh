#!/usr/bin/env bash
# Adds /edumasterv1/ (existing v1 gateway :18280) and /edumasterv2/ (v2 :18290) to the nginx site.
# The existing /edumaster/ route is left untouched. Run on the server with sudo:
#   sudo bash ~/apps/edumasterv2/deploy/nginx-add-versions.sh
set -euo pipefail
SITE=/etc/nginx/sites-available/aieng
if grep -q 'location /edumasterv2/' "$SITE"; then echo "already configured"; exit 0; fi
cp "$SITE" "$SITE.edumaster-versions-backup-$(date +%Y%m%d-%H%M%S)"
python3 - "$SITE" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
block = """    location = /edumasterv1 { return 302 /edumasterv1/; }
    location /edumasterv1/ {
        proxy_pass http://127.0.0.1:18280/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 330s;
        proxy_send_timeout 330s;
        client_max_body_size 11m;
        proxy_buffering off;
    }

    location = /edumasterv2 { return 302 /edumasterv2/; }
    location /edumasterv2/ {
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

"""
anchor = "    location = /edumaster { return 302 /edumaster/; }\n"
count = text.count(anchor)
if count == 0:
    sys.exit("anchor not found: " + anchor.strip())
text = text.replace(anchor, block + anchor)
open(path, 'w', encoding='utf-8').write(text)
print(f"inserted into {count} server block(s)")
PY
if nginx -t; then systemctl reload nginx; echo "nginx reloaded: /edumasterv1/ and /edumasterv2/ are live"; else
  echo "nginx -t failed; restoring backup"; cp "$(ls -t $SITE.edumaster-versions-backup-* | head -1)" "$SITE"; exit 1; fi
