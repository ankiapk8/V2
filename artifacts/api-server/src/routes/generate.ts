import { Router, type IRouter } from "express";
import { db, decksTable, cardsTable } from "@workspace/db";
import { GenerateCardsBody } from "@workspace/api-zod";

const router: IRouter = Router();

const MAX_PAGE_IMAGES = 100;
const VISUAL_BATCH_SIZE = 6;
const MAX_VISUAL_PAGES = 48;
const VISUAL_CONCURRENCY = 2;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableAIError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function createChatCompletionWithRetry(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  payload: Parameters<typeof openai.chat.completions.create>[0],
  requestLog: { warn: (obj: unknown, message: string) => void },
) {
  const delays = [2000, 5000, 10000];

  for (let attempt = 0; ; attempt++) {
    try {
      return await openai.chat.completions.create(payload);
    } catch (error) {
      if (!isRetryableAIError(error) || attempt >= delays.length) {
        throw error;
      }
      const delayMs = delays[attempt];
      requestLog.warn({ err: error, attempt: attempt + 1, delayMs }, "Retrying AI card generation");
      await sleep(delayMs);
    }
  }
}

function parseJson<T>(raw: string): T[] {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const candidates = [
    cleaned,
    cleaned.match(/\[[\s\S]*\]/)?.[0],
    cleaned.match(/\{[\s\S]*\}/)?.[0],
  ].filter((v): v is string => Boolean(v));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed as T[];
      if (parsed && typeof parsed === "object") {
        const arr = (parsed as Record<string, unknown>).cards ?? (parsed as Record<string, unknown>).items;
        if (Array.isArray(arr)) return arr as T[];
      }
    } catch {
      continue;
    }
  }
  return [];
}

async function getOpenAIClient() {
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error("AI card generation is not configured yet.");
  }
  const { openai } = await import("@workspace/integrations-openai-ai-server");
  return openai;
}

type RawCard = { front: string; back: string };
type VisualRawCard = { pageIndex: number; front: string; back: string };

async function generateTextCards(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  text: string,
  maxCards: number,
  requestLog: { warn: (obj: unknown, message: string) => void },
): Promise<RawCard[]> {
  const systemPrompt = `You are an expert Anki flashcard creator. Generate high-quality question-answer flashcards from the provided text that test understanding, not just recall.

Rules:
- Questions should be specific and unambiguous
- Answers should be concise but complete  
- Avoid trivial or overly obvious cards
- Focus on key concepts, definitions, relationships, mechanisms, and important facts
- Each card should be self-contained (understandable without context)
- Use simple, clear language

Respond ONLY with a JSON array of objects with "front" (question) and "back" (answer) fields. No markdown, no explanation.`;

  const userContent = `Generate exactly ${maxCards} Anki flashcards from the following text:\n\n${text.slice(0, 20000)}`;

  const response = await createChatCompletionWithRetry(openai, {
    model: "gpt-4.1-mini",
    max_completion_tokens: 16384,
    stream: false as const,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  }, requestLog);

  const raw = (response as { choices: Array<{ message: { content: string | null } }> })
    .choices[0]?.message?.content ?? "[]";
  return parseJson<RawCard>(raw);
}

