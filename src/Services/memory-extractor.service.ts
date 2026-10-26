export const memoryExtractor = {
  async extractFromInteraction(
    userId: string,
    question: string,
    answer: string
  ) {
    const response = await callLlm({
      messages: [
        {
          role: 'system',
          content: `Analyze this Q&A interaction and extract
memories worth remembering for future interactions.

Return a JSON array of memories. Each memory must have:
- type: FACT | PREFERENCE | PATTERN | CORRECTION
- content: the specific thing to remember
- importance: 0.0 to 1.0

Rules:
- Only extract genuinely useful information
- FACT: specific claims ("Company revenue was $4.2M in Q3")
- PREFERENCE: how the user likes answers formatted
- PATTERN: repeated behavior (only after 3+ occurrences)
- CORRECTION: when the user corrects the AI
- If nothing is worth remembering, return an empty array []
- Be concise: each memory should be one sentence`,
        },
        {
          role: 'user',
          content: `Question: ${question}\n\nAnswer: ${answer}`,
        },
      ],
      model: 'gpt-4o-mini',
      responseFormat: 'json',
    });

    const memories = JSON.parse(response.content);
    if (!Array.isArray(memories) || memories.length === 0) return;

    for (const mem of memories) {
      await memoryService.store({
        userId,
        type: mem.type,
        content: mem.content,
        importance: mem.importance,
        source: 'auto_extraction',
        ttlDays: mem.type === 'PATTERN' ? 30 :
                 mem.type === 'PREFERENCE' ? 90 : undefined,
      });
    }
  },
};
