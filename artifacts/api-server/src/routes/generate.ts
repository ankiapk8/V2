import { Router, type IRouter } from "express";
import { db, decksTable, cardsTable } from "@workspace/db";
import { GenerateCardsBody } from "@workspace/api-zod";
import { createCanvas, loadImage } from "canvas";

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
type Bbox = { x: number; y: number; w: number; h: number };
type VisualRawCard = { pageIndex: number; front: string; back: string; bbox?: Bbox };

function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, v));
}

function normalizeBbox(raw: unknown): Bbox | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Support {x,y,w,h} or {x,y,width,height} or [x,y,w,h]
  let x: unknown, y: unknown, w: unknown, h: unknown;
  if (Array.isArray(raw) && raw.length === 4) {
    [x, y, w, h] = raw;
  } else {
    x = r.x;
    y = r.y;
    w = r.w ?? r.width;
    h = r.h ?? r.height;
  }
  if ([x, y, w, h].some(v => typeof v !== "number")) return null;
  const bbox: Bbox = {
    x: clamp01(x, 0),
    y: clamp01(y, 0),
    w: clamp01(w, 1),
    h: clamp01(h, 1),
  };
  if (bbox.w < 0.05 || bbox.h < 0.05) return null;
  if (bbox.x + bbox.w > 1) bbox.w = 1 - bbox.x;
  if (bbox.y + bbox.h > 1) bbox.h = 1 - bbox.y;
  return bbox;
}

