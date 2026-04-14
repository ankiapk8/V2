import { Router, type IRouter } from "express";
import { db, decksTable, cardsTable } from "@workspace/db";
import { GenerateCardsBody } from "@workspace/api-zod";

const router: IRouter = Router();

async function getOpenAIClient() {
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error("AI card generation is not configured yet.");
  }

  const { openai } = await import("@workspace/integrations-openai-ai-server");
  return openai;
}

router.post("/generate", async (req, res): Promise<void> => {
  const parsed = GenerateCardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text, deckName, cardCount = 15, parentId } = parsed.data;

  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: "Text is too short to generate cards from." });
    return;
  }

  const maxCards = Math.min(Math.max(cardCount, 1), 50);

  const systemPrompt = `You are an expert Anki flashcard creator. Given source material, generate high-quality question-answer flashcards that test understanding, not just recall.
  
Rules:
- Questions should be specific and unambiguous
- Answers should be concise but complete
- Avoid trivial or overly obvious cards
- Focus on key concepts, definitions, relationships, and important facts
- Each card should be self-contained (understandable without context)
- Use simple, clear language

Respond with a JSON array of objects with "front" (question) and "back" (answer) fields only. No markdown, no explanation, just the JSON array.`;

  const userPrompt = `Generate exactly ${maxCards} Anki flashcards from the following text. Return only a JSON array:\n\n${text.slice(0, 15000)}`;

  let response;
  try {
    const openai = await getOpenAIClient();
    response = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
  } catch (error) {
    req.log.error({ err: error }, "AI card generation failed");
    res.status(503).json({
      error: error instanceof Error ? error.message : "AI card generation failed.",
    });
    return;
  }

  const rawContent = response.choices[0]?.message?.content ?? "[]";

  let generatedCards: { front: string; back: string }[] = [];
  try {
    const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
    if (jsonMatch) generatedCards = JSON.parse(jsonMatch[0]);
  } catch {
    req.log.error({ rawContent }, "Failed to parse AI response as JSON");
    res.status(500).json({ error: "Failed to parse AI-generated cards." });
    return;
  }

  if (!Array.isArray(generatedCards) || generatedCards.length === 0) {
    res.status(500).json({ error: "AI did not generate any cards." });
    return;
  }

  const [deck] = await db
    .insert(decksTable)
    .values({ name: deckName, parentId: parentId ?? null })
    .returning();

  const validCards = generatedCards
    .filter(c => c && typeof c.front === "string" && typeof c.back === "string")
    .map(c => ({ deckId: deck.id, front: c.front.trim(), back: c.back.trim() }));

  const insertedCards = await db.insert(cardsTable).values(validCards).returning();

  res.status(201).json({
    deck: { ...deck, cardCount: insertedCards.length, createdAt: deck.createdAt.toISOString() },
    cards: insertedCards.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
    generatedCount: insertedCards.length,
  });
});

export default router;
