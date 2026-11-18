from pathlib import Path
import re
from html import escape

import pymupdf as fitz
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer, PageBreak

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'WORLD_AND_ROLES_DRAFT.md'
OUTPUT = ROOT / 'output/pdf/WORLD_AND_ROLES.pdf'
PREVIEW = ROOT / 'tmp/pdfs'
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
PREVIEW.mkdir(parents=True, exist_ok=True)

text = SOURCE.read_text(encoding='utf-8').replace('**', '')
text = re.sub('[\u2010-\u2015\u2212]', '-', text)
SOURCE.write_text(text, encoding='utf-8')

pdfmetrics.registerFont(TTFont('ArialRegular', 'C:/Windows/Fonts/arial.ttf'))
styles = {
    'body': ParagraphStyle('body', fontName='ArialRegular', fontSize=10, leading=13.4, spaceAfter=7),
    'title': ParagraphStyle('title', fontName='ArialRegular', fontSize=18, leading=22, spaceAfter=10),
    'h2': ParagraphStyle('h2', fontName='ArialRegular', fontSize=13, leading=16, spaceBefore=9, spaceAfter=8, keepWithNext=True),
    'h3': ParagraphStyle('h3', fontName='ArialRegular', fontSize=11.5, leading=15, spaceBefore=7, spaceAfter=7, keepWithNext=True),
    'cell': ParagraphStyle('cell', fontName='ArialRegular', fontSize=9.4, leading=12.1),
    'bullet': ParagraphStyle('bullet', fontName='ArialRegular', fontSize=10, leading=13.4, leftIndent=10, firstLineIndent=-8, spaceAfter=4),
}

doc = SimpleDocTemplate(str(OUTPUT), pagesize=A4, leftMargin=40, rightMargin=40,
                        topMargin=34, bottomMargin=34,
                        title='Вавилонская башня: мир, роли и связь с брифом', author='')
story = []
lines = text.splitlines()
i = 0
table_count = 0
while i < len(lines):
    line = lines[i].strip()
    if not line:
        i += 1
        continue
    if line.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].strip().startswith('|'):
            cells = [c.strip() for c in lines[i].strip().strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?', c) for c in cells):
                rows.append([Paragraph(escape(c), styles['cell']) for c in cells])
            i += 1
        ncols = len(rows[0])
        widths = [doc.width * x for x in ([.23, .29, .48] if ncols == 3 else [.27, .73])]
        table = Table(rows, colWidths=widths, repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e9edf1')),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f7f8fa')]),
            ('GRID', (0, 0), (-1, -1), .45, colors.HexColor('#b6bec6')),
            ('LEFTPADDING', (0, 0), (-1, -1), 7),
            ('RIGHTPADDING', (0, 0), (-1, -1), 7),
            ('TOPPADDING', (0, 0), (-1, -1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ]))
        story.extend([table, Spacer(1, 8)])
        table_count += 1
        continue
    if line == '### Места строительства' or line.startswith('Победа и финал.'):
        story.append(PageBreak())
    if line.startswith('### '):
        key, content = 'h3', line[4:]
    elif line.startswith('## '):
        key, content = 'h2', line[3:]
    elif line.startswith('# '):
        key, content = 'title', line[2:]
    elif line.startswith('- '):
        key, content = 'bullet', line
    else:
        key, content = 'body', line
    story.append(Paragraph(escape(content), styles[key]))
    i += 1

def footer(canvas, document):
    canvas.setFont('ArialRegular', 8)
    canvas.setFillColor(colors.HexColor('#626b74'))
    canvas.drawRightString(A4[0] - 40, 19, str(document.page))

doc.build(story, onFirstPage=footer, onLaterPages=footer)
pdf = fitz.open(OUTPUT)
actual = '\n'.join(page.get_text() for page in pdf)
assert table_count == 4
assert not re.search('[\u2010-\u2015\u2212]', actual)
assert not any('bold' in font[3].lower() for page in pdf for font in page.get_fonts())
# All source words must remain in the PDF, ignoring Markdown table syntax and whitespace.
expected_lines = []
for line in text.splitlines():
    if line.startswith('|') and all(re.fullmatch(r':?-+:?', c.strip()) for c in line.strip('|').split('|')):
        continue
    expected_lines.append(re.sub(r'^#{1,3}\s+', '', line).replace('|', ' '))
normalize = lambda s: re.sub(r'\s+', '', s)
expected = normalize('\n'.join(expected_lines))
extracted = normalize('\n'.join(page.get_text(clip=fitz.Rect(0, 0, page.rect.width, page.rect.height - 30)) for page in pdf))
assert expected == extracted, 'Source and PDF text differ'
for j, page in enumerate(pdf, 1):
    page.get_pixmap(matrix=fitz.Matrix(1.4, 1.4)).save(PREVIEW / f'world-{j}.png')
print(f'Created {OUTPUT}; pages={len(pdf)}; tables={table_count}; text match verified; regular font only')
