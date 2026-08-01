import request from 'supertest';
import app from '../../server.js';
import {
  extractActions,
  extractDrawing,
  mergeImprovement,
  salvageTruncatedDrawing,
} from '../features/ai/editorAssistant.routes.js';
import { createOwnerWithBuilding, createUser, addMember } from './helpers.js';

/* The design assistant's two hard properties: only map editors can reach it,
   and only validated drawings ever leave it. Model quality is not testable
   here — extraction and gating are. */

describe('extractDrawing', () => {
  test('pulls the last fenced json block and validates it as a drawing', () => {
    const text = [
      'Here is your lobby design:',
      '```json',
      '{"version":1,"shapes":[{"kind":"room","x":0,"y":0,"width":200,"height":100,"name":"Lobby"}]}',
      '```',
      'Applied as a draft.',
    ].join('\n');
    const { drawing, reply } = extractDrawing(text);
    expect(drawing.shapes).toHaveLength(1);
    expect(drawing.shapes[0]).toMatchObject({ kind: 'room', name: 'Lobby' });
    // The prose survives; the JSON wall does not.
    expect(reply).toContain('lobby design');
    expect(reply).not.toContain('"shapes"');
  });

  test('rejects malformed json, empty drawings and dangerous content', () => {
    expect(extractDrawing('```json\n{not json}\n```').drawing).toBeNull();
    expect(extractDrawing('```json\n{"version":1,"shapes":[]}\n```').drawing).toBeNull();
    // The shared validator strips what it always strips.
    const hostile = extractDrawing(
      '```json\n{"version":1,"shapes":[{"kind":"shop","x":0,"y":0,"width":9,"height":9,"logoUrl":"javascript:alert(1)"}]}\n```',
    );
    expect(hostile.drawing.shapes[0].logoUrl).toBeUndefined();
  });

  test('salvages a design truncated mid-shape by the token limit', () => {
    // The exact field failure: the model died inside shape 7, no closing
    // fence, raw braces flooding the chat and no drawing applied.
    const truncated = [
      'Here is your mall floor:',
      '```json',
      '{',
      '  "version": 1,',
      '  "shapes": [',
      '    {"kind": "wall", "points": [0, 0, 1500, 0, 1500, 800, 0, 800, 0, 0], "thickness": 6},',
      '    {"x": 100, "y": 100, "width": 200, "height": 200, "kind": "shop", "name": "Shop 1"},',
      '    {"x": 350, "y": 100, "width": 200, "height": 200, "kind": "shop", "name": "Shop 2"},',
      '    {"x": 100, "y": 350, "width": 200, "height": 200, "kind": "shop", "name": "Shop 3"},',
      '    {"', // cut mid-shape, no closing fence
    ].join('\n');

    const { drawing, reply, hadJson } = extractDrawing(truncated);
    expect(hadJson).toBe(true);
    // Every complete shape survives; the mangled tail is dropped.
    expect(drawing).not.toBeNull();
    expect(drawing.shapes.map((s) => s.name ?? s.kind)).toEqual([
      'wall', 'Shop 1', 'Shop 2', 'Shop 3',
    ]);
    // And no wall of braces reaches the chat.
    expect(reply).toBe('Here is your mall floor:');
  });

  test('salvage returns null when not even one shape completed', () => {
    expect(salvageTruncatedDrawing('{"version":1,"shapes":[{"kind":"ro')).toBeNull();
    expect(salvageTruncatedDrawing('no json at all')).toBeNull();
  });

  test('bare unfenced drawing JSON is extracted too', () => {
    const text =
      'Applying this layout:\n{"version":1,"shapes":[{"kind":"room","x":0,"y":0,"width":100,"height":100,"name":"Lobby"}]}';
    const { drawing, reply } = extractDrawing(text);
    expect(drawing?.shapes?.[0]).toMatchObject({ name: 'Lobby' });
    expect(reply).toBe('Applying this layout:');
  });

  test('plain prose passes through untouched', () => {
    const { drawing, reply } = extractDrawing('Just advice, no JSON.');
    expect(drawing).toBeNull();
    expect(reply).toBe('Just advice, no JSON.');
  });
});

