/*
文件说明: 在 Anthropic Messages 与 OpenAI Chat Completions 请求、响应、流式事件之间做协议转换。
参考资料: claude-client-adapter src/openai-adapter.js
对应文档: Electron + Vite GUI implementation plan
*/
import type { ServerResponse } from "node:http";

type AnthropicContentBlock = {
  type: string;
  text?: string;
  source?: {
    type: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
  tool_use_id?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | AnthropicContentBlock[];
};

type AnthropicMessage = {
  role: string;
  content: string | AnthropicContentBlock[];
};

type AnthropicBody = {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type: string; name?: string };
};

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    completion_tokens?: number;
  };
};

export function anthropicToOpenAI(anthropicBody: AnthropicBody, remoteModelId: string) {
  const openAI: Record<string, unknown> = {
    model: remoteModelId,
    messages: anthropicMessagesToOpenAI(anthropicBody.messages || [], anthropicBody.system)
  };

  if (anthropicBody.max_tokens != null) openAI.max_tokens = anthropicBody.max_tokens;
  if (anthropicBody.temperature != null) openAI.temperature = anthropicBody.temperature;
  if (anthropicBody.top_p != null) openAI.top_p = anthropicBody.top_p;
  if (anthropicBody.stream != null) openAI.stream = anthropicBody.stream;
  if (anthropicBody.stop_sequences != null) openAI.stop = anthropicBody.stop_sequences;

  const tools = anthropicToolsToOpenAI(anthropicBody.tools);
  if (tools) openAI.tools = tools;

  const toolChoice = anthropicToolChoiceToOpenAI(anthropicBody.tool_choice);
  if (toolChoice != null) openAI.tool_choice = toolChoice;

  if (anthropicBody.stream) {
    openAI.stream_options = { include_usage: true };
  }

  return openAI;
}

export function openAIToAnthropic(openAIBody: Record<string, any>, localModelId: string) {
  const choice = openAIBody.choices?.[0];
  if (!choice) {
    throw new Error("OpenAI 响应中没有 choices 字段。");
  }

  const message = choice.message;
  const content = [];

  if (message.content) {
    content.push({ type: "text", text: message.content });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {}
      content.push({ type: "tool_use", id: toolCall.id, name: toolCall.function.name, input });
    }
  }

  return {
    id: openAIBody.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: localModelId,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openAIBody.usage?.prompt_tokens || 0,
      output_tokens: openAIBody.usage?.completion_tokens || 0
    }
  };
}

export async function pipeOpenAIStreamAsAnthropic(openAIStream: ReadableStream<Uint8Array>, res: ServerResponse, localModelId: string) {
  const msgId = `msg_${Date.now()}`;

  writeSSE(res, "message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model: localModelId,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  writeSSE(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" }
  });
  writeSSE(res, "ping", { type: "ping" });

  let lineBuffer = "";
  let outputTokens = 0;
  let stopReason = "end_turn";
  const toolBlocks = new Map<number, { blockIdx: number; id: string; name: string; argumentsBuf: string }>();
  let nextBlockIdx = 1;

  for await (const chunk of openAIStream as any) {
    lineBuffer += Buffer.from(chunk).toString("utf8");
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed.startsWith("data: ")) continue;
      const raw = trimmed.slice(6);
      if (raw === "[DONE]") continue;

      let parsed: OpenAIStreamChunk;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      outputTokens = parsed.usage?.completion_tokens || outputTokens;
      const choice = parsed.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        writeSSE(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: choice.delta.content }
        });
      }

      for (const toolCall of choice.delta?.tool_calls || []) {
        let block = toolBlocks.get(toolCall.index);
        if (!block) {
          block = {
            blockIdx: nextBlockIdx++,
            id: toolCall.id || `toolu_${Date.now()}_${toolCall.index}`,
            name: toolCall.function?.name || "",
            argumentsBuf: ""
          };
          toolBlocks.set(toolCall.index, block);
          writeSSE(res, "content_block_start", {
            type: "content_block_start",
            index: block.blockIdx,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
          });
        }

        if (toolCall.function?.arguments) {
          block.argumentsBuf += toolCall.function.arguments;
          writeSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index: block.blockIdx,
            delta: { type: "input_json_delta", partial_json: toolCall.function.arguments }
          });
        }
      }

      if (choice.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason);
      }
    }
  }

  writeSSE(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  for (const block of toolBlocks.values()) {
    writeSSE(res, "content_block_stop", { type: "content_block_stop", index: block.blockIdx });
  }
  writeSSE(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens }
  });
  writeSSE(res, "message_stop", { type: "message_stop" });
}

function anthropicContentToOpenAI(content: string | AnthropicContentBlock[]) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const blocks = content.filter((block) => block.type === "text" || block.type === "image");
  if (blocks.length === 0) return null;
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => block.text).join("");
  }

  return blocks
    .map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      const src = block.source;
      if (!src) return null;
      if (src.type === "base64") {
        return { type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } };
      }
      return { type: "image_url", image_url: { url: src.url } };
    })
    .filter(Boolean);
}

function anthropicMessagesToOpenAI(messages: AnthropicMessage[], systemPrompt: AnthropicBody["system"]) {
  const result = [];

  if (systemPrompt) {
    const systemText =
      typeof systemPrompt === "string"
        ? systemPrompt
        : Array.isArray(systemPrompt)
          ? systemPrompt.map((block) => block.text || "").join("\n")
          : "";
    if (systemText) result.push({ role: "system", content: systemText });
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((block) => block.type === "tool_result");
        const otherBlocks = msg.content.filter((block) => block.type !== "tool_result");

        for (const toolResult of toolResults) {
          const toolText =
            typeof toolResult.content === "string"
              ? toolResult.content
              : Array.isArray(toolResult.content)
                ? toolResult.content.map((block) => block.text || "").join("")
                : "";
          result.push({ role: "tool", tool_call_id: toolResult.tool_use_id, content: toolText });
        }

        const openAIContent = anthropicContentToOpenAI(otherBlocks);
        if (openAIContent !== null) result.push({ role: "user", content: openAIContent });
      } else {
        result.push({ role: "user", content: anthropicContentToOpenAI(msg.content) });
      }
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter((block) => block.type === "text");
        const toolUseBlocks = msg.content.filter((block) => block.type === "tool_use");
        const msgObj: Record<string, unknown> = {
          role: "assistant",
          content: textBlocks.length > 0 ? textBlocks.map((block) => block.text).join("") : null
        };

        if (toolUseBlocks.length > 0) {
          msgObj.tool_calls = toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: { name: toolUse.name, arguments: JSON.stringify(toolUse.input ?? {}) }
          }));
        }

        result.push(msgObj);
      } else {
        result.push({ role: "assistant", content: anthropicContentToOpenAI(msg.content) });
      }
    }
  }

  return result;
}

function anthropicToolsToOpenAI(tools: AnthropicBody["tools"]) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} }
    }
  }));
}

function anthropicToolChoiceToOpenAI(toolChoice: AnthropicBody["tool_choice"]) {
  if (!toolChoice) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") return { type: "function", function: { name: toolChoice.name } };
  return "auto";
}

function mapFinishReason(finishReason: string | null | undefined) {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function writeSSE(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
