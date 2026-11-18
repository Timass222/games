from pathlib import Path
from zipfile import ZipFile
from lxml import etree as E
import json, hashlib, re
import fitz
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'materials'
TEXT = OUT / 'text'
ASSETS = OUT / 'assets'
TEXT.mkdir(parents=True, exist_ok=True)
ASSETS.mkdir(parents=True, exist_ok=True)
NS = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'a':'http://schemas.openxmlformats.org/drawingml/2006/main', 'p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
files = sorted(p for p in (OUT/'originals').iterdir() if p.suffix.lower() in ('.pdf','.docx','.pptx'))
manifest = []
for n,p in enumerate(files,1):
    sid = f'S{n:02d}'
    dest = ASSETS / sid
    dest.mkdir(exist_ok=True)
    lines = [f'# {sid}. {p.name}', '', 'Извлечённый текст. Разметка адаптирована; исходный файл сохранён.', '']
    info = {'id':sid,'file':p.relative_to(ROOT).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'assets':[]}
    if p.suffix == '.pdf':
        doc = fitz.open(p)
        info['pages'] = len(doc)
        info['chars_by_page'] = []
        for i,page in enumerate(doc,1):
            t = page.get_text(sort=True)
            lines += [f'## Страница {i}', '', t.strip(), '']
            info['chars_by_page'].append(len(t))
            img = dest / f'page-{i:02d}.png'
            page.get_pixmap(matrix=fitz.Matrix(1.5,1.5)).save(img)
            info['assets'].append(str(img.relative_to(OUT)))
    else:
        with ZipFile(p) as z:
            if p.suffix == '.docx':
                root = E.fromstring(z.read('word/document.xml'))
                body = root.find('w:body',NS)
                for i,el in enumerate(body,1):
                    tag = E.QName(el).localname
                    if tag == 'p':
                        t = ''.join(el.xpath('.//w:t/text()',namespaces=NS))
                        if t.strip(): lines += [f'<!-- Блок {i} -->',t,'']
                    elif tag == 'tbl':
                        lines += [f'### Таблица (блок {i})','']
                        for ri,row in enumerate(el.findall('w:tr',NS),1):
                            cells = [' / '.join(''.join(para.xpath('.//w:t/text()',namespaces=NS)) for para in cell.findall('w:p',NS)) for cell in row.findall('w:tc',NS)]
                            lines += [f'Строка {ri}: ' + ' | '.join(cells)]
                        lines += ['']
                for part in z.namelist():
                    if re.match(r'word/(comments|footnotes|endnotes|header\d+|footer\d+)\.xml$',part):
                        x = E.fromstring(z.read(part))
                        ts = [''.join(el.xpath('.//w:t/text()',namespaces=NS)) for el in x.findall('.//w:p',NS)]
                        if any(ts): lines += [f'## Дополнительная часть: {part}','', '\n\n'.join(ts),'']
                info['body_blocks'] = len(body)
                info['revisions'] = len(root.xpath('.//w:ins | .//w:del',namespaces=NS))
            else:
                slides = sorted([x for x in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$',x)],key=lambda x:int(re.search(r'(\d+)\.xml',x)[1]))
                info['slides'] = len(slides)
                for i,part in enumerate(slides,1):
                    root = E.fromstring(z.read(part))
                    lines += [f'## Слайд {i}','']
                    for para in root.findall('.//a:p',NS):
                        t = ''.join(para.xpath('.//a:t/text()',namespaces=NS))
                        if t.strip(): lines += [t,'']
                    note = f'ppt/notesSlides/notesSlide{i}.xml'
                    if note in z.namelist():
                        x = E.fromstring(z.read(note))
                        ts = [''.join(el.xpath('.//a:t/text()',namespaces=NS)) for el in x.findall('.//a:p',NS)]
                        ts = [t for t in ts if t.strip() and t.strip()!=str(i)]
                        if ts: lines += ['### Заметки к слайду','', '\n\n'.join(ts),'']
            for part in z.namelist():
                if '/media/' in part and not part.endswith('/'):
                    img = dest / Path(part).name
                    img.write_bytes(z.read(part))
                    info['assets'].append(str(img.relative_to(OUT)))
                if ('embeddings/' in part or '/diagrams/data' in part or '/charts/chart' in part or '/comments/' in part) and not part.endswith('/'):
                    info.setdefault('extra_parts',[]).append(part)
    text = '\n'.join(lines)
    target = TEXT / f'{sid}.md'
    target.write_text(text,encoding='utf-8')
    info['text_file'] = str(target.relative_to(OUT))
    info['text_chars'] = len(text)
    manifest.append(info)
    thumbs=[]
    for path in dest.iterdir():
        try:
            im=Image.open(path).convert('RGB'); im.thumbnail((550,650))
            thumbs.append((path.name,im.copy()))
        except Exception: pass
    for start in range(0,len(thumbs),6):
        subset=thumbs[start:start+6]
        sheet=Image.new('RGB',(1120,710*((len(subset)+1)//2)),'#dddddd'); draw=ImageDraw.Draw(sheet)
        for j,(name,im) in enumerate(subset):
            x=(j%2)*560;y=(j//2)*710
            draw.text((x+8,y+8),f'{sid} {name}',fill='black'); sheet.paste(im,(x+5,y+30))
        sheet.save(ASSETS / f'{sid}-sheet-{start//6+1}.jpg')
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(manifest,ensure_ascii=False,indent=2))
