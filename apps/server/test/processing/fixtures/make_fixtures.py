# Regenerates the derived TEST FIXTURES in this folder from fixtures/golden (synthetic documents).
#   python3 -I make_fixtures.py   (needs pypdf + reportlab; LibreOffice `soffice` for arabic_lam_alef.pdf)
# The outputs are committed; tests never run this script.
import os, subprocess, sys, tempfile
from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import NameObject, NumberObject, RectangleObject

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, '..', '..', '..', '..', '..', 'fixtures', 'golden')


def rotate_content(page, angle):
    """Rotate the page CONTENT by -angle and set /Rotate angle: the page DISPLAYS upright, but its
    unrotated user space (and the text/image matrices pdfjs reports) is turned — like a sideways scan."""
    w = float(page.mediabox.width)
    h = float(page.mediabox.height)
    if angle == 90:
        page.add_transformation(Transformation((0, 1, -1, 0, h, 0)))
        page.mediabox = RectangleObject([0, 0, h, w])
    elif angle == 270:
        page.add_transformation(Transformation((0, -1, 1, 0, 0, w)))
        page.mediabox = RectangleObject([0, 0, h, w])
    elif angle == 180:
        page.add_transformation(Transformation((-1, 0, 0, -1, w, h)))
    page.cropbox = RectangleObject(list(page.mediabox))
    page[NameObject('/Rotate')] = NumberObject(angle)


# 1) rotated_lecture.pdf: lecture_appendicitis.pdf with /Rotate 90, 270, 180, 90 (labels 11-14 kept)
w = PdfWriter(clone_from=os.path.join(GOLDEN, 'lecture_appendicitis.pdf'))
for page, angle in zip(w.pages, (90, 270, 180, 90)):
    rotate_content(page, angle)
w.write(os.path.join(HERE, 'rotated_lecture.pdf'))

# 2) rotated_cropped_scan.pdf: the image-only page 2 of mixed_scanned_lecture.pdf, /Rotate 90 and a
#    CropBox smaller than the MediaBox (30 pt cut on the long sides, 20 pt on the short sides)
w = PdfWriter(clone_from=os.path.join(GOLDEN, 'mixed_scanned_lecture.pdf'))
w.remove_page(2)
w.remove_page(0)
page = w.pages[0]
rotate_content(page, 90)
mb = [float(v) for v in page.mediabox]
page.cropbox = RectangleObject([mb[0] + 20, mb[1] + 30, mb[2] - 20, mb[3] - 30])
w.write(os.path.join(HERE, 'rotated_cropped_scan.pdf'))

# 3) arabic_lam_alef.pdf: LibreOffice PDF export reverses lam-alef ligatures in the text layer
html = """<html><head><meta charset="utf-8"></head><body dir="rtl">
<p>TEST FIXTURE — synthetic structural document for automated tests. Not a medical reference.</p>
<p>يسبب الالتهاب الانسداد في الأمعاء والاختبار بالالتهاب العلاج.</p>
</body></html>"""
with tempfile.TemporaryDirectory() as tmp:
    src = os.path.join(tmp, 'arabic_lam_alef.html')
    with open(src, 'w', encoding='utf-8') as f:
        f.write(html)
    subprocess.run(['soffice', f'-env:UserInstallation=file://{tmp}/profile', '--headless', '--norestore',
                    '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', tmp, src], check=True, timeout=180,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(os.path.join(tmp, 'arabic_lam_alef.pdf'), 'rb') as f:
        data = f.read()
with open(os.path.join(HERE, 'arabic_lam_alef.pdf'), 'wb') as f:
    f.write(data)
# 4) large_figure.pdf: page 1 = a diagram covering ~64 % of a digital page with its caption;
#    page 2 = a full-page background picture with body text on top of it (not a figure)
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
W, H = A4
c = canvas.Canvas(os.path.join(HERE, 'large_figure.pdf'), pagesize=A4)
c.setFont('Helvetica-Bold', 18)
c.drawString(60, H - 80, 'Pathway overview')
c.setFont('Helvetica', 11)
c.drawString(60, H - 110, 'TEST FIXTURE. The diagram below summarises the pathway of this synthetic document.')
c.drawImage(os.path.join(GOLDEN, 'flowchart.png'), 50, 120, width=W - 100, height=H - 260)
c.drawString(60, 95, 'Figure 3: Synthetic pathway (TEST FIXTURE).')
c.showPage()
c.drawImage(os.path.join(GOLDEN, 'low_quality_scan.png'), 0, 0, width=W, height=H)
c.setFont('Helvetica', 12)
for i in range(10):
    c.drawString(60, H - 100 - 16 * i, f'Body text line {i} printed on top of a full page background picture (TEST FIXTURE).')
c.save()
print('ok')
