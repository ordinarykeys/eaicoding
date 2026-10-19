import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ChatMessage, StreamCallbacks, StreamOptions } from '@/types/llm';
import { BaseLLMProvider, LLMOutputLimitError } from './base';
import { piContext } from './pi-provider';

/** Builtin providers use the complete Node SDK, including OAuth refresh/AWS/ADC. */
export class NativePiProvider extends BaseLLMProvider {
  async stream(messages: ChatMessage[], callbacks: StreamCallbacks, options?: StreamOptions) {
    const controller = new AbortController();
    this.abortController = controller;
    const requestId = crypto.randomUUID();
    let unlisten: (() => void) | undefined;
    const abort = () => { void invoke('cancel_agent_task', { requestId }).catch(() => {}); };
    controller.signal.addEventListener('abort', abort, { once: true });
    let text = '', reasoning = '', final: AssistantMessage | undefined;
    try {
      unlisten = await listen<{ requestId: string; event: { type: string; delta?: string; message?: AssistantMessage } }>('model-runtime-event', ({ payload }) => {
        if (payload.requestId !== requestId || controller.signal.aborted) return;
        const event = payload.event;
        if (event.type === 'text_delta' && event.delta) { text += event.delta; callbacks.onToken(event.delta); }
        if (event.type === 'thinking_delta' && event.delta) { reasoning += event.delta; callbacks.onReasoningToken?.(event.delta); }
        if (event.type === 'done') final = event.message;
      });
      if (controller.signal.aborted) return;
      const config = this.config;
      await invoke('model_runtime_run', { requestId, profileId: config.profileId, input: {
        operation: 'stream', context: piContext(messages, config, options),
        config: { model: config.model, maxTokens: config.maxTokens, temperature: config.temperature, reasoningEffort: config.reasoningEffort },
      } });
      if (controller.signal.aborted) return;
      if (!final) throw new Error('模型响应在结束标记之前中断，本轮工具未执行。');
      if (final.stopReason === 'length') throw new LLMOutputLimitError(config.maxTokens);
      for (const part of final.content) if (part.type === 'toolCall') callbacks.onToolCall?.({ id: part.id, name: part.name, arguments: part.arguments, rawArguments: JSON.stringify(part.arguments) });
      callbacks.onComplete(text, { reasoningContent: reasoning, providerMessage: final });
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onError(message.includes('Token 上限') ? new LLMOutputLimitError(this.config.maxTokens) : new Error(message));
      }
    } finally { unlisten?.(); controller.signal.removeEventListener('abort', abort); }
  }
}
