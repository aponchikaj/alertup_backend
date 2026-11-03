import { callWithTools, streamChat } from '../aiClient.js';
import { runTool, selectTools } from './toolRegistry.js';

/* ============================================================================
   The agent loop.
   ----------------------------------------------------------------------------
   Shape: the tool phase is NON-STREAMING, the final answer streams.

   That is not an accident of convenience. streamChat only falls back to the
   other provider before the first token, because restarting mid-stream would
   append a second, differently-worded answer to a half-rendered one. If tool
   iterations streamed, every retry during the loop would risk exactly that. By
   keeping the whole tool phase silent, a failure at any point in it is still
   freely retryable, and the invariant survives unchanged.

   The cost is one extra round trip on turns that need no tools. With
   maxIterations capped at 2-3 that is the right trade: predictable spend
   against a free provider tier, which is the constraint that actually binds.

   Tool results are fed back as fenced user turns rather than as provider-native
   tool-result parts. Both SDKs accept that, and it keeps ONE message dialect
   across Gemini and Groq instead of two conversation state machines.
   ========================================================================= */

/** A model that asks for ten tools at once is confused, not thorough. */
export const MAX_TOOL_CALLS_PER_ITERATION = 3;

/** What the provider is told about a tool — never the handler. */
const declarationOf = (tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
});

/**
 * Run one agent turn.
 *
 * @param {{agent: object, ctx: object, messages: Array, registry: object,
 *          signal?: AbortSignal}} params
 * @returns {AsyncGenerator<{type: 'tool'|'action'|'delta'|'done', ...}>}
 */
export async function* runAgent({ agent, ctx, messages, registry, signal }) {
  const tools = selectTools(registry, agent.tools);
  const declarations = tools.map(declarationOf);
  const system = agent.systemPrompt(ctx);

  // The model's view of the conversation. Tool results are appended here, so
  // each iteration sees everything learned so far.
  const working = [...messages];
  let iterations = 0;

  while (tools.length > 0 && iterations < agent.maxIterations) {
    iterations += 1;

    const turn = await callWithTools({
      role: agent.modelRole,
      system,
      messages: working,
      tools: declarations,
      maxTokens: agent.maxTokens,
      signal,
    });

    // No tool calls means the model is ready to answer in prose.
    if (!turn.toolCalls?.length) break;

    for (const call of turn.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ITERATION)) {
      // Resolved from the AGENT's list, not the whole registry: naming a tool
      // it was not given is simply a tool that does not exist.
      const tool = tools.find((candidate) => candidate.name === call.name);
      const result = await runTool({ tool, ctx, args: call.args });

      yield { type: 'tool', name: call.name, ok: result.ok };

      // Only a tool declared as client-side can drive the host, and only with
      // the payload its own handler built — which it built after looking the
      // entity up scoped to this building. The model never gets to name an id
      // the server has not just verified.
      if (result.ok && tool?.sideEffect === 'client' && result.data?.action) {
        yield { type: 'action', action: result.data.action };
      }

      working.push({ role: 'user', content: result.fenced });
    }
  }

  // The final answer. Tools are withheld so this call can only produce prose —
  // the loop is over, and a further tool request here would have nowhere to go.
  for await (const delta of streamChat({
    role: agent.modelRole,
    system,
    messages: working,
    maxTokens: agent.maxTokens,
    signal,
  })) {
    yield { type: 'delta', text: delta };
  }

  yield { type: 'done', iterations };
}
