import { normalizeDrawing, DRAWING_LIMITS } from './drawingSchema.js';

/* Floor.drawing is authored by a building editor and rendered to anonymous
   visitors, so these cover the two things that matter: nothing dangerous
   survives normalization, and one bad shape never costs the user the rest of
   the floor they drew. */

const drawingOf = (...shapes) => ({ version: 1, shapes });

describe('normalizeDrawing', () => {
  it('treats null/undefined/empty as "no drawing" rather than an error', () => {
    for (const value of [null, undefined, '']) {
      expect(normalizeDrawing(value)).toEqual({ ok: true, drawing: null });
    }
  });

  it('parses a JSON string body (multipart sends strings)', () => {
    const result = normalizeDrawing(
      JSON.stringify(drawingOf({ id: 'a', kind: 'room', x: 1, y: 2, width: 3, height: 4 }))
    );
    expect(result.ok).toBe(true);
    expect(result.drawing.shapes).toHaveLength(1);
  });

  it('rejects malformed JSON and non-objects', () => {
    expect(normalizeDrawing('{not json').ok).toBe(false);
    expect(normalizeDrawing([]).ok).toBe(false);
    expect(normalizeDrawing(42).ok).toBe(false);
  });

  it('stamps the current version and defaults missing shapes to empty', () => {
    const result = normalizeDrawing({});
    expect(result.drawing).toEqual({ version: 1, shapes: [] });
  });

  describe('shape filtering', () => {
    it('drops unknown kinds so no renderer meets an unhandled branch', () => {
      const result = normalizeDrawing(
        drawingOf(
          { id: 'a', kind: 'script', x: 0, y: 0 },
          { id: 'b', kind: 'room', x: 0, y: 0, width: 10, height: 10 }
        )
      );
      expect(result.drawing.shapes.map((s) => s.id)).toEqual(['b']);
    });

    it('keeps the good shapes when a neighbour is malformed', () => {
      const result = normalizeDrawing(
        drawingOf(
          { id: 'ok1', kind: 'room', x: 0, y: 0, width: 10, height: 10 },
          { id: 'bad', kind: 'room', x: 'nope', y: 0, width: 10, height: 10 },
          null,
          { id: 'ok2', kind: 'icon', x: 5, y: 5, icon: 'ELEVATOR' }
        )
      );
      expect(result.drawing.shapes.map((s) => s.id)).toEqual(['ok1', 'ok2']);
    });

    it('drops zero-area and non-finite boxes', () => {
      const result = normalizeDrawing(
        drawingOf(
          { kind: 'room', x: 0, y: 0, width: 0, height: 10 },
          { kind: 'room', x: 0, y: 0, width: 10, height: -5 },
          { kind: 'room', x: 0, y: 0, width: Infinity, height: 10 }
        )
      );
      expect(result.drawing.shapes).toHaveLength(0);
    });
  });

  describe('logo URLs', () => {
    it('strips data: and javascript: URLs', () => {
      for (const logoUrl of [
        'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==',
        'javascript:alert(1)',
        '//evil.example.com/logo.png',
      ]) {
        const result = normalizeDrawing(
          drawingOf({ kind: 'shop', x: 0, y: 0, width: 5, height: 5, logoUrl })
        );
        expect(result.drawing.shapes[0].logoUrl).toBeUndefined();
      }
    });

    it('keeps https and site-absolute URLs', () => {
      for (const logoUrl of ['https://cdn.example.com/a.png', '/uploads/a.png']) {
        const result = normalizeDrawing(
          drawingOf({ kind: 'shop', x: 0, y: 0, width: 5, height: 5, logoUrl })
        );
        expect(result.drawing.shapes[0].logoUrl).toBe(logoUrl);
      }
    });

    it('ignores logoUrl on a plain room (branding belongs to shops)', () => {
      const result = normalizeDrawing(
        drawingOf({
          kind: 'room',
          x: 0,
          y: 0,
          width: 5,
          height: 5,
          logoUrl: 'https://cdn.example.com/a.png',
        })
      );
      expect(result.drawing.shapes[0].logoUrl).toBeUndefined();
    });
  });

  describe('colours', () => {
    it('accepts hex and rejects arbitrary CSS', () => {
      const result = normalizeDrawing(
        drawingOf(
          { kind: 'room', x: 0, y: 0, width: 5, height: 5, fill: '#abc' },
          { kind: 'room', x: 0, y: 0, width: 5, height: 5, fill: 'url(#x)' },
          { kind: 'room', x: 0, y: 0, width: 5, height: 5, fill: 'red' }
        )
      );
      expect(result.drawing.shapes[0].fill).toBe('#abc');
      expect(result.drawing.shapes[1].fill).toBeUndefined();
      expect(result.drawing.shapes[2].fill).toBeUndefined();
    });
  });

  describe('walls', () => {
    it('needs at least two points', () => {
      expect(
        normalizeDrawing(drawingOf({ kind: 'wall', points: [1, 2] })).drawing.shapes
      ).toHaveLength(0);
    });

    it('drops an odd trailing coordinate', () => {
      const result = normalizeDrawing(drawingOf({ kind: 'wall', points: [0, 0, 10, 10, 5] }));
      expect(result.drawing.shapes[0].points).toEqual([0, 0, 10, 10]);
    });

    it('defaults thickness', () => {
      const result = normalizeDrawing(drawingOf({ kind: 'wall', points: [0, 0, 10, 0] }));
      expect(result.drawing.shapes[0].thickness).toBe(4);
    });
  });

  describe('icons', () => {
    it('rejects an unknown icon kind', () => {
      expect(
        normalizeDrawing(drawingOf({ kind: 'icon', x: 0, y: 0, icon: 'TELEPORTER' }))
          .drawing.shapes
      ).toHaveLength(0);
    });

    it('normalizes rotation into 0-359', () => {
      const result = normalizeDrawing(
        drawingOf({ kind: 'icon', x: 0, y: 0, icon: 'STAIRS', rotation: -90 })
      );
      expect(result.drawing.shapes[0].rotation).toBe(270);
    });

    it('keeps the linked routing node id', () => {
      const result = normalizeDrawing(
        drawingOf({ kind: 'icon', x: 0, y: 0, icon: 'ELEVATOR', nodeId: 'cnode123' })
      );
      expect(result.drawing.shapes[0].nodeId).toBe('cnode123');
    });
  });

  describe('limits', () => {
    it('clamps coordinates to the bound rather than storing them raw', () => {
      const result = normalizeDrawing(
        drawingOf({ kind: 'icon', x: 1e9, y: -1e9, icon: 'WC' })
      );
      expect(result.drawing.shapes[0].x).toBe(DRAWING_LIMITS.MAX_COORD);
      expect(result.drawing.shapes[0].y).toBe(-DRAWING_LIMITS.MAX_COORD);
    });

    it('refuses more shapes than the cap', () => {
      const shapes = Array.from({ length: DRAWING_LIMITS.MAX_SHAPES + 1 }, () => ({
        kind: 'icon',
        x: 0,
        y: 0,
        icon: 'WC',
      }));
      const result = normalizeDrawing({ shapes });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/more than/);
    });

    it('refuses an oversized payload', () => {
      const result = normalizeDrawing('x'.repeat(DRAWING_LIMITS.MAX_BYTES + 1));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/too large/);
    });

    it('truncates over-long names instead of failing the save', () => {
      const result = normalizeDrawing(
        drawingOf({ kind: 'shop', x: 0, y: 0, width: 5, height: 5, name: 'n'.repeat(500) })
      );
      expect(result.drawing.shapes[0].name).toHaveLength(120);
    });
  });
});
