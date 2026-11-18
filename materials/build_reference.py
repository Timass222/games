from pathlib import Path
from collections import Counter
from zipfile import ZipFile
from lxml import etree as E
import hashlib, json, re, shutil
import pymupdf as f
from pptx import Presentation

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'materials'
manifest=json.loads((OUT/'manifest.json').read_text(encoding='utf-8'))
raw=OUT/'raw'
raw.mkdir(exist_ok=True)
if not (raw/'S06_failed_text_layer.md').exists():
    shutil.copyfile(OUT/'text'/'S06.md',raw/'S06_failed_text_layer.md')
shutil.copyfile(OUT/'text'/'S06_visual.md',OUT/'text'/'S06.md')
notes={
 'S04':'\n## Изображение\n\nВложенный PNG содержит крупный чёрный знак вопроса на светлом фоне. Дополнительного текста нет.\n',
 'S05':'\n## Текстовое описание карты\n\nИллюстрация города у реки. Сверху расположены плотная застройка, мельницы и группа зданий с синими крышами; на реке показаны суда и переправа. На нижнем берегу — отдельные дома, юго-западнее — руины с каменными колоннами. Красными обводками отмечены четыре площадки: 1 — среди верхней левой городской застройки; 2 — возле группы зданий справа; 3 — на нижнем берегу у домов; 4 — руины внизу слева. Сопоставление с перечнем мест (площадь, жилой квартал, другой берег, руины) следует из контекста документа; сами названия на карте не подписаны. Это иллюстрация выбора площадки, численных расстояний и стоимости на ней нет.\n\n![Карта из концепта](materials/assets/S05/image1.jpg)\n'
}
for item in manifest:
    p=OUT/item['text_file']
    t=p.read_text(encoding='utf-8')
    if item['id'] in notes:
        marker='\n## Изображение' if item['id']=='S04' else '\n## Текстовое описание карты'
        t=t.split(marker)[0]+notes[item['id']]
        t=t.replace('(materials/assets/', '(../assets/')
        p.write_text(t,encoding='utf-8')
    item['text_chars']=len(t)
    if item['id']=='S06': item['extraction']='Manual visual transcription of all 7 pages; Cyrillic lost in PDF text layer'
manifest=[x for x in manifest if x['id'] not in ('S09','S10')]
for source_id in ('S09','S10'):
    source_text=(OUT/'text'/f'{source_id}.md').read_text(encoding='utf-8')
    manifest.append({'id':source_id,'file':None,'origin':'User messages 2026-11-05; meeting date not specified','text_file':f'text/{source_id}.md','text_chars':len(source_text)})
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')

summary=(OUT/'synthesis.md').read_text(encoding='utf-8')
parts=['# Полные тексты материалов игры\n\nСправочный архив: читать нужный источник по ссылке из [GAME_CONTEXT.md](../GAME_CONTEXT.md), а не целиком при восстановлении контекста. Здесь сохранены старые варианты и вопросы; актуальные решения находятся в основном своде.\n\n<a id="appendix"></a>\n## Источники\n']
parts += [f'- [{item["id"]}](#{item["id"].lower()})' for item in manifest]
for item in manifest:
    t=(OUT/item['text_file']).read_text(encoding='utf-8')
    t=re.sub(r'^(#{1,5}) ',r'#\1 ',t,flags=re.M)
    t=t.replace('(../assets/', '(assets/')
    parts += [f'\n<a id="{item["id"].lower()}"></a>\n',t]
archive='\n'.join(parts)
(OUT/'FULL_TEXTS.md').write_text(archive,encoding='utf-8')
master=summary
(ROOT/'GAME_CONTEXT.md').write_text(master,encoding='utf-8')

report={'original_hashes':{},'pptx':{},'pdf_checklist':{},'links':{},'text_quality':{}}
for item in manifest:
    if item['file']:
        ok=hashlib.sha256((ROOT/item['file']).read_bytes()).hexdigest()==item['sha256']
        report['original_hashes'][item['id']]=ok
        assert ok, item['file']
    t=(OUT/item['text_file']).read_text(encoding='utf-8')
    assert '\ufffd' not in t, item['id']
    assert re.sub(r'^(#{1,5}) ',r'#\1 ',t,flags=re.M).replace('(../assets/', '(assets/') in archive, item['id']
    if item['file'] and item['file'].endswith('.pptx'):
        pres=Presentation(ROOT/item['file'])
        count=0
        for slide in pres.slides:
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        if para.text.strip():
                            assert para.text.strip() in t,(item['id'],para.text)
                            count+=1
        report['pptx'][item['id']]={'slides':len(pres.slides),'text_paragraphs_checked':count}
    if item['file'] and item['file'].endswith('.docx'):
        with ZipFile(ROOT/item['file']) as z:
            x=E.fromstring(z.read('word/document.xml'))
            original=''.join(x.xpath('//w:t/text()',namespaces={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}))
            # Every nonempty original run must remain available (whitespace normalized).
            normalized=' '.join(t.split())
            runs=x.xpath('//w:t/text()',namespaces={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'})
            missing=[v for v in runs if v.strip() and ' '.join(v.split()) not in normalized]
            assert not missing,(item['id'],missing)
            report.setdefault('docx',{})[item['id']]={'text_runs_checked':len(runs),'missing':len(missing)}

rows=json.loads((OUT/'checklist_cells.json').read_text(encoding='utf-8'))
check=f.open(ROOT/next(x['file'] for x in manifest if x['id']=='S08'))
for pi,p in enumerate(check,1):
    original=Counter(re.sub(r'\s','',p.get_text()))
    cells=Counter(re.sub(r'\s','',''.join(''.join(r['cells']) for r in rows if r['page']==pi)))
    missing=original-cells; extra=cells-original
    assert not missing and not extra, (pi,missing,extra)
    report['pdf_checklist'][str(pi)]={'source_nonspace_chars':sum(original.values()),'cell_nonspace_chars':sum(cells.values()),'missing_chars':dict(missing),'extra_chars':dict(extra)}
sub=[r['cells'][1] for r in rows if r['cells'][2] and not (r['page']==1 and r['row']<=12) and r['cells'][1]]
report['pdf_checklist']['named_subcompetencies']=len(sub)
assert len(sub)==34
anchors=set(re.findall(r'<a id="([^"]+)"',master))
anchor_links=re.findall(r'\]\(#([^\)]+)\)',master)
assert not(set(anchor_links)-anchors)
report['links']['internal_anchors_checked']=len(anchor_links)
archive_anchors=set(re.findall(r'<a id="([^"]+)"',archive))
archive_links=re.findall(r'\]\(materials/FULL_TEXTS.md#([^\)]+)\)',master)
assert not(set(archive_links)-archive_anchors)
report['links']['archive_anchors_checked']=len(archive_links)
assert len(master.splitlines())<=290
report['text_quality']={'source_count':len(manifest),'replacement_characters':master.count('\ufffd')+archive.count('\ufffd'),'master_chars':len(master),'master_lines':len(master.splitlines()),'archive_chars':len(archive),'archive_lines':len(archive.splitlines())}
(OUT/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
