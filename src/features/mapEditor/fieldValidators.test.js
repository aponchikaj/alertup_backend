import {
  parseTags,
  parseDirection,
  parseRank,
  parseVisibility,
  parseExternalId,
  parsePoiNames,
  buildSearchText,
} from './fieldValidators.js';

describe('parseTags', () => {
  test('trims, lowercases and de-duplicates', () => {
    const result = parseTags([' Stroller ', 'STROLLER', 'quiet', '']);
    expect(result).toEqual({ ok: true, value: ['stroller', 'quiet'] });
  });

  test('null clears the list', () => {
    expect(parseTags(null)).toEqual({ ok: true, value: [] });
  });

  test('rejects more than 20 tags', () => {
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const result = parseTags(many);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/20/);
  });

  test('rejects a non-array and non-string entries', () => {
    expect(parseTags('stroller').ok).toBe(false);
    expect(parseTags([1]).ok).toBe(false);
  });
});

describe('parseDirection / parseRank / parseVisibility', () => {
  test('accept their enum members, case-insensitively', () => {
    expect(parseDirection('forward')).toEqual({ ok: true, value: 'FORWARD' });
    expect(parseRank('SECONDARY')).toEqual({ ok: true, value: 'SECONDARY' });
    expect(parseVisibility(' emergency_only ')).toEqual({
      ok: true,
      value: 'EMERGENCY_ONLY',
    });
  });

  test('reject anything else with the allowed values in the message', () => {
    const dir = parseDirection('SIDEWAYS');
    expect(dir.ok).toBe(false);
    expect(dir.error).toMatch(/BOTH/);
    expect(parseRank(null).ok).toBe(false);
    expect(parseVisibility(7).ok).toBe(false);
  });
});

describe('parseExternalId', () => {
  test('trims and keeps the code as typed', () => {
    expect(parseExternalId('  BOOTH-12 ')).toEqual({ ok: true, value: 'BOOTH-12' });
  });

  test('null and empty string clear it', () => {
    expect(parseExternalId(null)).toEqual({ ok: true, value: null });
    expect(parseExternalId('   ')).toEqual({ ok: true, value: null });
  });

  test('rejects longer than 64 characters and non-strings', () => {
    const long = parseExternalId('x'.repeat(65));
    expect(long.ok).toBe(false);
    expect(long.error).toMatch(/64/);
    expect(parseExternalId(12).ok).toBe(false);
  });
});

describe('parsePoiNames', () => {
  test('keeps en, ka and de-duplicated aliases', () => {
    const result = parsePoiNames({
      en: ' Coffee House ',
      ka: ' ყავის სახლი ',
      aliases: ['Cafe', 'cafe', ' Coffee '],
    });
    expect(result).toEqual({
      ok: true,
      value: { en: 'Coffee House', ka: 'ყავის სახლი', aliases: ['Cafe', 'Coffee'] },
    });
  });

  test('null clears, and an all-empty object is treated as cleared', () => {
    expect(parsePoiNames(null)).toEqual({ ok: true, value: null });
    expect(parsePoiNames({ en: '', aliases: [] })).toEqual({ ok: true, value: null });
  });

  test('rejects unknown keys, non-string values and more than 20 aliases', () => {
    expect(parsePoiNames({ fr: 'Cafe' }).ok).toBe(false);
    expect(parsePoiNames({ en: 5 }).ok).toBe(false);
    expect(parsePoiNames({ aliases: 'Cafe' }).ok).toBe(false);
    const many = parsePoiNames({
      aliases: Array.from({ length: 21 }, (_, i) => `a${i}`),
    });
    expect(many.ok).toBe(false);
    expect(many.error).toMatch(/20/);
  });

  test('rejects a non-object', () => {
    expect(parsePoiNames(['Cafe']).ok).toBe(false);
    expect(parsePoiNames('Cafe').ok).toBe(false);
  });
});

describe('buildSearchText', () => {
  test('lowercases name, keywords, aliases and translated names into one blob', () => {
    const text = buildSearchText({
      name: 'Coffee House',
      keywords: ['Espresso'],
      names: { en: 'Coffee House', ka: 'ყავის სახლი', aliases: ['Cafe'] },
    });
    expect(text).toBe('coffee house espresso ყავის სახლი cafe');
  });

  test('survives missing keywords and names', () => {
    expect(buildSearchText({ name: 'Lift' })).toBe('lift');
  });
});
