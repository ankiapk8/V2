import { Router, type IRouter } from "express";
import { eq, sql, inArray } from "drizzle-orm";
import { db, decksTable, cardsTable } from "@workspace/db";
import {
  CreateDeckBody,
  GetDeckParams,
  DeleteDeckParams,
  ListDeckCardsParams,
  ExportDeckParams,
  UpdateDeckBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/decks", async (_req, res, next): Promise<void> => {
  try {
    const decks = await db
      .select({
        id: decksTable.id,
        name: decksTable.name,
        description: decksTable.description,
        parentId: decksTable.parentId,
        createdAt: decksTable.createdAt,
        cardCount: sql<number>`cast(count(${cardsTable.id}) as int)`,
      })
      .from(decksTable)
      .leftJoin(cardsTable, eq(cardsTable.deckId, decksTable.id))
      .groupBy(decksTable.id)
      .orderBy(decksTable.createdAt);

    res.json(decks.map(d => ({ ...d, createdAt: d.createdAt.toISOString() })));
  } catch (err) {
    next(err);
  }
});

router.post("/decks", async (req, res, next): Promise<void> => {
  const parsed = CreateDeckBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const [deck] = await db.insert(decksTable).values(parsed.data).returning();
    res.status(201).json({
      ...deck,
      cardCount: 0,
      createdAt: deck.createdAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/decks/:id", async (req, res, next): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetDeckParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const [row] = await db
      .select({
        id: decksTable.id,
        name: decksTable.name,
        description: decksTable.description,
        parentId: decksTable.parentId,
        createdAt: decksTable.createdAt,
        cardCount: sql<number>`cast(count(${cardsTable.id}) as int)`,
      })
      .from(decksTable)
      .leftJoin(cardsTable, eq(cardsTable.deckId, decksTable.id))
      .where(eq(decksTable.id, params.data.id))
      .groupBy(decksTable.id);

    if (!row) {
      res.status(404).json({ error: "Deck not found" });
      return;
    }

    const subDecks = await db
      .select({
        id: decksTable.id,
        name: decksTable.name,
        description: decksTable.description,
        parentId: decksTable.parentId,
        createdAt: decksTable.createdAt,
        cardCount: sql<number>`cast(count(${cardsTable.id}) as int)`,
      })
      .from(decksTable)
      .leftJoin(cardsTable, eq(cardsTable.deckId, decksTable.id))
      .where(eq(decksTable.parentId, params.data.id))
      .groupBy(decksTable.id)
      .orderBy(decksTable.createdAt);

    res.json({
      ...row,
      createdAt: row.createdAt.toISOString(),
      subDecks: subDecks.map(s => ({ ...s, createdAt: s.createdAt.toISOString() })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/decks/:id", async (req, res, next): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const parsed = UpdateDeckBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updates: Partial<typeof decksTable.$inferInsert> & { updatedAt?: Date } = {
    updatedAt: new Date(),
  };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if ("description" in parsed.data) updates.description = parsed.data.description ?? undefined;
  if ("parentId" in parsed.data) updates.parentId = parsed.data.parentId ?? undefined;

  if (Object.keys(updates).length <= 1) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  try {
    const [updated] = await db
      .update(decksTable)
      .set(updates)
      .where(eq(decksTable.id, id))
      .returning();

    if (!updated) { res.status(404).json({ error: "Deck not found" }); return; }

    const [row] = await db
      .select({
        id: decksTable.id,
        name: decksTable.name,
        description: decksTable.description,
        parentId: decksTable.parentId,
        createdAt: decksTable.createdAt,
        cardCount: sql<number>`cast(count(${cardsTable.id}) as int)`,
      })
      .from(decksTable)
      .leftJoin(cardsTable, eq(cardsTable.deckId, decksTable.id))
      .where(eq(decksTable.id, id))
      .groupBy(decksTable.id);

    res.json({ ...row!, createdAt: row!.createdAt.toISOString() });
  } catch (err) {
    next(err);
  }
});

router.delete("/decks/:id", async (req, res, next): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteDeckParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const allDecks = await db.select({ id: decksTable.id, parentId: decksTable.parentId }).from(decksTable);

    function collectDescendants(parentId: number): number[] {
      const direct = allDecks.filter(d => d.parentId === parentId).map(d => d.id);
      return [...direct, ...direct.flatMap(collectDescendants)];
    }

    const idsToDelete = [params.data.id, ...collectDescendants(params.data.id)];

    const deleted = await db
      .delete(decksTable)
      .where(inArray(decksTable.id, idsToDelete))
      .returning({ id: decksTable.id });

    if (deleted.length === 0) {
      res.status(404).json({ error: "Deck not found" });
      return;
    }

    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

router.get("/decks/:id/cards", async (req, res, next): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListDeckCardsParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const deckId = params.data.id;
    const allDecks = await db.select().from(decksTable);

    function collectDescendantIds(parentId: number): number[] {
      const children = allDecks.filter(d => d.parentId === parentId);
      return [...children.map(d => d.id), ...children.flatMap(d => collectDescendantIds(d.id))];
    }

    const descendantIds = collectDescendantIds(deckId);
    const allDeckIds = [deckId, ...descendantIds];

    const cards = await db
      .select()
      .from(cardsTable)
      .where(inArray(cardsTable.deckId, allDeckIds))
      .orderBy(cardsTable.createdAt);

    res.json(cards.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })));
  } catch (err) {
    next(err);
  }
});

router.get("/decks/:id/export", async (req, res, next): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ExportDeckParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const [deck] = await db
      .select()
      .from(decksTable)
      .where(eq(decksTable.id, params.data.id));

    if (!deck) {
      res.status(404).json({ error: "Deck not found" });
      return;
    }

    const cards = await db
      .select()
      .from(cardsTable)
      .where(eq(cardsTable.deckId, params.data.id))
      .orderBy(cardsTable.createdAt);

    const rows = cards.map(c => {
      const front = c.front.replace(/\t/g, " ").replace(/\n/g, "<br>");
      const back = c.back.replace(/\t/g, " ").replace(/\n/g, "<br>");
      const tags = c.tags ? c.tags.replace(/\t/g, " ") : "";
      return tags ? `${front}\t${back}\t${tags}` : `${front}\t${back}`;
    });

    res.json({ deckName: deck.name, csv: rows.join("\n"), cardCount: cards.length });
  } catch (err) {
    next(err);
  }
});

export default router;
