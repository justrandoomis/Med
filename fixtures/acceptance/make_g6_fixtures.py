# Regenerates the derived acceptance TEST FIXTURES of G6 (AC-21) from fixtures/golden.
#   python3 -I fixtures/acceptance/make_g6_fixtures.py     (needs pypdf)
# Synthetic structural documents only — never a medical reference. The outputs are committed; tests never run this.
import os
from pypdf import PdfReader, PdfWriter

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, '..', 'golden')

# g6_rotated_page.pdf (AC-21): the appendicitis lecture whose FIRST page carries an intrinsic /Rotate 90 — the page is
# stored portrait but every viewer shows it turned a quarter clockwise. Ink written over a word of that page must stay
# on the word (the reader composes /Rotate with its own view rotation; the ink is stored in unrotated page space).
app = PdfReader(os.path.join(GOLDEN, 'lecture_appendicitis.pdf'))
w = PdfWriter()
for i, p in enumerate(app.pages):
    w.add_page(p)
    if i == 0:
        w.pages[0].rotate(90)
w.add_metadata({'/Title': 'G6 rotated page (TEST FIXTURE)'})
with open(os.path.join(HERE, 'g6_rotated_page.pdf'), 'wb') as f:
    w.write(f)
print('wrote g6_rotated_page.pdf')
