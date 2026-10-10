# Regenerates the derived acceptance TEST FIXTURES in this folder (G1: AC-02, AC-04) from fixtures/golden.
#   python3 -I fixtures/acceptance/make_g1_fixtures.py     (needs pypdf + reportlab)
# Synthetic structural documents only — never a medical reference. The outputs are committed; tests never run this.
import os
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, TextStringObject
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, '..', 'golden')
W, H = A4

# 1) g1_mixed_lecture.pdf (AC-02): ONE file with digital text (Arabic + English), an image-only scanned page,
#    a two-column page, a ruled table with a merged header and a flowchart figure with its caption.
#    file order: appendicitis p1 (text) · mixed_scanned p2 (image-only scan) · appendicitis p2 (two columns)
#                · appendicitis p3 (table) · appendicitis p4 (figure + caption). No /PageLabels (dropped on merge).
app = PdfReader(os.path.join(GOLDEN, 'lecture_appendicitis.pdf'))
scan = PdfReader(os.path.join(GOLDEN, 'mixed_scanned_lecture.pdf'))
w = PdfWriter()
w.add_page(app.pages[0])
w.add_page(scan.pages[1])
w.add_page(app.pages[1])
w.add_page(app.pages[2])
w.add_page(app.pages[3])
w.add_metadata({'/Title': 'G1 mixed lecture (TEST FIXTURE)'})
with open(os.path.join(HERE, 'g1_mixed_lecture.pdf'), 'wb') as f:
    w.write(f)


# 2) front-matter books (AC-04): 14 pages; two unnumbered front-matter pages (cover, contents), then the body
#    printed 1..12. So the page printed «12» is file page 14, and file page 12 is printed «10».
#    Every page carries a unique marker word so a quote identifies exactly one page.
MARKERS = ['ALDER', 'BIRCH', 'CEDAR', 'DAHLIA', 'ELM', 'FERN', 'GINKGO', 'HAZEL', 'IRIS', 'JUNIPER', 'KESTREL', 'LARCH', 'MAPLE', 'NUTMEG']


def body_label(i):
    return None if i < 2 else str(i - 1)


def front_matter_book(path, printed_footer_for_front):
    c = canvas.Canvas(path, pagesize=A4)
    for i in range(14):
        label = body_label(i)
        c.setFont('Helvetica-Bold', 18)
        if i == 0:
            c.drawString(60, H - 90, 'Synthetic Study Book (TEST FIXTURE)')
        elif i == 1:
            c.drawString(60, H - 90, 'Contents (TEST FIXTURE)')
        else:
            c.drawString(60, H - 90, f'Chapter section {label}')
        c.setFont('Helvetica', 12)
        c.drawString(60, H - 130, 'TEST FIXTURE - synthetic structural document for automated tests. Not a medical reference.')
        c.drawString(60, H - 160, f'Unique marker {MARKERS[i]} sits on file page {i + 1} of this synthetic file.')
        c.drawString(60, H - 185, f'This paragraph exists only to identify the page when a citation opens it ({MARKERS[i].lower()}).')
        footer = label if label else printed_footer_for_front(i)
        if footer:
            c.setFont('Helvetica', 10)
            c.drawCentredString(W / 2, 30, footer)
        c.showPage()
    c.save()


# 2a) with a /PageLabels tree (i, ii, then 1..12) and the same numbers printed in the footer
tmp = os.path.join(HERE, '_tmp_front.pdf')
front_matter_book(tmp, lambda i: ['i', 'ii'][i])
w = PdfWriter(clone_from=tmp)
nums = ArrayObject([
    NumberObject(0), DictionaryObject({NameObject('/S'): NameObject('/r')}),
    NumberObject(2), DictionaryObject({NameObject('/S'): NameObject('/D'), NameObject('/St'): NumberObject(1)}),
])
w._root_object[NameObject('/PageLabels')] = DictionaryObject({NameObject('/Nums'): nums})
w.add_metadata({'/Title': 'G1 front matter with PageLabels (TEST FIXTURE)'})
with open(os.path.join(HERE, 'g1_front_matter_labels.pdf'), 'wb') as f:
    w.write(f)
os.remove(tmp)

# 2b) NO /PageLabels: the numbers 1..12 are only printed in the footer (detected labels); the cover and the
#     contents page print no number at all
front_matter_book(os.path.join(HERE, 'g1_front_matter_detected.pdf'), lambda i: None)


# 3) partial failure (AC-03)
# 3a) g1_damaged_page.pdf: mixed_scanned_lecture.pdf whose page 2 (the scan) has a damaged content stream (a flate
#     stream with an invalid header) — viewers draw nothing there; pages 1 and 3 are intact digital pages.
w = PdfWriter(clone_from=os.path.join(GOLDEN, 'mixed_scanned_lecture.pdf'))
contents = w.pages[1]['/Contents'].get_object()
if isinstance(contents, ArrayObject):
    contents = contents[0].get_object()
contents[NameObject('/Filter')] = NameObject('/FlateDecode')
contents._data = bytes([0xFF, 0xFE]) + bytes((i * 37 + 11) % 256 for i in range(798))
w.add_metadata({'/Title': 'G1 damaged page (TEST FIXTURE)'})
with open(os.path.join(HERE, 'g1_damaged_page.pdf'), 'wb') as f:
    w.write(f)

# 3b) g1_partial_images.zip: an ordered image set whose SECOND picture is truncated (a damaged photo): OCR cannot
#     read it; the first (scan) and third (flowchart) stay readable.
import zipfile
scan_png = open(os.path.join(GOLDEN, 'scanned_page.png'), 'rb').read()
flow_png = open(os.path.join(GOLDEN, 'flowchart.png'), 'rb').read()
with zipfile.ZipFile(os.path.join(HERE, 'g1_partial_images.zip'), 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for name, data in (('slides/01_scan.png', scan_png), ('slides/02_damaged.png', scan_png[: len(scan_png) // 3]), ('slides/03_flowchart.png', flow_png)):
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, data)

print('ok')
