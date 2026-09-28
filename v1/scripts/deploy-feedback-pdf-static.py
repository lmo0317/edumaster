from pathlib import Path
import shutil,datetime
root=Path('/home/lmo0317/apps/edumaster')
work=root/'feedback-verification'
backup=work/('backup-pdf-static-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir()
for name in ('app.js','style.css'):
    shutil.copy2(root/'public'/name,backup/name)
    for destination in (root/'public',root/'backend/wwwroot'):
        shutil.copy2(work/name,destination/name)
for destination in (root/'public',root/'backend/wwwroot'):
    shutil.copy2(work/'create-index-v81.html',destination/'create/index.html')
print('Static updated without restarting services')
