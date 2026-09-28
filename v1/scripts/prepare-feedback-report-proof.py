"""Rebuild only image slots from the same real job; apply the export clone cleanup."""
import json,re
from pathlib import Path
root=Path('output/teacher-feedback-fix-20260928')
html=(root/'report-with-image-slots.html').read_text(encoding='utf-8')
assert html.endswith('</article>') and '[Truncated]' not in html
job=json.loads((root/'production-passed.json').read_text(encoding='utf-8'))
figures=sorted(job['result']['figures'],key=lambda item:item['page'])
for index,figure in enumerate(figures):
    html=html.replace(f'EDUMASTER_SOURCE_IMAGE_{index}',figure['dataUrl'])
assert 'EDUMASTER_SOURCE_IMAGE_' not in html
# Same removal as reportHtmlForArchive: live accessible markup stays untouched.
html=re.sub(r'<mjx-assistive-mml\b[^>]*>.*?</mjx-assistive-mml>','',html,flags=re.S)
assert 'mjx-assistive-mml' not in html
(root/'report.html').write_text(html,encoding='utf-8')
print(json.dumps({'complete':True,'sections':html.count('report-section-title'),'duplicateStepLists':html.count('class="report-steps"'),'visibleSvgFormulas':html.count('<svg ')}))
