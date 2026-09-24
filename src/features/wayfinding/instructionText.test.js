import { LOCALES, TEMPLATES, formatDistance, render } from './instructionText.js';

describe('TEMPLATES', () => {
  /*
   * The backend's stand-in for the frontend's `tsc -b`, which proves `ka.ts`
   * mirrors `en.ts` at compile time. There is no type system here, and
   * `render()` falls back `ka -> en` for a missing key, so a Georgian template
   * nobody wrote does not throw and does not blank — it silently shows English
   * to a Georgian-speaking visitor, possibly mid-evacuation. This test is the
   * only thing standing between that and production.
   *
   * Checked in BOTH directions and reported PER LOCALE, so the failure names
   * the offending key and the table it is missing from, rather than printing
   * two 20-key arrays to diff by eye. Written over LOCALES rather than over
   * en/ka by hand, so a third language is covered the day it is added.
   */
  test('every locale defines exactly the same keys', () => {
    const everyKey = [
      ...new Set(LOCALES.flatMap((locale) => Object.keys(TEMPLATES[locale]))),
    ].sort();

    const missing = Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        everyKey.filter((key) => !Object.hasOwn(TEMPLATES[locale], key)),
      ])
    );

    expect(missing).toEqual(Object.fromEntries(LOCALES.map((locale) => [locale, []])));
  });

  /*
   * Key parity alone cannot tell an untranslated template from a translated
   * one: `ka.arrive = 'You have arrived'` has the key and reads as English.
   * Every Georgian template must therefore contain Georgian script AND differ
   * from its English counterpart. (`LOCALES[0]` is the reference language;
   * only the others are held to this.)
   */
  test('every non-English template is actually translated', () => {
    const [reference, ...translated] = LOCALES;
    const untranslated = [];

    for (const locale of translated) {
      for (const [key, value] of Object.entries(TEMPLATES[locale])) {
        if (!/[\u10A0-\u10FF]/.test(value)) untranslated.push(`${locale}.${key} (no Georgian script)`);
        else if (value === TEMPLATES[reference][key]) untranslated.push(`${locale}.${key} (identical to ${reference})`);
      }
    }

    expect(untranslated).toEqual([]);
  });

  test('every template is a non-empty string', () => {
    for (const locale of LOCALES) {
      const empty = Object.entries(TEMPLATES[locale])
        .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
        .map(([key]) => `${locale}.${key}`);
      expect(empty).toEqual([]);
    }
  });
});

describe('render', () => {
  test('interpolates named vars', () => {
    expect(render('en', 'turn', { side: 'right' })).toBe('Turn right');
  });

  test('renders the same key in Georgian', () => {
    expect(render('ka', 'turn', { side: 'მარჯვნივ' })).toBe('შეუხვიე მარჯვნივ');
  });

  test('falls back to en for an unknown locale', () => {
    expect(render('fr', 'arrive')).toBe(TEMPLATES.en.arrive);
  });

  test('leaves an unknown key as null rather than printing the key', () => {
    expect(render('en', 'no_such_key')).toBeNull();
  });

  test('drops a placeholder with no value instead of printing the braces', () => {
    expect(render('en', 'rel_at', {})).toBe('at');
  });
});

describe('formatDistance', () => {
  test('under 10 m counts in single metres', () => {
    expect(formatDistance(3)).toBe('3');
    expect(formatDistance(7.4)).toBe('7');
    expect(formatDistance(9.4)).toBe('9');
  });

  test('10 m and over rounds to the nearest 5', () => {
    expect(formatDistance(10)).toBe('10');
    expect(formatDistance(12)).toBe('10');
    expect(formatDistance(13)).toBe('15');
    expect(formatDistance(147)).toBe('145');
  });

  test('never reports a negative or non-finite distance', () => {
    expect(formatDistance(-5)).toBe('0');
    expect(formatDistance(NaN)).toBe('0');
    expect(formatDistance(undefined)).toBe('0');
  });
});