async function cropImage(dataUrlOrB64: string, bbox: Bbox | null): Promise<string> {
  const src = dataUrlOrB64.startsWith("data:") ? dataUrlOrB64 : `data:image/jpeg;base64,${dataUrlOrB64}`;
  if (!bbox) return src;
  try {
    const img = await loadImage(src);
    const sx = Math.round(bbox.x * img.width);
    const sy = Math.round(bbox.y * img.height);
    const sw = Math.max(1, Math.round(bbox.w * img.width));
    const sh = Math.max(1, Math.round(bbox.h * img.height));
    const canvas = createCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return src;
  }
}

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
  cardsPerPage: number,
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

  const cardsRange = cardsPerPage <= 1 ? "1" : `1–${cardsPerPage}`;

  const systemPrompt = `You are an expert Anki flashcard creator working from PDF page images. You will receive ${batchImages.length} page image(s) (pages ${batchStart + 1}–${batchStart + batchImages.length}).

For EACH page, generate ${cardsRange} high-quality VISUAL flashcards focused on diagrams, figures, illustrations, charts, scans, anatomical drawings, X-rays, CT/MRI, ECGs, histology slides, dermatology photos, flowcharts, algorithms, graphs, equations, or labelled visuals.

For each card, you MUST identify the specific region of the page that contains the relevant visual content, and return a NORMALIZED bounding box for cropping. Coordinates are 0..1 where (0,0) is the TOP-LEFT of the page and (1,1) is the BOTTOM-RIGHT.

Card guidelines:
- Prioritize asking the learner to identify, interpret, or label what is shown in the visual.
- Cards must be self-contained and specific. Avoid trivially obvious questions.
- Keep answers concise and accurate.
- Skip a page only if it contains no meaningful visual content.

Return ONLY a JSON array. Each item must have exactly:
- "pageIndex": integer (0-based index within the images you received, so 0 = first image in this batch)
- "front": string (question)
- "back": string (answer)
- "bbox": object with numeric "x", "y", "w", "h" all between 0 and 1, tightly cropped around the visual element. Include a small margin (~3%) around the figure. If the entire page is the visual, use {"x":0,"y":0,"w":1,"h":1}.

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
            { type: "text" as const, text: `Here are the ${batchImages.length} page image(s) for pages ${batchStart + 1}–${batchStart + batchImages.length}. Generate visual flashcards with tight bounding boxes:` },
            ...imageUrls,
          ],
        },
      ],
    }, requestLog);

    const raw = (response as { choices: Array<{ message: { content: string | null } }> })
      .choices[0]?.message?.content ?? "[]";
    return parseJson<VisualRawCard>(raw)
      .filter(c => typeof c.pageIndex === "number" && typeof c.front === "string" && typeof c.back === "string")
      .map(c => ({ ...c, bbox: normalizeBbox(c.bbox) ?? undefined }));
  } catch {
    return [];
  }
}

async function generateAllVisualCards(
  openai: Awaited<ReturnType<typeof getOpenAIClient>>,
  images: string[],
  targetCount: number | undefined,
  requestLog: { warn: (obj: unknown, message: string) => void },
  onBatchGroupDone?: (doneBatches: number, totalBatches: number) => void,
): Promise<{ front: string; back: string; image: string }[]> {
  const pagesToProcess = images.slice(0, MAX_VISUAL_PAGES);
  const batches: { start: number; imgs: string[] }[] = [];

  for (let i = 0; i < pagesToProcess.length; i += VISUAL_BATCH_SIZE) {
    batches.push({ start: i, imgs: pagesToProcess.slice(i, i + VISUAL_BATCH_SIZE) });
  }

  // Compute cards per page from target
  const cardsPerPage = targetCount && targetCount > 0
    ? Math.max(1, Math.min(3, Math.ceil(targetCount / pagesToProcess.length)))
    : 2;

  const results: { front: string; back: string; image: string }[] = [];
  let doneBatches = 0;

  for (let i = 0; i < batches.length; i += VISUAL_CONCURRENCY) {
    const chunk = batches.slice(i, i + VISUAL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(b => generateVisualCardsForBatch(openai, b.imgs, b.start, cardsPerPage, requestLog).then(async cards => {
        const out: { front: string; back: string; image: string }[] = [];
        for (const c of cards) {
          if (c.pageIndex < 0 || c.pageIndex >= b.imgs.length) continue;
          const cropped = await cropImage(b.imgs[c.pageIndex], c.bbox ?? null);
          out.push({
            front: c.front.trim(),
            back: c.back.trim(),
            image: cropped,
          });
        }
        return out;
      }))
    );

    for (const r of settled) {
      if (r.status === "fulfilled") results.push(...r.value);
    }

    doneBatches += chunk.length;
    onBatchGroupDone?.(doneBatches, batches.length);

    if (i + VISUAL_CONCURRENCY < batches.length) await sleep(500);
  }

  // If a target was given, trim down
  if (targetCount && targetCount > 0 && results.length > targetCount) {
    return results.slice(0, targetCount);
  }
  return results;
}

function sseEmit(res: import("express").Response, event: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

type DeckType = "text" | "visual" | "both";

function resolveDeckType(input: unknown, hasImages: boolean): DeckType {
  const t = input === "text" || input === "visual" || input === "both" ? input : "both";
  if (!hasImages && t !== "text") return "text";
  return t;
}

router.post("/generate/stream", async (req, res, next): Promise<void> => {
  const parsed = GenerateCardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text, deckName, cardCount = 20, visualCardCount, parentId, pageImages, deckType: rawDeckType } = parsed.data;

  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: "Text is too short to generate cards from." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const selectedImages = Array.isArray(pageImages) && pageImages.length > 0
    ? pageImages.slice(0, MAX_PAGE_IMAGES)
    : [];
  const hasImages = selectedImages.length > 0;
  const deckType = resolveDeckType(rawDeckType, hasImages);
  const wantText = deckType === "text" || deckType === "both";
  const wantVisual = (deckType === "visual" || deckType === "both") && hasImages;

  const maxTextCards = wantText ? Math.min(Math.max(cardCount, 1), 200) : 0;
  const maxVisualCards = wantVisual
    ? Math.min(Math.max(visualCardCount ?? cardCount, 1), 200)
    : 0;

  sseEmit(res, { type: "progress", percent: 5, message: "Connecting to AI…" });

  let openai: Awaited<ReturnType<typeof getOpenAIClient>>;
  try {
    openai = await getOpenAIClient();
  } catch (error) {
    sseEmit(res, { type: "error", message: error instanceof Error ? error.message : "AI not configured." });
    res.end();
    return;
  }

  sseEmit(res, { type: "progress", percent: 12, message: wantText ? "Generating text cards…" : "Analyzing pages…" });

  const TEXT_DONE_PERCENT = wantVisual ? 40 : 82;
  const VISUAL_START = wantText ? 42 : 15;
  const VISUAL_END = 85;

  let textCards: RawCard[] = [];
  let visualCards: { front: string; back: string; image: string }[] = [];

  try {
    const textPromise = wantText
      ? generateTextCards(openai, text, maxTextCards, req.log).then(cards => {
          textCards = cards;
          sseEmit(res, { type: "progress", percent: TEXT_DONE_PERCENT, message: `Text cards done (${cards.length} generated)` });
        })
      : Promise.resolve();

    const visualPromise = wantVisual
      ? generateAllVisualCards(openai, selectedImages, maxVisualCards, req.log, (done, total) => {
          const frac = done / total;
          const pct = Math.round(VISUAL_START + frac * (VISUAL_END - VISUAL_START));
          const pages = Math.min(done * VISUAL_BATCH_SIZE, selectedImages.length);
          sseEmit(res, { type: "progress", percent: pct, message: `Analyzing & cropping images… (${pages}/${selectedImages.length} pages)` });
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
    const filteredText = textCards
      .filter(c => typeof c.front === "string" && typeof c.back === "string")
      .map(c => ({ front: c.front.trim(), back: c.back.trim() }))
      .filter(c => c.front.length > 0 && c.back.length > 0);

    const filteredVisual = visualCards
      .filter(c => c.front.length > 0 && c.back.length > 0);

    if (filteredText.length === 0 && filteredVisual.length === 0) {
      sseEmit(res, { type: "error", message: "AI did not return any usable cards." });
      res.end();
      return;
    }

    let textDeck: typeof decksTable.$inferSelect | null = null;
    let visualDeck: typeof decksTable.$inferSelect | null = null;
    let totalInserted = 0;

    const wantTextDeck = wantText && filteredText.length > 0;
    const wantVisualDeck = wantVisual && filteredVisual.length > 0;
    const splitting = wantTextDeck && wantVisualDeck;

    if (wantTextDeck) {
      const name = splitting ? `${deckName} – Text` : deckName;
      const [d] = await db
        .insert(decksTable)
        .values({ name, parentId: parentId ?? null })
        .returning();
      textDeck = d;
      const inserted = await db.insert(cardsTable).values(
        filteredText.map(c => ({ deckId: d.id, front: c.front, back: c.back, image: null }))
      ).returning();
      totalInserted += inserted.length;
    }

    if (wantVisualDeck) {
      const name = splitting ? `${deckName} – Visual` : deckName;
      const [d] = await db
        .insert(decksTable)
        .values({ name, parentId: parentId ?? null })
        .returning();
      visualDeck = d;
      const inserted = await db.insert(cardsTable).values(
        filteredVisual.map(c => ({
          deckId: d.id,
          front: c.front,
          back: c.back,
          image: c.image.startsWith("data:") ? c.image : `data:image/jpeg;base64,${c.image}`,
        }))
      ).returning();
      totalInserted += inserted.length;
    }

    const primaryDeck = textDeck ?? visualDeck;
    if (!primaryDeck) {
      sseEmit(res, { type: "error", message: "Failed to save deck." });
      res.end();
      return;
    }

    sseEmit(res, {
      type: "done",
      percent: 100,
      generatedCount: totalInserted,
      deck: { ...primaryDeck, cardCount: totalInserted, createdAt: primaryDeck.createdAt.toISOString() },
      ...(textDeck && visualDeck
        ? { visualDeck: { ...visualDeck, cardCount: filteredVisual.length, createdAt: visualDeck.createdAt.toISOString() } }
        : {}),
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

  const { text, deckName, cardCount = 20, visualCardCount, parentId, pageImages, deckType: rawDeckType } = parsed.data;

  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: "Text is too short to generate cards from." });
    return;
  }

  const selectedImages = Array.isArray(pageImages) && pageImages.length > 0
    ? pageImages.slice(0, MAX_PAGE_IMAGES)
    : [];
  const hasImages = selectedImages.length > 0;
  const deckType = resolveDeckType(rawDeckType, hasImages);
  const wantText = deckType === "text" || deckType === "both";
  const wantVisual = (deckType === "visual" || deckType === "both") && hasImages;
  const maxTextCards = wantText ? Math.min(Math.max(cardCount, 1), 200) : 0;
  const maxVisualCards = wantVisual ? Math.min(Math.max(visualCardCount ?? cardCount, 1), 200) : 0;

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
      wantText ? generateTextCards(openai, text, maxTextCards, req.log) : Promise.resolve([] as RawCard[]),
      wantVisual ? generateAllVisualCards(openai, selectedImages, maxVisualCards, req.log) : Promise.resolve([]),
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

  const filteredText = textCards
    .filter(c => typeof c.front === "string" && typeof c.back === "string")
    .map(c => ({ front: c.front.trim(), back: c.back.trim() }))
    .filter(c => c.front.length > 0 && c.back.length > 0);
  const filteredVisual = visualCards.filter(c => c.front.length > 0 && c.back.length > 0);

  if (filteredText.length === 0 && filteredVisual.length === 0) {
    res.status(500).json({ error: "AI did not generate any cards." });
    return;
  }

  try {
    let textDeck: typeof decksTable.$inferSelect | null = null;
    let visualDeck: typeof decksTable.$inferSelect | null = null;
    const allInserted: (typeof cardsTable.$inferSelect)[] = [];

    const wantTextDeck = wantText && filteredText.length > 0;
    const wantVisualDeck = wantVisual && filteredVisual.length > 0;
    const splitting = wantTextDeck && wantVisualDeck;

    if (wantTextDeck) {
      const name = splitting ? `${deckName} – Text` : deckName;
      const [d] = await db.insert(decksTable).values({ name, parentId: parentId ?? null }).returning();
      textDeck = d;
      const inserted = await db.insert(cardsTable).values(
        filteredText.map(c => ({ deckId: d.id, front: c.front, back: c.back, image: null }))
      ).returning();
      allInserted.push(...inserted);
    }

    if (wantVisualDeck) {
      const name = splitting ? `${deckName} – Visual` : deckName;
      const [d] = await db.insert(decksTable).values({ name, parentId: parentId ?? null }).returning();
      visualDeck = d;
      const inserted = await db.insert(cardsTable).values(
        filteredVisual.map(c => ({
          deckId: d.id,
          front: c.front,
          back: c.back,
          image: c.image.startsWith("data:") ? c.image : `data:image/jpeg;base64,${c.image}`,
        }))
      ).returning();
      allInserted.push(...inserted);
    }

    const primaryDeck = textDeck ?? visualDeck;
    if (!primaryDeck) {
      res.status(500).json({ error: "Failed to save deck." });
      return;
    }

    res.status(201).json({
      deck: { ...primaryDeck, cardCount: allInserted.filter(c => c.deckId === primaryDeck.id).length, createdAt: primaryDeck.createdAt.toISOString() },
      ...(textDeck && visualDeck
        ? { visualDeck: { ...visualDeck, cardCount: filteredVisual.length, createdAt: visualDeck.createdAt.toISOString() } }
        : {}),
      cards: allInserted.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })),
      generatedCount: allInserted.length,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
