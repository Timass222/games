from pathlib import Path
import json
from zipfile import ZipFile
from lxml import etree as E
import pymupdf as f

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT/'materials'
manifest = json.loads((OUT/'manifest.json').read_text(encoding='utf-8'))
info = next(x for x in manifest if x['id']=='S08')
d=f.open(ROOT/info['file'])
lines=['# S08. '+info['file'],'','Текст извлечён по ячейкам таблицы в исходном порядке PDF. Переносы строк внутри ячеек свёрнуты; пустые служебные колонки не воспроизводятся. Номера строк относятся к таблице соответствующей страницы.','']
rows=[]
labels=['Компетенция','Под-компетенция','Описание / поведенческий аспект','Уровень 0','Уровень 1','Уровень 2','Уровень 3','Служебная колонка','Оценка','Конкретные примеры и пояснения','Дополнительные комментарии']
for pi,page in enumerate(d,1):
    table=page.find_tables().tables[0]
    lines += [f'## Страница {pi}','']
    for ri,row in enumerate(table.rows,1):
        values=[]
        for cell in row.cells:
            values.append(' '.join(page.get_text(clip=f.Rect(cell),sort=False).split()) if cell else '')
        if not any(values): continue
        rows.append({'page':pi,'row':ri,'cells':values})
        lines += [f'### Строка {ri}','']
        if pi == 1 and ri <= 12:
            lines += [' | '.join(t for t in values if t),'']
        else:
            for ci,t in enumerate(values):
                label=labels[ci] if ci<len(labels) else f'Служебная колонка {ci+1}'
                if t: lines += [f'**{label}:** {t}','']
(OUT/'text'/'S08.md').write_text('\n'.join(lines),encoding='utf-8')
(OUT/'checklist_cells.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
info['text_chars']=len('\n'.join(lines))
info['extraction']='Text clipped to table cells; PDF content order, not geometric sorting'
for item in manifest:
    if not item['file'].endswith(('.docx','.pptx')): continue
    links=[]
    with ZipFile(ROOT/item['file']) as z:
        for part in z.namelist():
            if part.endswith('.rels'):
                for el in E.fromstring(z.read(part)):
                    if el.get('TargetMode')=='External':
                        links.append(el.get('Target'))
    if links:
        path=OUT/item['text_file']
        s=path.read_text(encoding='utf-8').split('\n## Внешние ссылки, сохранённые в исходнике')[0]+'\n## Внешние ссылки, сохранённые в исходнике\n\n'+'\n'.join('- '+x for x in dict.fromkeys(links))+'\n'
        path.write_text(s,encoding='utf-8')
        item['text_chars']=len(s)
        item['external_links']=list(dict.fromkeys(links))
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print('Extracted',len(rows),'nonempty table rows')
for row in rows:
    print(row['page'],row['row'],' | '.join(row['cells'][:3]))
