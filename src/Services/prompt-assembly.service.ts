function assemblePromptWithMemory(data: {
  question: string;
  chunks: ChunkResult[];
  conversationContext: ConversationContext;
  longTermMemories: Array<{ type: string; content: string }>;
}) {
  const messages: any[] = [];

  // 1. System prompt (always first)
  messages.push({
    role: 'system',
    content: DOCUCHAT_SYSTEM_PROMPT,
  });

  // 2. Long-term memories (user context, stable across sessions)
  const memoryBlock = data.longTermMemories
    .map(m => `[${m.type}] ${m.content}`)
    .join('\n');
  if (memoryBlock) {
    messages.push({
      role: 'system',
      content: `What you know about this user:\n${memoryBlock}`,
    });
  }

  // 3. Conversation summary (compressed history)
  if (data.conversationContext.summary) {
    messages.push({
      role: 'system',
      content:
        'Previous conversation summary:\n' +
        data.conversationContext.summary,
    });
  }

  // 4. Recent messages (sliding window — last N turns)
  for (const msg of data.conversationContext.recentMessages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // 5. Document chunks (freshest, most specific context)
  const chunkBlock = data.chunks
    .map((c, i) =>
      `[Source ${i + 1}, page ${c.page}]\n${c.content}`
    )
    .join('\n\n');
  messages.push({
    role: 'user',
    content:
      `Relevant document excerpts:\n\n${chunkBlock}\n\n` +
      `Question: ${data.question}`,
  });

  return messages;
}
