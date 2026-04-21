import { Router, type IRouter } from "express";
import { inArray } from "drizzle-orm";
import { db, decksTable, cardsTable } from "@workspace/db";

const router: IRouter = Router();

const FORMAT_VERSION = 1;

type ExportedCard = {
  front: string;
  back: string;
  tags: string | null;
  image: string | null;
};

type ExportedNode = {
  name: string;
  description: string | null;
  cards: ExportedCard[];
  subDecks: ExportedNode[];
};

type ExportedFile = {
  format: "ankigen-deck";
  version: number;
  exportedAt: string;
  root?: ExportedNode;
  roots?: ExportedNode[];
};

function buildNode(
  deckId: number,
  allDecks: (typeof decksTable.$inferSelect)[],
  cardsByDeck: Map<number, (typeof cardsTable.$inferSelect)[]>
): ExportedNode {
  const deck = allDecks.find(d => d.id === deckId)!;
  const children = allDecks.filter(d => d.parentId === deckId);
  const cards = cardsByDeck.get(deckId) ?? [];
  return {
    name: deck.name,
    description: deck.description ?? null,
    cards: cards.map(c => ({
      front: c.front,
      back: c.back,
      tags: c.tags ?? null,
      image: c.image ?? null,
    })),
    subDecks: children.map(c => buildNode(c.id, allDecks, cardsByDeck)),
  };
}

router.get("/export-all-json", async (_req, res, next): Promise<void> => {
  try {
    const allDecks = await db.select().from(decksTable);
    const topLevel = allDecks
      .filter(d => d.parentId === null)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    if (topLevel.length === 0) {
      res.status(404).json({ error: "No decks to export." });
      return;
    }

    const cards = await db.select().from(cardsTable).orderBy(cardsTable.createdAt);
    const cardsByDeck = new Map<number, (typeof cardsTable.$inferSelect)[]>();
    for (const c of cards) {
      const list = cardsByDeck.get(c.deckId) ?? [];
      list.push(c);
      cardsByDeck.set(c.deckId, list);
    }

    const file: ExportedFile = {
      format: "ankigen-deck",
      version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      roots: topLevel.map(d => buildNode(d.id, allDecks, cardsByDeck)),
    };

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ankigen-library-${stamp}.ankigen.json"`
    );
    res.end(JSON.stringify(file, null, 2));
  } catch (err) {
    next(err);
  }
});

router.get("/decks/:id/export-json", async (req, res, next): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid deck ID" });
    return;
  }

  try {
    const allDecks = await db.select().from(decksTable);
    const root = allDecks.find(d => d.id === id);
    if (!root) {
      res.status(404).json({ error: "Deck not found" });
      return;
    }

    function descendantIds(parentId: number): number[] {
      const direct = allDecks.filter(d => d.parentId === parentId).map(d => d.id);
      return [...direct, ...direct.flatMap(descendantIds)];
    }

    const allIds = [id, ...descendantIds(id)];
    const cards = await db
      .select()
      .from(cardsTable)
      .where(inArray(cardsTable.deckId, allIds))
      .orderBy(cardsTable.createdAt);

    const cardsByDeck = new Map<number, (typeof cardsTable.$inferSelect)[]>();
    for (const c of cards) {
      const list = cardsByDeck.get(c.deckId) ?? [];
      list.push(c);
      cardsByDeck.set(c.deckId, list);
    }

    const file: ExportedFile = {
      format: "ankigen-deck",
      version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      root: buildNode(id, allDecks, cardsByDeck),
    };

    const safeName = root.name.replace(/[^a-z0-9_\-]/gi, "_");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}.ankigen.json"`
    );
    res.end(JSON.stringify(file, null, 2));
  } catch (err) {
    next(err);
  }
});

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function validateNode(node: unknown, path: string): string | null {
  if (!node || typeof node !== "object") return `${path}: not an object`;
  const n = node as Record<string, unknown>;
  if (!isString(n.name) || n.name.trim() === "") return `${path}.name missing`;
  if (n.description !== null && n.description !== undefined && !isString(n.description))
    return `${path}.description must be string or null`;
  if (!Array.isArray(n.cards)) return `${path}.cards must be array`;
  if (!Array.isArray(n.subDecks)) return `${path}.subDecks must be array`;
  for (let i = 0; i < n.cards.length; i++) {
    const c = n.cards[i] as Record<string, unknown>;
    if (!c || typeof c !== "object") return `${path}.cards[${i}] not object`;
    if (!isString(c.front)) return `${path}.cards[${i}].front missing`;
    if (!isString(c.back)) return `${path}.cards[${i}].back missing`;
  }
  for (let i = 0; i < n.subDecks.length; i++) {
    const err = validateNode(n.subDecks[i], `${path}.subDecks[${i}]`);
    if (err) return err;
  }
  return null;
}

