import { jest } from '@jest/globals';
import { PERMISSIONS } from '../auth/permissions.js';

/* ============================================================================
   The agent loop.

   Two rules carry most of the weight:

   1. The tool phase emits nothing to the client. Every provider call made while
      deciding which tools to run is a non-streaming call, so a retry can never
      append a second answer to a half-rendered one — which is exactly the
      invariant streamChat's "no fallback after the first token" comment
      protects. Only the final answer streams.

   2. Client actions are produced by TOOLS, never parsed out of model text. A
      tool handler has already looked the entity up scoped to the building, so
      an action is grounded by construction and the model has no channel to
      fabricate one.
   ========================================================================= */

const callWithTools = jest.fn();
const streamChat = jest.fn();

jest.unstable_mockModule('../features/ai/aiClient.js', () => ({
  callWithTools,
  streamChat,
  chatOnce: jest.fn(),
  aiAvailable: () => true,
  activeProvider: () => 'gemini',
  modelFor: () => 'test-model',
  visionAvailable: () => false,
}));

const { defineTool } = await import('../features/ai/agents/toolRegistry.js');
const { runAgent } = await import('../features/ai/agents/runtime.js');

const textStream = (...deltas) =>
  async function* () {
    for (const delta of deltas) yield delta;
  };

const searchTool = defineTool({
  name: 'search_destinations',
  description: 'Find places',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  handler: async () => ({ pois: [{ poiId: 'p1', name: 'Pharmacy', floorNumber: 2 }] }),
});

const showRouteTool = defineTool({
  name: 'show_route_to',
  description: 'Draw the route',
  sideEffect: 'client',
  parameters: { type: 'object', properties: { poiId: { type: 'string' } }, required: ['poiId'] },
  handler: async (_ctx, args) => ({
    action: { name: 'show_route_to', args: { poiId: args.poiId, name: 'Pharmacy' } },
  }),
});

const guardedTool = defineTool({
  name: 'validate_building',
  description: 'Validate',
  permission: PERMISSIONS.CAN_EDIT_MAP,
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ issues: [] }),
});

const registry = {
  search_destinations: searchTool,
  show_route_to: showRouteTool,
  validate_building: guardedTool,
};

const agent = {
  id: 'wayfinder',
  systemPrompt: () => 'You are Wayfinder AI.',
  tools: ['search_destinations', 'show_route_to'],
  modelRole: 'chat',
  maxTokens: 400,
  maxIterations: 2,
};

const ctx = { buildingId: 'b1', permissions: [] };

const drain = async (iter) => {
  const events = [];
  for await (const event of iter) events.push(event);
  return events;
};

beforeEach(() => {
  jest.clearAllMocks();
  streamChat.mockImplementation(textStream('The pharmacy ', 'is on floor 2.'));
});

describe('answering without tools', () => {
  test('streams the answer when the model asks for no tools', async () => {
    callWithTools.mockResolvedValue({ text: '', toolCalls: [] });

    const events = await drain(runAgent({ agent, ctx, messages: [], registry }));

    expect(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe(
      'The pharmacy is on floor 2.'
    );
    expect(events.at(-1).type).toBe('done');
  });
});

describe('running tools', () => {
  test('executes the tool the model asked for and feeds the result back', async () => {
    callWithTools
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'c1', name: 'search_destinations', args: { query: 'pharmacy' } }],
      })
      .mockResolvedValue({ text: '', toolCalls: [] });

    const events = await drain(runAgent({ agent, ctx, messages: [], registry }));

    expect(events.find((e) => e.type === 'tool')).toMatchObject({
      name: 'search_destinations',
      ok: true,
    });

    // The result reaches the model as a fenced turn on the final streamed call.
    const finalMessages = streamChat.mock.calls.at(-1)[0].messages;
    expect(JSON.stringify(finalMessages)).toContain('Pharmacy');
  });

  test('no delta is emitted before the tool phase finishes', async () => {
    callWithTools
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'c1', name: 'search_destinations', args: { query: 'pharmacy' } }],
      })
      .mockResolvedValue({ text: '', toolCalls: [] });

    const events = await drain(runAgent({ agent, ctx, messages: [], registry }));
    const lastTool = events.findLastIndex((e) => e.type === 'tool');
    const firstDelta = events.findIndex((e) => e.type === 'delta');

    expect(lastTool).toBeLessThan(firstDelta);
  });

  test('stops after maxIterations even if the model keeps asking for tools', async () => {
    callWithTools.mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'c', name: 'search_destinations', args: { query: 'again' } }],
    });

    const events = await drain(runAgent({ agent, ctx, messages: [], registry }));

    expect(callWithTools).toHaveBeenCalledTimes(agent.maxIterations);
    expect(events.at(-1)).toMatchObject({ type: 'done', iterations: agent.maxIterations });
    // It still answers rather than leaving the visitor with nothing.
    expect(events.some((e) => e.type === 'delta')).toBe(true);
  });

  test('a tool the agent never declared is not reachable, even if the model names it', async () => {
    callWithTools
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'c1', name: 'validate_building', args: {} }],
      })
      .mockResolvedValue({ text: '', toolCalls: [] });

    const events = await drain(runAgent({ agent, ctx, messages: [], registry }));

    expect(events.find((e) => e.type === 'tool')).toMatchObject({
      name: 'validate_building',
      ok: false,
    });
  });

  test('a failing tool does not end the stream', async () => {
    const broken = defineTool({
      name: 'search_destinations',
      description: 'Find places',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('graph unavailable');
      },
    });

    callWithTools
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'c1', name: 'search_destinations', args: {} }],
      })
      .mockResolvedValue({ text: '', toolCalls: [] });

    const events = await drain(
      runAgent({ agent, ctx, messages: [], registry: { ...registry, search_destinations: broken } })
    );

    expect(events.find((e) => e.type === 'tool').ok).toBe(false);
    expect(events.some((e) => e.type === 'delta')).toBe(true);
  });
});

describe('client actions', () => {
  test('a client-side tool emits an action frame', async () => {
    callWithTools
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'c1', name: 'show_route_to', args: { poiId: 'p1' } }],
      })
      .mockResolvedValue({ text: '', toolCalls: [] });

    const events = await drain(runAgent({ agent, ctx, messages: [], registry }));

    expect(events.find((e) => e.type === 'action')).toMatchObject({
      action: { name: 'show_route_to', args: { poiId: 'p1', name: 'Pharmacy' } },
    });
  });

  test('a read tool never produces an action, whatever it returns', async () => {
    const sneaky = defineTool({
      name: 'search_destinations',
      description: 'Find places',
      parameters: { type: 'object', properties: {} },
      // A read tool returning an `action` key must not be honoured — only
      // sideEffect:'client' tools can drive the host.
      handler: async () => ({ action: { name: 'show_route_to', args: { poiId: 'anything' } } }),
    });

    callWithTools
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'c1', name: 'search_destinations', args: {} }],
      })
      .mockResolvedValue({ text: '', toolCalls: [] });

    const events = await drain(
      runAgent({ agent, ctx, messages: [], registry: { ...registry, search_destinations: sneaky } })
    );

    expect(events.find((e) => e.type === 'action')).toBeUndefined();
  });
});
