# Regenerates the synthetic TEST FIXTURES of the questions tests (structure only — not medical references).
#   python3 -I make_fixtures.py        (needs reportlab)
# The outputs are committed; tests never run this script.
#   conflicting_keys.pdf : one section, two printed answer-key TABLES that disagree on question 2 (AC-15)
#   ambiguous_keys.pdf   : sections A and B both numbered from 1, ONE trailing key without section labels (AC-12:
#                          must stay unbound — never applied by number alone)
#   lookalike_x.pdf / lookalike_y.pdf : (review) the same words except «<» vs «>», and a picture question with the same
#                          words — never merged as exact duplicates (§36)
#   replace_v1.pdf / replace_v2.pdf   : (review) a question source and its corrected re-issue: Q1 unchanged with its key
#                          corrected B → C, Q2 reworded with a new key (§18 replacement)
#   python3 -I make_fixtures.py lookalike_x.pdf ...   regenerates only the named files
import os
import sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.lib import colors

HERE = os.path.dirname(os.path.abspath(__file__))
styles = getSampleStyleSheet()
P = lambda t: Paragraph(t, styles['Normal'])
H = lambda t: Paragraph(t, styles['Heading2'])
FIX = 'TEST FIXTURE - synthetic structural document for automated tests. Not a medical reference.'


def key_table(rows):
    t = Table([['Question', 'Answer']] + rows, colWidths=[90, 90])
    t.setStyle(TableStyle([('GRID', (0, 0), (-1, -1), 0.8, colors.black), ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold')]))
    return t


ONLY = set(sys.argv[1:])


def build(name, story):
    if ONLY and name not in ONLY:
        return
    doc = SimpleDocTemplate(os.path.join(HERE, name), pagesize=A4, title=name)
    doc.build(story)


build('conflicting_keys.pdf', [
    H('Key Conflict Bank'), P(FIX), Spacer(1, 8),
    H('Section A'),
    P('1. Which imaging test is first-line in suspected gallstones?'),
    P('A. Plain X-ray'), P('B. Ultrasound'), P('C. MRI'), P('D. PET scan'),
    P('2. Which sign is associated with acute cholecystitis?'),
    P('A. Psoas sign'), P('B. Obturator sign'), P('C. Murphy sign'), P('D. Kernig sign'),
    Spacer(1, 12), H('Answer Key'), key_table([['1', 'B'], ['2', 'C']]),
    Spacer(1, 12), H('Answer Key'), key_table([['1', 'B'], ['2', 'D']]),
])

build('ambiguous_keys.pdf', [
    H('Ambiguous Key Bank'), P(FIX), Spacer(1, 8),
    H('Section A'),
    P('1. Which vitamin deficiency causes scurvy?'), P('A. Vitamin A'), P('B. Vitamin C'), P('C. Vitamin D'), P('D. Vitamin K'),
    H('Section B'),
    P('1. Which organ produces insulin?'), P('A. Liver'), P('B. Spleen'), P('C. Pancreas'), P('D. Kidney'),
    Spacer(1, 12), H('Answers'), P('1. B 2. C'),
])

build('lookalike_x.pdf', [
    H('Lookalike Bank X'), P(FIX), Spacer(1, 8),
    P('1. A patient has a serum sodium &lt; 120 mmol/L. Which is the most appropriate first step?'),
    P('A. Fluid restriction'), P('B. Hypertonic saline'), P('C. Observation'), P('D. Oral salt tablets'),
    P('2. Which structure is shown in the image below?'),
    P('A. Liver'), P('B. Spleen'), P('C. Kidney'), P('D. Pancreas'),
    Spacer(1, 12), H('Answers'), P('1. B 2. A'),
])

build('lookalike_y.pdf', [
    H('Lookalike Bank Y'), P(FIX), Spacer(1, 8),
    P('1. A patient has a serum sodium &gt; 120 mmol/L. Which is the most appropriate first step?'),
    P('A. Fluid restriction'), P('B. Hypertonic saline'), P('C. Observation'), P('D. Oral salt tablets'),
    P('2. Which structure is shown in the image below?'),
    P('A. Liver'), P('B. Spleen'), P('C. Kidney'), P('D. Pancreas'),
    Spacer(1, 12), H('Answers'), P('1. B 2. C'),
])

build('replace_v1.pdf', [
    H('Replace Bank'), P(FIX), Spacer(1, 8),
    P('1. Which sign is associated with acute cholecystitis?'),
    P('A. Psoas sign'), P('B. Obturator sign'), P('C. Murphy sign'), P('D. Kernig sign'),
    P('2. Which test is first-line for gallstones?'),
    P('A. Plain X-ray'), P('B. Ultrasound'), P('C. MRI'), P('D. PET scan'),
    Spacer(1, 12), H('Answers'), P('1. B 2. C'),
])

build('replace_v2.pdf', [
    H('Replace Bank'), P(FIX), Spacer(1, 8),
    P('1. Which sign is associated with acute cholecystitis?'),
    P('A. Psoas sign'), P('B. Obturator sign'), P('C. Murphy sign'), P('D. Kernig sign'),
    P('2. Which imaging test is first-line for suspected gallstones?'),
    P('A. Plain X-ray'), P('B. Ultrasound'), P('C. MRI'), P('D. PET scan'),
    Spacer(1, 12), H('Answers'), P('1. C 2. B'),
])