async function importNode(
  node: ExportedNode,
  parentId: number | null
): Promise<{ deckCount: number; cardCount: number }> {
  const [created] = await db
    .insert(decksTable)
    .values({
      name: node.name,
      description: node.description ?? undefined,
      parentId: parentId ?? undefined,
    })
    .returning();

  let deckCount = 1;
  let cardCount = 0;

  if (node.cards.length > 0) {
    await db.insert(cardsTable).values(
      node.cards.map(c => ({
        deckId: created.id,
        front: c.front,
        back: c.back,
        tags: c.tags ?? undefined,
        image: c.image ?? undefined,
      }))
    );
    cardCount += node.cards.length;
  }

  for (const sub of node.subDecks) {
    const r = await importNode(sub, created.id);
    deckCount += r.deckCount;
    cardCount += r.cardCount;
  }

  return { deckCount, cardCount };
}

router.post("/import-deck-json", async (req, res, next): Promise<void> => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body || body.format !== "ankigen-deck") {
      res.status(400).json({ error: "Not a valid AnkiGen deck file." });
      return;
    }
    if (typeof body.version !== "number" || body.version > FORMAT_VERSION) {
      res.status(400).json({
        error: `Unsupported file version (got ${String(body.version)}, this server supports up to ${FORMAT_VERSION}).`,
      });
      return;
    }
    // Accept either a single { root } or a multi { roots: [...] }
    let inputRoots: ExportedNode[];
    if (Array.isArray(body.roots)) {
      for (let i = 0; i < body.roots.length; i++) {
        const err = validateNode(body.roots[i], `roots[${i}]`);
        if (err) { res.status(400).json({ error: `Invalid file: ${err}` }); return; }
      }
      inputRoots = body.roots as ExportedNode[];
    } else if (body.root) {
      const err = validateNode(body.root, "root");
      if (err) { res.status(400).json({ error: `Invalid file: ${err}` }); return; }
      inputRoots = [body.root as ExportedNode];
    } else {
      res.status(400).json({ error: "File has no 'root' or 'roots' deck data." });
      return;
    }

    if (inputRoots.length === 0) {
      res.status(400).json({ error: "File contains no decks to import." });
      return;
    }

    const allDecks = await db.select({ name: decksTable.name, parentId: decksTable.parentId }).from(decksTable);
    const topNames = new Set(allDecks.filter(d => d.parentId === null).map(d => d.name));

    let totalDecks = 0;
    let totalCards = 0;
    const importedNames: string[] = [];

    for (const root of inputRoots) {
      let importName = root.name;
      if (topNames.has(importName)) {
        let i = 2;
        while (topNames.has(`${root.name} (${i})`)) i++;
        importName = `${root.name} (${i})`;
      }
      topNames.add(importName);

      const r = await importNode({ ...root, name: importName }, null);
      totalDecks += r.deckCount;
      totalCards += r.cardCount;
      importedNames.push(importName);
    }

    res.status(201).json({
      importedName: importedNames.length === 1 ? importedNames[0] : `${importedNames.length} top-level decks`,
      importedNames,
      deckCount: totalDecks,
      cardCount: totalCards,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
