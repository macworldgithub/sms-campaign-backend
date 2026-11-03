"""Decode a bounded XLSX upload from stdin; never persist customer uploads."""
import base64
import io
import json
import sys
import zipfile
import openpyxl

data = base64.b64decode(sys.stdin.read(), validate=True)
if len(data) > 5 * 1024 * 1024:
    raise ValueError('Maximum workbook size is 5 MB')
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    if sum(item.file_size for item in archive.infolist()) > 30 * 1024 * 1024:
        raise ValueError('Expanded workbook exceeds 30 MB')
book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_links=False)
sheet = book.active
rows = sheet.iter_rows(values_only=True)
headers = [str(value or '').strip() for value in next(rows)]
if not all(key in headers for key in ('mobile', 'consent', 'evidence')):
    raise ValueError('Workbook requires mobile, consent and evidence columns')
result = []
for row in rows:
    if any(value is not None for value in row):
        result.append({key: str(value or '').strip() for key, value in zip(headers, row) if key})
    if len(result) > 10000:
        raise ValueError('Maximum 10,000 rows')
print(json.dumps(result))
book.close()
