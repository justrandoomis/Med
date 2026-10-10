// Pure media logic: WebVTT / SRT parsing (incl. Arabic, BOM, CRLF, NOTE/STYLE blocks, cue settings, voice tags,
// entities, bidi controls, invalid cues with reasons) and the AC-09 image candidate validator (modality, region,
// caption, age group, origin; unknown never accepted).
import { describe, expect, it } from 'vitest';
import { hasBidiControls } from '@medlevo/shared';
import { detectFormat, parseSubtitles, parseTimestamp, SubtitleError } from '../../src/modules/media/subtitles';
import { normalizeModality, normalizeRegion, validateImageCandidate } from '../../src/modules/media/validate-image';
import { answerKey } from '../../src/modules/media/quiz';

describe('subtitle parsing', () => {
  it('parses WebVTT with BOM, CRLF, header metadata, NOTE / STYLE blocks, identifiers, settings, voice tags, entities and Arabic', () => {
    const vtt = [
      '﻿WEBVTT - lecture 3',
      'Kind: captions',
      '',
      'NOTE this is a comment',
      'spanning two lines',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      'intro',
      '00:00:01.000 --> 00:00:04.500 align:start position:10%',
      '<v Dr. Salma>يبدأ الألم حول السرة</v>',
      '',
      '00:05.000 --> 00:07.250',
      '<i>then moves</i> to the <b>RIF</b> &amp; McBurney&#39;s point',
      '',
      '00:00:08.000 --> 00:00:09.000',
      '‏العدد أعلى من 11 ×10⁹/L‎',
      '',
    ].join('\r\n');
    expect(detectFormat(vtt)).toBe('vtt');
    const r = parseSubtitles(vtt);
    expect(r.format).toBe('vtt');
    expect(r.skipped).toEqual([]);
    expect(r.cues.map((c) => [c.start_ms, c.end_ms])).toEqual([
      [1000, 4500],
      [5000, 7250],
      [8000, 9000],
    ]);
    expect(r.cues[0]!.text).toBe('يبدأ الألم حول السرة');
    expect(r.cues[0]!.speaker).toBe('Dr. Salma'); // named by the file — never guessed
    expect(r.cues[1]!.speaker).toBeNull();
    expect(r.cues[1]!.text).toBe("then moves to the RIF & McBurney's point");
    expect(r.cues[2]!.text).toBe('العدد أعلى من 11 ×10⁹/L');
    expect(hasBidiControls(r.cues[2]!.text)).toBe(false);
  });

  it('parses SRT with comma milliseconds, multi-line Arabic text, override tags; skips invalid cues with reasons', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      '{\\an8}<i>Acute appendicitis</i>',
      'التهاب الزائدة',
      '',
      '2',
      '00:00:05,000 --> 00:00:04,000',
      'backwards',
      '',
      '3',
      '00:00:06,5 --> 00:00:07,000',
      '',
      '4',
      'not a timing line',
      'text',
      '',
      '5',
      '01:00:00,000 --> 01:00:02,000',
      'one hour in',
    ].join('\n');
    expect(detectFormat(srt)).toBe('srt');
    const r = parseSubtitles(srt, 'auto');
    expect(r.cues.map((c) => c.text)).toEqual(['Acute appendicitis التهاب الزائدة', 'one hour in']);
    expect(r.cues[1]!.start_ms).toBe(3_600_000);
    expect(r.skipped.map((s) => s.cue)).toEqual([2, 3, 4]);
    expect(r.skipped[0]!.reason_ar).toContain('ليست بعد بدايته');
    expect(r.skipped[1]!.reason_ar).toContain('بلا نص');
    expect(r.skipped[2]!.reason_ar).toContain('توقيت');
  });

  it('rejects unknown formats and malformed timestamps', () => {
    expect(() => parseSubtitles('hello world')).toThrow(SubtitleError);
    expect(() => parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nx', 'vtt')).toThrow(/WEBVTT/);
    expect(parseTimestamp('00:61:00.000')).toBeNull();
    expect(parseTimestamp('12:05.5')).toBe(725_500);
  });
});

describe('quiz answer keys', () => {
  it('normalizes Arabic variants, the article and punctuation', () => {
    expect(answerKey('الاسترواح الصدري')).toBe(answerKey('استرواح صدري'));
    expect(answerKey('Pneumothorax!')).toBe('pneumothorax');
    expect(answerKey('الرئة')).toBe(answerKey('رئه'));
  });
});

