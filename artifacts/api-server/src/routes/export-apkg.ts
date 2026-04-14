import { Router, type IRouter } from "express";
import { createRequire } from "module";
import { createHash } from "crypto";
import { inArray } from "drizzle-orm";
import { db, decksTable, cardsTable } from "@workspace/db";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AnkiExport: any = require("anki-apkg-export").default;

const router: IRouter = Router();

function sha1(str: string): string {
  return createHash("sha1").update(str).digest("hex");
}

function ankiChecksum(str: string): number {
  return parseInt(sha1(str).substring(0, 8), 16);
}

const SEPARATOR = "\u001F";

function addDeckEntry(sqlDb: any, deckId: number, deckName: string, templateDeck: Record<string, unknown>): void {
  const raw = sqlDb.exec("SELECT decks FROM col WHERE id=1");
  const decks = JSON.parse(raw[0].values[0][0] as string);
  decks[String(deckId)] = {
    ...templateDeck,
    id: deckId,
    name: deckName,
    mod: Math.floor(Date.now() / 1000),
  };
  sqlDb.prepare("UPDATE col SET decks=:d WHERE id=1").getAsObject({ ":d": JSON.stringify(decks) });
}

function insertNoteAndCard(
  sqlDb: any,
  { front, back, tags, deckId, modelId, idOffset }: {
    front: string; back: string; tags: string[]; deckId: number; modelId: number; idOffset: number;
  }
): void {
  const flds = front + SEPARATOR + back;
  const guid = sha1(`${deckId}${front}${back}`);
  const strTags = tags.length ? " " + tags.map(t => t.replace(/\s+/g, "_")).join(" ") + " " : "";

  const noteId = Date.now() + idOffset;
  const cardId = Date.now() + idOffset + 1;
  const mod = Math.floor(Date.now() / 1000);

  sqlDb.prepare(
    "INSERT OR REPLACE INTO notes VALUES(:id,:guid,:mid,:mod,:usn,:tags,:flds,:sfld,:csum,:flags,:data)"
  ).getAsObject({
    ":id": noteId,
    ":guid": guid,
    ":mid": modelId,
    ":mod": mod,
    ":usn": -1,
    ":tags": strTags,
    ":flds": flds,
    ":sfld": front,
    ":csum": ankiChecksum(flds),
    ":flags": 0,
    ":data": "",
  });

  sqlDb.prepare(
    "INSERT OR REPLACE INTO cards VALUES(:id,:nid,:did,:ord,:mod,:usn,:type,:queue,:due,:ivl,:factor,:reps,:lapses,:left,:odue,:odid,:flags,:data)"
  ).getAsObject({
    ":id": cardId,
    ":nid": noteId,
    ":did": deckId,
    ":ord": 0,
    ":mod": mod,
    ":usn": -1,
    ":type": 0,
    ":queue": 0,
    ":due": 179,
    ":ivl": 0,
    ":factor": 0,
    ":reps": 0,
    ":lapses": 0,
    ":left": 0,
    ":odue": 0,
    ":odid": 0,
    ":flags": 0,
    ":data": "",
  });
}

/**
 * Recursively register all descendant decks in the Anki SQLite col.decks JSON.
 * Returns the updated idCounter.
 */
function registerDescendants(
  allDecks: (typeof decksTable.$inferSelect)[],
  parentDbId: number,
  parentAnkiName: string,
  idCounter: number,
  ankiDeckIdMap: Map<number, { ankiId: number; ankiName: string }>,
  sqlDb: any,
  templateDeck: Record<string, unknown>
): number {
  const children = allDecks.filter(d => d.parentId === parentDbId);
  for (const child of children) {
    const ankiName = `${parentAnkiName}::${child.name}`;
    const ankiId = idCounter++;
    addDeckEntry(sqlDb, ankiId, ankiName, templateDeck);
    ankiDeckIdMap.set(child.id, { ankiId, ankiName });
    idCounter = registerDescendants(allDecks, child.id, ankiName, idCounter, ankiDeckIdMap, sqlDb, templateDeck);
  }
  return idCounter;
}

/**
 * Collect all descendant IDs for a set of deck IDs (recursive, in-memory).
 */
function collectAllDescendantIds(
  allDecks: (typeof decksTable.$inferSelect)[],
  parentIds: number[]
): number[] {
  const direct = allDecks.filter(d => d.parentId !== null && parentIds.includes(d.parentId!));
  if (direct.length === 0) return [];
  return [...direct.map(d => d.id), ...collectAllDescendantIds(allDecks, direct.map(d => d.id))];
}

