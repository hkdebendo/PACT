// A plain tool-calling agent: Muse (OpenAI-compatible chat completions) + an MCP client connected
// to PACT's MCP server. No agent SDK: list tools, let the model call them, feed results back,
// stop when the model answers without a tool call or the step budget runs out.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type OpenAI from 'openai';
import type { LlmClient } from '@pact/llm';

export interface AgentEvent {
  agent: string;
  kind: 'thought' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text: string;
  tool?: string;
  args?: unknown;
}

export interface AgentOptions {
  name: string;
  mcpUrl: string;
  apiKey: string;
  llm: LlmClient;
  system: string;
  maxSteps?: number;
  onEvent?: (e: AgentEvent) => void;
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class McpAgent {
  private client: Client | null = null;
  private tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
  readonly history: Msg[];

  constructor(private readonly opts: AgentOptions) {
    this.history = [{ role: 'system', content: opts.system }];
  }

  async connect() {
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${this.opts.apiKey}` } },
    });
    this.client = new Client({ name: this.opts.name, version: '0.1.0' });
    await this.client.connect(transport);
    const { tools } = await this.client.listTools();
    // Sorted so the tool list (part of the replay cache key) is stable.
    this.tools = tools
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema as Record<string, unknown> } }));
  }

  async close() {
    await this.client?.close();
  }

  private emit(e: Omit<AgentEvent, 'agent'>) {
    this.opts.onEvent?.({ agent: this.opts.name, ...e });
  }

  /** Gives the agent a new message (an instruction or news from the world) and runs until it stops. */
  async run(userMessage: string): Promise<string> {
    if (!this.client) await this.connect();
    this.history.push({ role: 'user', content: userMessage });
    const max = this.opts.maxSteps ?? 8;
    for (let step = 0; step < max; step++) {
      const { message } = await this.opts.llm.chatWithTools({ role: `agent.${this.opts.name}`, messages: this.history, tools: this.tools });
      this.history.push({ role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length && { tool_calls: message.tool_calls }) } as Msg);
      if (message.content) this.emit({ kind: 'thought', text: message.content });
      const calls = (message.tool_calls ?? []).filter((c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => c.type === 'function');
      if (!calls.length) {
        this.emit({ kind: 'done', text: message.content ?? '' });
        return message.content ?? '';
      }
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* model produced invalid JSON: report it as a tool error below */
        }
        this.emit({ kind: 'tool_call', text: call.function.name, tool: call.function.name, args });
        let text: string;
        try {
          const res = await this.client!.callTool({ name: call.function.name, arguments: args });
          text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');
        } catch (e) {
          text = JSON.stringify({ error: (e as Error).message });
        }
        this.emit({ kind: 'tool_result', text, tool: call.function.name });
        this.history.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
    }
    this.emit({ kind: 'error', text: `Stopped after ${max} steps` });
    return '';
  }
}
