
import { TOOL_REGISTRY, getToolSchemas } from './tools/registry';
import { openaiBreaker } from '../lib/http/openaiBreaker';
import { logger } from '../lib/logger';
import { appEvents } from '../lib/events';
import { AGENT_SYSTEM_PROMPT } from '../config/prompts';

interface AgentConfig {
  maxIterations: number;
  timeoutMs: number;
  costCeilingUsd: number;
  model: string;
}

interface AgentResult {
  answer: string;
  sources: string[];
  confidence: string;
  iterations: number;
  totalTokens: number;
  totalCostUsd: number;
  terminationReason: 'completed' | 'iteration_limit' | 'timeout' | 'cost_limit' | 'error';
  trace: TraceStep[];
}

interface TraceStep {
  step: number;
  phase: 'think' | 'act' | 'observe';
  tool?: string;
  input?: any;
  output?: any;
  durationMs: number;
  costUsd: number;
}

interface AgentCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 10,
  timeoutMs: 60_000,
  costCeilingUsd: 0.50,
  model: 'gpt-4o',
};

export async function runAgent(options: {
  question: string;
  userId: string;
  correlationId: string;
  config?: Partial<AgentConfig>;
}): Promise<AgentResult> {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const { question, userId, correlationId } = options;

  const trace: TraceStep[] = [];
  let totalCostUsd = 0;
  let totalTokens = 0;
  let iteration = 0;
  const startTime = Date.now();

  const complete = (result: AgentResult): AgentResult => {
    appEvents.emit('agent:completed', {
      userId,
      correlationId,
      totalTokens: result.totalTokens,
      iterations: result.iterations,
      totalCostUsd: result.totalCostUsd,
      terminationReason: result.terminationReason,
      toolsUsed: result.trace
        .filter(step => step.tool)
        .map(step => step.tool),
      confidence: result.confidence,
      durationMs: Date.now() - startTime,
    });
    return result;
  };

  // Build the conversation with the LLM
  const messages: any[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];

  const toolSchemas = getToolSchemas();

  logger.info('Agent started', {
    correlationId, question: question.substring(0, 100),
    maxIterations: config.maxIterations,
    costCeiling: config.costCeilingUsd,
  });

  while (iteration < config.maxIterations) {
    // ── CHECK TIMEOUT ──
    const elapsed = Date.now() - startTime;
    if (elapsed > config.timeoutMs) {
      logger.warn('Agent timeout', { correlationId, iteration, elapsed });
      return complete(
        buildResult('timeout', trace, totalCostUsd, totalTokens, iteration),
      );
    }

    // ── CHECK COST ──
    if (totalCostUsd >= config.costCeilingUsd) {
      logger.warn('Agent cost ceiling hit', {
        correlationId, iteration, totalCostUsd,
      });
      return complete(
        buildResult('cost_limit', trace, totalCostUsd, totalTokens, iteration),
      );
    }

    iteration++;
    const stepStart = Date.now();

    // ── THINK: Ask the model what to do ──
    const response = await openaiBreaker.fire<AgentCompletionResponse>('/chat/completions', {
      model: config.model,
      messages,
      tools: toolSchemas,
      tool_choice: 'auto',
      temperature: 0.1,
    });

    const usage = response.data.usage;
    totalTokens += usage.total_tokens;
    const stepCost =
      (usage.prompt_tokens / 1_000_000) * 2.50 +
      (usage.completion_tokens / 1_000_000) * 10.00;
    totalCostUsd += stepCost;

    const choice = response.data.choices[0];
    if (!choice) {
      throw new Error('OpenAI returned no agent completion choices');
    }
    const assistantMessage = choice.message;

    // Add the assistant's response to conversation
    messages.push(assistantMessage);

    // ── NO TOOL CALL: Model wants to respond directly ──
    if (!assistantMessage.tool_calls ||
        assistantMessage.tool_calls.length === 0) {
      if (assistantMessage.content === null) {
        throw new Error('OpenAI returned an empty agent response');
      }

      trace.push({
        step: iteration, phase: 'think',
        output: assistantMessage.content,
        durationMs: Date.now() - stepStart, costUsd: stepCost,
      });

      // Treat direct response as final answer
      return complete({
        answer: assistantMessage.content,
        sources: [],
        confidence: 'medium',
        iterations: iteration,
        totalTokens,
        totalCostUsd,
        terminationReason: 'completed',
        trace,
      });
    }

    // ── ACT: Execute each tool call ──
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments);

      logger.info('Agent tool call', {
        correlationId, iteration, tool: toolName,
        args: toolArgs,
      });

      // Validate: is this tool in the registry?
      const tool = TOOL_REGISTRY[toolName];
      if (!tool) {
        const errorResult = {
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: `Error: unknown tool "${toolName}"`,
        };
        messages.push(errorResult);
        trace.push({
          step: iteration, phase: 'act', tool: toolName,
          input: toolArgs,
          output: { error: 'Unknown tool' },
          durationMs: Date.now() - stepStart, costUsd: stepCost,
        });
        continue;
      }

      // Check for final_answer
      if (toolName === 'final_answer') {
        trace.push({
          step: iteration, phase: 'act', tool: 'final_answer',
          input: toolArgs,
          durationMs: Date.now() - stepStart, costUsd: stepCost,
        });
        return complete({
          answer: toolArgs.answer,
          sources: toolArgs.sources || [],
          confidence: toolArgs.confidence || 'medium',
          iterations: iteration,
          totalTokens,
          totalCostUsd,
          terminationReason: 'completed',
          trace,
        });
      }

      // Validate inputs
      const validation = tool.parameters.safeParse(toolArgs);
      if (!validation.success) {
        const errorResult = {
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: `Validation error: ${validation.error.message}`,
        };
        messages.push(errorResult);
        continue;
      }

      // Execute the tool
      try {
        const result = await tool.handler(
          validation.data,
          { userId, correlationId }
        );

        // ── OBSERVE: Feed result back to the model ──
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result.data),
        });

        trace.push({
          step: iteration, phase: 'observe', tool: toolName,
          input: toolArgs, output: result.data,
          durationMs: Date.now() - stepStart, costUsd: stepCost,
        });
      } catch (error) {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `Tool error: ${(error as Error).message}`,
        });
        trace.push({
          step: iteration, phase: 'observe', tool: toolName,
          input: toolArgs,
          output: { error: (error as Error).message },
          durationMs: Date.now() - stepStart, costUsd: stepCost,
        });
      }
    }
  }

  // Iteration limit reached
  logger.warn('Agent iteration limit', {
    correlationId, iterations: iteration, totalCostUsd,
  });
  return complete(
    buildResult('iteration_limit', trace, totalCostUsd, totalTokens, iteration),
  );
}

function buildResult(
  reason: AgentResult['terminationReason'],
  trace: TraceStep[],
  costUsd: number,
  totalTokens: number,
  iterations: number
): AgentResult {
  // Try to extract a partial answer from the trace
  const lastObserve = [...trace]
    .reverse()
    .find(s => s.phase === 'observe' && s.output);

  return {
    answer: `I was unable to complete my analysis (${reason}). ` +
      (lastObserve
        ? 'Here is what I found so far: ' + JSON.stringify(lastObserve.output)
        : 'No partial results are available.'),
    sources: [],
    confidence: 'low',
    iterations,
    totalTokens,
    totalCostUsd: costUsd,
    terminationReason: reason,
    trace,
  };
}