async function generateVisualCardsForBatch(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  batchImages: string[],
  batchStart: number,
  requestLog: { warn: (obj: unknown, message: string) => void },
): Promise<VisualRawCard[]> {
  type ContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "high" } };

  const imageUrls: ContentPart[] = batchImages.map(img => ({
    type: "image_url" as const,
    image_url: {
      url: img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`,
      detail: "high" as const,
    },
  }));

  const systemPrompt = `You are an expert Anki flashcard creator specialised in visual content. You will receive ${batchImages.length} PDF page image(s) (pages ${batchStart + 1}–${batchStart + batchImages.length}).

Your task: for EACH image that contains a meaningful visual element — such as diagrams, anatomical illustrations, X-rays, CT/MRI scans, ECGs, histology slides, dermatology photos, charts, tables, flowcharts, algorithms, graphs, labelled figures, equations — generate 1–3 specific flashcards about that visual.

Rules:
- Generate cards ONLY for pages with meaningful visuals. Skip plain-text or empty pages entirely.
- Cards must be specific to what is VISIBLE in the image (not general knowledge).
- Questions should ask the learner to identify, interpret, label, or explain what is shown.
- Answers must be concise and accurate.

Return ONLY a JSON array. Each item must have exactly:
- "pageIndex": integer (0-based index within the images you received, so 0 = first image in this batch)
- "front": string (question)
- "back": string (answer)

No markdown, no explanation, just the JSON array.`;

  try {
    const response = await createChatCompletionWithRetry(openai, {
      model: "gpt-4.1-mini",
      max_completion_tokens: 4096,
      stream: false as const,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text" as const, text: `Here are the ${batchImages.length} page image(s) for pages ${batchStart + 1}–${batchStart + batchImages.length}. Generate visual flashcards:` },
            ...imageUrls,
          ],
        },
      ],
    }, requestLog);

    const raw = (response as { choices: Array<{ message: { content: string | null } }> })
      .choices[0]?.message?.content ?? "[]";
    return parseJson<VisualRawCard>(raw).filter(
      c => typeof c.pageIndex === "number" && typeof c.front === "string" && typeof c.back === "string"
    );
  } catch {
    return [];
  }
}

async function generateAllVisualCards(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  images: string[],
  requestLog: { warn: (obj: unknown, message: string) => void },
  onBatchGroupDone?: (doneBatches: number, totalBatches: number) => void,
): Promise<{ front: string; back: string; image: string }[]> {
  const pagesToProcess = images.slice(0, MAX_VISUAL_PAGES);
  const batches: { start: number; imgs: string[] }[] = [];

  for (let i = 0; i < pagesToProcess.length; i += VISUAL_BATCH_SIZE) {
    batches.push({ start: i, imgs: pagesToProcess.slice(i, i + VISUAL_BATCH_SIZE) });
  }

  const results: { front: string; back: string; image: string }[] = [];
  let doneBatches = 0;

  for (let i = 0; i < batches.length; i += VISUAL_CONCURRENCY) {
    const chunk = batches.slice(i, i + VISUAL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(b => generateVisualCardsForBatch(openai, b.imgs, b.start, requestLog).then(cards =>
        cards
          .filter(c => c.pageIndex >= 0 && c.pageIndex < b.imgs.length)
          .map(c => ({
            front: c.front.trim(),
            back: c.back.trim(),
            image: b.imgs[c.pageIndex],
          }))
      ))
    );

    for (const r of settled) {
      if (r.status === "fulfilled") results.push(...r.value);
    }

    doneBatches += chunk.length;
    onBatchGroupDone?.(doneBatches, batches.length);

    if (i + VISUAL_CONCURRENCY < batches.length) await sleep(500);
  }

  return results;
}

function sseEmit(res: import("express").Response, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

router.post("/generate/stream", async (req, res, next): Promise<void> => {
  const parsed = GenerateCardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text, deckName, cardCount = 20, parentId, pageImages } = parsed.data;

  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: "Text is too short to generate cards from." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const maxCards = Math.min(Math.max(cardCount, 1), 200);
  const selectedImages = Array.isArray(pageImages) && pageImages.length > 0
    ? pageImages.slice(0, MAX_PAGE_IMAGES)
    : [];
  const hasImages = selectedImages.length > 0;

  sseEmit(res, { type: "progress", percent: 5, message: "Connecting to AI…" });

  let openai: Awaited<ReturnType<typeof getOpenAIClient>>;
  try {
    openai = await getOpenAIClient();
  } catch (error) {
    sseEmit(res, { type: "error", message: error instanceof Error ? error.message : "AI not configured." });
    res.end();
    return;
  }

  sseEmit(res, { type: "progress", percent: 12, message: "Generating text cards…" });

  const TEXT_DONE_PERCENT = hasImages ? 40 : 82;
  const VISUAL_START = 42;
  const VISUAL_END = 85;

  let textCards: RawCard[] = [];
  let visualCards: { front: string; back: string; image: string }[] = [];

  try {
    const textPromise = generateTextCards(openai, text, maxCards, req.log).then(cards => {
      textCards = cards;
      sseEmit(res, { type: "progress", percent: TEXT_DONE_PERCENT, message: `Text cards done (${cards.length} generated)` });
    });

    const visualPromise = hasImages
      ? generateAllVisualCards(openai, selectedImages, req.log, (done, total) => {
          const frac = done / total;
          const pct = Math.round(VISUAL_START + frac * (VISUAL_END - VISUAL_START));
          const pages = Math.min(done * VISUAL_BATCH_SIZE, selectedImages.length);
          sseEmit(res, { type: "progress", percent: pct, message: `Analyzing images… (${pages}/${selectedImages.length} pages)` });
        }).then(cards => { visualCards = cards; })
      : Promise.resolve();

    await Promise.all([textPromise, visualPromise]);
  } catch (error) {
    req.log.error({ err: error }, "SSE AI card generation failed");
    const status = getErrorStatus(error);
    const code = getErrorCode(error);
    if (status === 429 || code === "too_many_requests") {
      sseEmit(res, { type: "error", message: "AI is temporarily rate-limited. Wait a minute and try again." });
    } else {
      sseEmit(res, { type: "error", message: error instanceof Error ? error.message : "AI card generation failed." });
    }
    res.end();
    return;
  }

  sseEmit(res, { type: "progress", percent: 90, message: "Saving cards to database…" });

  try {
    const [deck] = await db
      .insert(decksTable)
      .values({ name: deckName, parentId: parentId ?? null })
      .returning();

    const allCards = [
      ...textCards
        .filter(c => typeof c.front === "string" && typeof c.back === "string")
        .map(c => ({
          deckId: deck.id,
          front: c.front.trim(),
          back: c.back.trim(),
          image: null as string | null,
        })),
      ...visualCards
        .filter(c => c.front.length > 0 && c.back.length > 0)
        .map(c => ({
          deckId: deck.id,
          front: c.front,
          back: c.back,
          image: c.image.startsWith("data:") ? c.image : `data:image/jpeg;base64,${c.image}`,
        })),
    ].filter(c => c.front.length > 0 && c.back.length > 0);

    if (allCards.length === 0) {
      sseEmit(res, { type: "error", message: "AI did not return any usable cards." });
      res.end();
      return;
    }

    const insertedCards = await db.insert(cardsTable).values(allCards).returning();

    sseEmit(res, {
      type: "done",
      percent: 100,
      generatedCount: insertedCards.length,
      deck: { ...deck, cardCount: insertedCards.length, createdAt: deck.createdAt.toISOString() },
    });
    res.end();
  } catch (err) {
    next(err);
  }
});

router.post("/generate", async (req, res, next): Promise<void> => {
  const parsed = GenerateCardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text, deckName, cardCount = 20, parentId, pageImages } = parsed.data;

  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: "Text is too short to generate cards from." });
    return;
  }

  const maxCards = Math.min(Math.max(cardCount, 1), 200);
  const selectedImages = Array.isArray(pageImages) && pageImages.length > 0
    ? pageImages.slice(0, MAX_PAGE_IMAGES)
    : [];

  let openai: Awaited<ReturnType<typeof getOpenAIClient>>;
  try {
    openai = await getOpenAIClient();
  } catch (error) {
    req.log.error({ err: error }, "AI card generation failed");
    res.status(503).json({ error: error instanceof Error ? error.message : "AI card generation failed." });
    return;
  }

  let textCards: RawCard[] = [];
  let visualCards: { front: string; back: string; image: string }[] = [];

  try {
    [textCards, visualCards] = await Promise.all([
      generateTextCards(openai, text, maxCards, req.log),
      selectedImages.length > 0
        ? generateAllVisualCards(openai, selectedImages, req.log)
        : Promise.resolve([]),
    ]);
  } catch (error) {
    req.log.error({ err: error }, "AI card generation failed");
    const status = getErrorStatus(error);
    const code = getErrorCode(error);
    if (status === 429 || code === "too_many_requests") {
      res.status(429).json({ error: "AI is temporarily rate-limited. Wait a minute and try again." });
      return;
    }
    res.status(503).json({ error: error instanceof Error ? error.message : "AI card generation failed." });
    return;
  }

  if (textCards.length === 0 && visualCards.length === 0) {
    res.status(500).json({ error: "AI did not generate any cards." });
    return;
  }

  try {
    const [deck] = await db
      .insert(decksTable)
      .values({ name: deckName, parentId: parentId ?? null })
      .returning();

    const allCards = [
      ...textCards
        .filter(c => typeof c.front === "string" && typeof c.back === "string")
        .map(c => ({
          deckId: deck.id,
          front: c.front.trim(),
          back: c.back.trim(),
          image: null as string | null,
        })),
      ...visualCards
        .filter(c => c.front.length > 0 && c.back.length > 0)
        .map(c => ({
          deckId: deck.id,
          front: c.front,
          back: c.back,
          image: c.image.startsWith("data:") ? c.image : `data:image/jpeg;base64,${c.image}`,
        })),
    ].filter(c => c.front.length > 0 && c.back.length > 0);

    if (allCards.length === 0) {
      res.status(500).json({ error: "AI returned cards without usable fronts and backs." });
      return;
    }

    const insertedCards = await db.insert(cardsTable).values(allCards).returning();

    res.status(201).json({
      deck: { ...deck, cardCount: insertedCards.length, createdAt: deck.createdAt.toISOString() },
      cards: insertedCards.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })),
      generatedCount: insertedCards.length,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
