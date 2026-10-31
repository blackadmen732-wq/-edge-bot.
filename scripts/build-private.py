"""Create a local, single-file private desk. Never embed access tokens or provider keys."""
from pathlib import Path
import base64, html, json, re, runpy
root=Path(__file__).resolve().parents[1]
runpy.run_path(str(root/'scripts/build-desk.py'))
p=root/'dashboard/desk'
page=(p/'desktop.html').read_text()
assets={f.stem:'data:image/jpeg;base64,'+base64.b64encode(f.read_bytes()).decode() for f in (p/'assets').glob('*.jpg')}
page=page.replace("'assets/'+e.target.value+'.jpg'",'PARALLAX_ASSETS[e.target.value]')
for name,value in assets.items():page=page.replace('assets/'+name+'.jpg',value)
page=page.replace('<script type="module">','<script type="module">\nconst PARALLAX_ASSETS='+json.dumps(assets)+';\n',1)
research=(root/'dashboard/research/index.html').read_text()
page=page.replace('src="../research/index.html"','srcdoc="'+html.escape(research,quote=True)+'"')
output=root.parent/'Parallax-Private.html'
output.write_text(page)
print(str(output))