describe('AC-09 image candidate validation', () => {
  const request = { modality: 'X-ray', anatomic_region: 'chest', finding_terms: ['pneumothorax', 'استرواح الصدر'], require_real_example: true };

  it('accepts a candidate that matches modality, region and caption', () => {
    const v = validateImageCandidate({ modality: 'radiograph', anatomic_region: 'thorax', caption: 'Chest X-ray showing a right pneumothorax.', origin: 'source' }, request);
    expect(v.accepted).toBe(true);
    expect(v.reasons_ar).toEqual([]);
  });

  it('excludes a different modality (CT for an X-ray request) with the reason', () => {
    const v = validateImageCandidate({ modality: 'CT', anatomic_region: 'chest', caption: 'CT chest: right pneumothorax', origin: 'external' }, request);
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.check === 'modality')!.passed).toBe(false);
    expect(v.reasons_ar.join(' ')).toContain('لا يطابق');
  });

  it('excludes a different anatomic region', () => {
    const v = validateImageCandidate({ modality: 'x-ray', anatomic_region: 'knee', caption: 'Knee radiograph with pneumothorax mentioned in the report', origin: 'external' }, request);
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.check === 'anatomic_region')!.passed).toBe(false);
  });

  it('accepts a part of the requested region (lung ⊂ chest); infers modality and region from the caption', () => {
    const v = validateImageCandidate({ caption: 'Plain film of the lung: pneumothorax (arrow).', origin: 'source' }, request);
    expect(v.accepted).toBe(true);
    expect(normalizeRegion('الرئة')).toBe('lung');
    expect(normalizeModality('صورة شعاعية')).toBe('xray');
  });

  it('a caption that only names the topic, negates the finding, or is missing → excluded', () => {
    expect(validateImageCandidate({ modality: 'x-ray', anatomic_region: 'chest', caption: 'Normal chest X-ray', origin: 'external' }, request).accepted).toBe(false);
    const neg = validateImageCandidate({ modality: 'x-ray', anatomic_region: 'chest', caption: 'Chest X-ray: no pneumothorax', origin: 'external' }, request);
    expect(neg.accepted).toBe(false);
    expect(neg.reasons_ar.join(' ')).toContain('منفية');
    expect(validateImageCandidate({ modality: 'x-ray', anatomic_region: 'chest', caption: null, origin: 'external' }, request).accepted).toBe(false);
  });

  it('unknown modality / region is never accepted', () => {
    const v = validateImageCandidate({ caption: 'pneumothorax', origin: 'external' }, request);
    expect(v.accepted).toBe(false);
    expect(v.reasons_ar.join(' ')).toContain('لا يمكن التحقق');
  });

  it('checks the age group when the request names one (metadata or caption)', () => {
    const req = { ...request, age_group: 'child' as const };
    expect(validateImageCandidate({ modality: 'x-ray', anatomic_region: 'chest', caption: 'Chest X-ray of a child with pneumothorax', origin: 'source' }, req).accepted).toBe(true);
    const adult = validateImageCandidate({ modality: 'x-ray', anatomic_region: 'chest', caption: 'Pneumothorax in an elderly patient, chest X-ray', origin: 'source' }, req);
    expect(adult.accepted).toBe(false);
    expect(adult.checks.find((c) => c.check === 'age_group')!.passed).toBe(false);
    expect(validateImageCandidate({ modality: 'x-ray', anatomic_region: 'chest', caption: 'Chest X-ray: pneumothorax', origin: 'source' }, req).accepted).toBe(false);
  });

  it('a generated illustration is never the requested real example', () => {
    const v = validateImageCandidate({ modality: 'x-ray', anatomic_region: 'chest', caption: 'Illustration of a pneumothorax on a chest X-ray', origin: 'generated' }, request);
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.check === 'origin')!.reason_ar).toContain('مولّدة');
  });

  // review regression: the 2-token negation window let common report phrasings through as examples of the finding
  it('a caption that denies or excludes the finding anywhere in its sentence is never an example (AC-09)', () => {
    const denied = [
      'Chest X-ray: no evidence of pneumothorax.',
      'Chest X-ray showing no signs of pneumothorax',
      'Chest X-ray, negative for pneumothorax',
      'Chest X-ray: pneumothorax was ruled out',
      'Chest X-ray: pneumothorax excluded',
      'Chest X-ray: absence of pneumothorax',
      'Chest X-ray taken to rule out pneumothorax',
      'Chest X-ray: no consolidation, pneumothorax or effusion',
      'Chest X-ray: pneumothorax not seen',
      'صورة شعاعية للصدر: لا يوجد دليل على استرواح الصدر',
      'صورة شعاعية للصدر: استرواح الصدر غير موجود',
    ];
    for (const caption of denied) {
      const v = validateImageCandidate({ modality: 'x-ray', anatomic_region: 'chest', caption, origin: 'source' }, request);
      expect(v.accepted, caption).toBe(false);
      expect(v.checks.find((c) => c.check === 'caption_match')!.passed, caption).toBe(false);
    }
    // a denial of something else, or of the finding in another sentence, does not hide a stated finding
    for (const caption of ['Chest X-ray showing pneumothorax, not pneumonia', 'Chest X-ray: no fracture. Large right pneumothorax.', 'Chest X-ray: right pneumothorax with no mediastinal shift']) {
      expect(validateImageCandidate({ modality: 'x-ray', anatomic_region: 'chest', caption, origin: 'source' }, request).accepted, caption).toBe(true);
    }
  });

  it('an educational drawing from a source is not a real radiograph, whatever its caption names (AC-09)', () => {
    const v = validateImageCandidate({ caption: 'Chest X-ray (schematic) showing a pneumothorax', image_kind: 'educational_drawing', origin: 'source' }, request);
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.check === 'origin')!.reason_ar).toContain('رسم تعليمي');
    // a drawing is fine when a drawing was asked for
    const asked = validateImageCandidate({ caption: 'Diagram of the chest: pneumothorax', image_kind: 'diagram', origin: 'source' }, { ...request, modality: 'diagram' });
    expect(asked.accepted).toBe(true);
  });

  it('Arabic request and caption', () => {
    const v = validateImageCandidate(
      { modality: 'أشعة سينية', anatomic_region: 'الصدر', caption: 'صورة شعاعية للصدر تُظهر استرواح الصدر في الجهة اليمنى', origin: 'source' },
      { modality: 'xray', anatomic_region: 'الصدر', finding_terms: ['استرواح الصدر'], require_real_example: true },
    );
    expect(v.accepted).toBe(true);
  });
});