describe('mergeImprovement — hand-drawn work is untouchable', () => {
  const hand = {
    version: 1,
    shapes: [
      { id: 'h1', kind: 'room', x: 0, y: 0, width: 200, height: 100, name: 'My Shop' },
      { id: 'floor-outline', kind: 'outline', points: [0, 0, 500, 0, 500, 400] },
    ],
  };

  test('existing shapes pass through byte-for-byte, additions get ai- ids', () => {
    const generated = {
      version: 1,
      shapes: [
        // The model misbehaves: re-emits the hand shape "improved" under the
        // same id, plus a legitimate new exit.
        { id: 'h1', kind: 'room', x: 50, y: 50, width: 300, height: 300, name: 'Renamed' },
        { id: 'x', kind: 'icon', x: 480, y: 20, icon: 'EXIT' },
      ],
    };
    const merged = mergeImprovement(hand, generated);

    // The original survives EXACTLY — same object, same everything.
    expect(merged.shapes[0]).toBe(hand.shapes[0]);
    // The model's "improved copy" lands as a separate addition under a fresh
    // ai- id — deletable by the user, never an overwrite.
    const additions = merged.shapes.filter((s2) => s2.id.startsWith('ai-'));
    expect(additions).toHaveLength(2);
    expect(additions.every((s2) => s2.id !== 'h1')).toBe(true);
  });

  test('a generated outline is dropped when the hand-drawn footprint exists', () => {
    const generated = {
      version: 1,
      shapes: [
        { id: 'o', kind: 'outline', points: [0, 0, 900, 0, 900, 900] },
        { id: 'x', kind: 'icon', x: 10, y: 10, icon: 'WC' },
      ],
    };
    const merged = mergeImprovement(hand, generated);
    const outlines = merged.shapes.filter((s2) => s2.kind === 'outline');
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toBe(hand.shapes[1]);
  });

  test('an empty floor takes the generated drawing wholesale', () => {
    const generated = {
      version: 1,
      shapes: [{ id: 'a', kind: 'room', x: 0, y: 0, width: 100, height: 100 }],
    };
    const merged = mergeImprovement({ version: 1, shapes: [] }, generated);
    expect(merged.shapes).toHaveLength(1);
    expect(merged.shapes[0].id.startsWith('ai-')).toBe(true);
  });
});

describe('extractActions', () => {
  test('collects known action markers and strips them from the prose', () => {
    const { actions, reply } = extractActions(
      'Design applied.\n[[action:auto-connect]]\nTap to wire the nodes.',
    );
    expect(actions).toEqual(['auto-connect']);
    expect(reply).not.toContain('[[action');
  });

  test('unknown actions are dropped, not forwarded', () => {
    const { actions, reply } = extractActions('[[action:delete-building]] done');
    expect(actions).toEqual([]);
    expect(reply).toBe('done');
  });
});

describe('POST /api/ai/editor', () => {
  test('requires CAN_EDIT_MAP', async () => {
    const { building, roles } = await createOwnerWithBuilding();
    const viewer = await createUser();
    await addMember(building.id, viewer.user.id, roles['Viewer'].id);

    const res = await request(app)
      .post('/api/ai/editor')
      .set('Cookie', viewer.cookie)
      .send({ buildingId: building.id, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(403);
  });

  test('degrades to the static fallback when no model is configured', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const res = await request(app)
      .post('/api/ai/editor')
      .set('Cookie', cookie)
      .send({ buildingId: building.id, messages: [{ role: 'user', content: 'design my floor' }] });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.reply).toBe('string');
    expect(res.body.data.drawing).toBeNull();
    // Free-tier owner: the designer is flagged off for the UI to explain.
    expect(res.body.data.designAllowed).toBe(false);
  });
});
