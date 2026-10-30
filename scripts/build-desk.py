"""Bundle the desk modules into desktop.html; assets stay alongside it."""
from pathlib import Path
import re
p=Path(__file__).resolve().parents[1]/'dashboard/desk'
html=(p/'index.html').read_text().replace('<link rel="stylesheet" href="style.css">','<style>'+(p/'style.css').read_text()+'</style>')
modules=['engine.mjs','cosmos.mjs','chat.mjs','scene.mjs','parallax.mjs','immersive.mjs']
code='\n'.join((p/f).read_text().replace('export function ','function ').replace('export const ','const ') for f in modules)+'\n'+re.sub(r'^import .*?;\n','',(p/'app.mjs').read_text(),flags=re.M)
html=re.sub(r'<script type="module" src="app.mjs"></script>',lambda m:'<script type="module">'+code+'</script>',html)
(p/'desktop.html').write_text(html)
