import { logger } from '../logger';

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1/';
const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

type BreakerState = 'closed' | 'open' | 'half-open';

interface OpenAIResponse<T> {
  data: T;
}

class OpenAIHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OpenAIHttpError';
  }
}

class OpenAICircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenRequestInFlight = false;

  async fire<T>(
    endpoint: string,
    payload: Record<string, unknown>,
  ): Promise<OpenAIResponse<T>> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required to call OpenAI');
    }

    this.beforeRequest();

    try {
      const url = new URL(endpoint.replace(/^\/+/, ''), OPENAI_API_BASE_URL);
      if (url.origin !== new URL(OPENAI_API_BASE_URL).origin) {
        throw new Error('Invalid OpenAI API endpoint');
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new OpenAIHttpError(
          `OpenAI request failed with status ${response.status}`,
          response.status,
        );
      }

      const data = await response.json() as T;
      this.onSuccess();
      return { data };
    } catch (error) {
      if (!(error instanceof OpenAIHttpError) || error.status >= 500 || error.status === 429) {
        this.onFailure(error);
      }
      throw error;
    } finally {
      if (this.state === 'half-open') {
        this.halfOpenRequestInFlight = false;
      }
    }
  }

  private beforeRequest(): void {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < RESET_TIMEOUT_MS) {
        throw new Error('OpenAI circuit breaker is open');
      }

      this.state = 'half-open';
      this.halfOpenRequestInFlight = false;
      logger.info('OpenAI circuit breaker state changed', { state: this.state });
    }

    if (this.state === 'half-open') {
      if (this.halfOpenRequestInFlight) {
        throw new Error('OpenAI circuit breaker is half-open');
      }
      this.halfOpenRequestInFlight = true;
    }
  }

  private onSuccess(): void {
    const wasNotClosed = this.state !== 'closed';
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenRequestInFlight = false;

    if (wasNotClosed) {
      logger.info('OpenAI circuit breaker state changed', { state: this.state });
    }
  }

  private onFailure(error: unknown): void {
    this.consecutiveFailures += 1;

    if (this.state === 'half-open' || this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.state = 'open';
      this.openedAt = Date.now();
      this.halfOpenRequestInFlight = false;
      logger.warn('OpenAI circuit breaker state changed', {
        state: this.state,
        consecutiveFailures: this.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const openaiBreaker = new OpenAICircuitBreaker();
