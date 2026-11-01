"""Extract the official provider catalog for voice selection (no third-party packages)."""
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile

ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with ZipFile('data/video/voice-catalog.xlsx') as book:
    strings = []
    if 'xl/sharedStrings.xml' in book.namelist():
        strings = [''.join(t.itertext()) for t in ET.fromstring(book.read('xl/sharedStrings.xml')).findall('s:si', ns)]
    rows = []
    for row in ET.fromstring(book.read('xl/worksheets/sheet1.xml')).findall('.//s:row', ns):
        cells = []
        for cell in row.findall('s:c', ns):
            v = cell.find('s:v', ns)
            val = v.text if v is not None else ''.join(cell.itertext())
            cells.append(strings[int(val)] if cell.attrib.get('t') == 's' else val)
        rows.append(cells)
Path('data/video/voice-catalog.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(rows[:4], ensure_ascii=False))
for row in rows[1:]:
    text = ' '.join(str(c) for c in row)
    if any(s in text for s in ['少年', '青年', '少女', '清冷', '知性', '阳光', '温柔', '磁性', '御姐', '中二', '沉稳']):
        print(json.dumps(row, ensure_ascii=False))
