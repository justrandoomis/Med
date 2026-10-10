// Regenerates the derived acceptance TEST FIXTURES for G3 (AC-08, AC-09, AC-13).
//   node fixtures/acceptance/make_g3_fixtures.mjs        (needs Chromium at /opt/pw-browsers/chromium via @playwright/test)
// Synthetic structural documents only — never a medical reference, never a patient image. The pictures are drawn
// shapes labelled «TEST FIXTURE · synthetic»; the captions are what the application reads. The outputs are committed;
// tests never run this script.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTICE = 'TEST FIXTURE — synthetic structural document for automated tests. Not a medical reference.';
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });

async function png(html, selector, { width = 1100, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:'DejaVu Sans',sans-serif;background:#fff;color:#111}</style></head><body>${html}</body></html>`);
  const buf = await (await page.$(selector)).screenshot({ type: 'png' });
  await page.close();
  return buf;
}

// ───────── AC-09: an «image atlas» whose figures differ in modality / region / finding / origin ─────────
// A drawn placeholder per figure (dark «radiograph-like» field, light «photo-like» field or a line drawing). The caption
// under each picture is the only thing that says what it is — exactly what the AC-09 gate must check.
function picture(kind, tag) {
  const label = `<text x="260" y="300" text-anchor="middle" style="font:16px 'DejaVu Sans';fill:${kind === 'drawing' ? '#333' : '#ddd'}">TEST FIXTURE · synthetic ${tag}</text>`;
  if (kind === 'drawing') {
    return `<svg id="p" xmlns="http://www.w3.org/2000/svg" width="520" height="320" style="background:#fff"><rect x="10" y="10" width="500" height="300" fill="none" stroke="#333" stroke-width="3"/><ellipse cx="180" cy="150" rx="80" ry="110" fill="none" stroke="#333" stroke-width="3"/><ellipse cx="340" cy="150" rx="80" ry="110" fill="none" stroke="#333" stroke-width="3" stroke-dasharray="8 6"/><path d="M420 60 L470 40" stroke="#333" stroke-width="3"/>${label}</svg>`;
  }
  const bg = kind === 'dark' ? '#111' : '#cfc7bb';
  const fg = kind === 'dark' ? '#777' : '#8d7f6f';
  return `<svg id="p" xmlns="http://www.w3.org/2000/svg" width="520" height="320" style="background:${bg}"><rect width="520" height="320" fill="${bg}"/><ellipse cx="180" cy="150" rx="85" ry="115" fill="${fg}"/><ellipse cx="340" cy="150" rx="85" ry="115" fill="${fg}" opacity="0.6"/><rect x="250" y="40" width="20" height="230" fill="${fg}"/>${label}</svg>`;
}

const FIGURES = [
  // page 1
  { kind: 'dark', tag: 'radiograph', caption: 'Figure 1: Chest X-ray showing a right-sided pneumothorax (synthetic image).' },
  { kind: 'dark', tag: 'CT slice', caption: 'Figure 2: CT chest showing a right-sided pneumothorax (synthetic image).' },
  // page 2
  { kind: 'dark', tag: 'radiograph', caption: 'Figure 3: Abdominal X-ray showing dilated small bowel loops (synthetic image).' },
  { kind: 'dark', tag: 'radiograph', caption: 'Figure 4: Chest X-ray: no evidence of pneumothorax (synthetic image).' },
  // page 3
  { kind: 'drawing', tag: 'drawing', caption: "Figure 5: Chest X-ray appearance of a tension pneumothorax (artist's illustration)." },
  { kind: 'light', tag: 'ultrasound', caption: 'Figure 6: Ultrasound of the chest showing the lung point of a pneumothorax (synthetic image).' },
  // page 4
  { kind: 'dark', tag: 'radiograph', caption: 'الشكل 7: صورة أشعة سينية للصدر تُظهر استرواح الصدر في الجهة اليمنى (صورة اصطناعية).', rtl: true },
  { kind: 'dark', tag: 'radiograph', caption: 'Figure 8: Follow-up chest X-ray after chest drain insertion: resolved pneumothorax (synthetic image).' },
  // page 5
  { kind: 'dark', tag: 'radiograph', caption: 'Figure 9: Chest X-ray of a child showing a left pneumothorax (synthetic image).' },
  { kind: 'dark', tag: 'composite', caption: 'Figure 10: Chest X-ray and CT side by side; the CT shows a small pneumothorax (synthetic image).' },
];

const pictures = [];
for (const f of FIGURES) pictures.push((await png(picture(f.kind, f.tag), '#p')).toString('base64'));

const pages = [];
for (let i = 0; i < FIGURES.length; i += 2) {
  const figs = FIGURES.slice(i, i + 2)
    .map((f, j) => `<figure><img src="data:image/png;base64,${pictures[i + j]}" width="390" height="240" alt=""><figcaption dir="${f.rtl ? 'rtl' : 'ltr'}">${f.caption}</figcaption></figure>`)
    .join('');
  pages.push(`<section class="pg">${i === 0 ? '<h1>Chest imaging atlas (TEST FIXTURE)</h1>' : ''}<p class="n">${NOTICE}</p>${figs}<p class="f">${i / 2 + 1}</p></section>`);
}
{
  const page = await browser.newPage();
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: A4; margin: 18mm 16mm; }
      body { font-family: 'DejaVu Sans', sans-serif; color: #111; }
      .pg { page-break-after: always; position: relative; height: 255mm; }
      .pg:last-child { page-break-after: auto; }
      h1 { font-size: 20px; margin: 0 0 6px; }
      .n { font-size: 10px; color: #555; margin: 0 0 14px; }
      figure { margin: 0 0 26px; }
      figcaption { font-size: 13px; margin-top: 8px; }
      .f { position: absolute; bottom: 0; left: 0; right: 0; text-align: center; font-size: 11px; }
    </style></head><body>${pages.join('')}</body></html>`,
  );
  writeFileSync(path.join(HERE, 'g3_image_atlas.pdf'), await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  await page.close();
}

// ───────── AC-13: single question photos with a hand-drawn mark ─────────
const circle = (left) => `<span style="position:absolute;left:${left}px;top:-6px;width:70px;height:56px;border:4px solid #c0392b;border-radius:50%;transform:rotate(-8deg)"></span>`;

// a circle around B on a photo that ALSO prints its own answer line (C): the printed key is the key; the circle is a mark
writeFileSync(
  path.join(HERE, 'g3_photo_circled_with_key.png'),
  await png(
    `<div id="q" style="width:1000px;padding:60px;background:#f7f5ef;font-size:30px;line-height:1.7;position:relative">
       <div style="font-size:18px;color:#555">${NOTICE}</div>
       <p><b>4.</b> Which investigation is preferred in adults when the diagnosis remains uncertain?</p>
       <p>A. Plain abdominal film</p>
       <p style="position:relative">B. Ultrasound${circle(-18)}</p>
       <p>C. CT abdomen</p><p>D. Barium enema</p>
       <p>Answer: C</p>
     </div>`,
    '#q',
  ),
);

// an Arabic question photo (أ ب ج د) with a circle around «ب» and no key
writeFileSync(
  path.join(HERE, 'g3_photo_circled_ar.png'),
  await png(
    `<div id="q" dir="rtl" style="width:1000px;padding:60px;background:#f7f5ef;font-size:30px;line-height:1.7;position:relative">
       <div dir="ltr" style="font-size:18px;color:#555">${NOTICE}</div>
       <p><b>5.</b> ما الفحص الأولي عند الشك بحصى المرارة؟</p>
       <p>أ. التصوير المقطعي</p>
       <p style="position:relative">ب. الأمواج فوق الصوتية<span style="position:absolute;right:-18px;top:-6px;width:70px;height:56px;border:4px solid #c0392b;border-radius:50%;transform:rotate(8deg)"></span></p>
       <p>ج. الرنين المغناطيسي</p><p>د. التنظير</p>
     </div>`,
    '#q',
  ),
);

await browser.close();
console.log('written: g3_image_atlas.pdf, g3_photo_circled_with_key.png, g3_photo_circled_ar.png');