router.post("/export-apkg", async (req, res): Promise<void> => {
  const { deckIds, exportName } = req.body as {
    deckIds?: number[];
    exportName?: string;
  };

  if (!Array.isArray(deckIds) || deckIds.length === 0) {
    res.status(400).json({ error: "deckIds must be a non-empty array." });
    return;
  }

  const ids = deckIds.map(id => Number(id)).filter(id => !isNaN(id));
  if (ids.length === 0) {
    res.status(400).json({ error: "No valid deck IDs provided." });
    return;
  }

  // Fetch ALL decks from DB so we can resolve the full hierarchy in-memory
  const allDecksInDb = await db.select().from(decksTable);

  // Fetch requested decks
  const requestedDecks = allDecksInDb.filter(d => ids.includes(d.id));
  if (requestedDecks.length === 0) {
    res.status(404).json({ error: "No matching decks found." });
    return;
  }

  // Auto-include ALL descendants of selected decks (any depth)
  const allDescendantIds = collectAllDescendantIds(allDecksInDb, ids);
  const autoDecks = allDecksInDb.filter(d => allDescendantIds.includes(d.id) && !ids.includes(d.id));

  // De-duplicate
  const allDeckMap = new Map([...requestedDecks, ...autoDecks].map(d => [d.id, d]));
  const allDecks = Array.from(allDeckMap.values());

  // Fetch all cards
  const allCardIds = allDecks.map(d => d.id);
  const allCards = await db.select().from(cardsTable).where(inArray(cardsTable.deckId, allCardIds)).orderBy(cardsTable.createdAt);

  if (allCards.length === 0) {
    res.status(400).json({ error: "Selected decks have no cards to export." });
    return;
  }

  // Determine root label and root decks
  // A "root" for export purposes is any selected deck whose parent is NOT in the export set.
  const allExportIds = new Set(allDecks.map(d => d.id));
  const exportRoots = allDecks.filter(d => !d.parentId || !allExportIds.has(d.parentId));

  const rootLabel =
    exportName?.trim() ||
    (exportRoots.length === 1 ? exportRoots[0].name : `${exportRoots.length} Decks`);

  // ── Build the .apkg ──────────────────────────────────────────────────────
  const apkg = AnkiExport(rootLabel);
  const sqlDb = apkg.db;
  const parentDeckId: number = apkg.topDeckId;
  const modelId: number = apkg.topModelId;

  const colDecksRaw = sqlDb.exec("SELECT decks FROM col WHERE id=1");
  const colDecks = JSON.parse(colDecksRaw[0].values[0][0] as string);
  const templateDeck = colDecks[String(parentDeckId)];

  const ankiDeckIdMap = new Map<number, { ankiId: number; ankiName: string }>();
  let idCounter = parentDeckId + 1;

  if (exportRoots.length === 1) {
    // Single root — it IS the top-level AnkiExport deck
    const root = exportRoots[0];
    ankiDeckIdMap.set(root.id, { ankiId: parentDeckId, ankiName: rootLabel });
    // Recursively register all children
    idCounter = registerDescendants(allDecksInDb, root.id, rootLabel, idCounter, ankiDeckIdMap, sqlDb, templateDeck);
  } else {
    // Multiple roots — each becomes a child of the rootLabel deck
    for (const root of exportRoots) {
      const ankiName = `${rootLabel}::${root.name}`;
      const ankiId = idCounter++;
      addDeckEntry(sqlDb, ankiId, ankiName, templateDeck);
      ankiDeckIdMap.set(root.id, { ankiId, ankiName });
      idCounter = registerDescendants(allDecksInDb, root.id, ankiName, idCounter, ankiDeckIdMap, sqlDb, templateDeck);
    }
  }

  // Insert all cards
  let offset = 0;
  for (const card of allCards) {
    const entry = ankiDeckIdMap.get(card.deckId);
    if (!entry) continue;

    const baseTags = card.tags ? card.tags.split(/[\s,]+/).map((t: string) => t.trim()).filter(Boolean) : [];

    insertNoteAndCard(sqlDb, {
      front: card.front,
      back: card.back,
      tags: baseTags,
      deckId: entry.ankiId,
      modelId,
      idOffset: offset,
    });
    offset += 10;
  }

  const zipBuffer: Buffer = await apkg.save();

  const safeName = rootLabel.replace(/[^a-z0-9_\-]/gi, "_");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.apkg"`);
  res.setHeader("Content-Length", zipBuffer.length);

  req.log.info(
    { deckCount: allDecks.length, cardCount: allCards.length },
    "Exported hierarchical .apkg"
  );

  res.end(zipBuffer);
});

export default router;
