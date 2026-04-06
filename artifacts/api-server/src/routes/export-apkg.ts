import { Router, type IRouter } from "express";
import { createRequire } from "module";
import { createHash } from "crypto";
import { eq, inArray } from "drizzle-orm";
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

/**
 * Add a sub-deck entry to the collection's decks JSON.
 * db: the sql.js Database instance from AnkiExport
 * deckId: new unique integer ID for this sub-deck
 * deckName: full deck name using :: notation e.g. "Family medicine::Chapter 1"
 * templateDeck: the parent deck object to clone structure from
 */
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

/**
 * Insert a note + card directly into the sql.js database.
 * deckId: which deck this card belongs to
 * modelId: note type (model) id — re-use the parent deck's model
 */
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

  // Fetch requested decks
  const requestedDecks = await db.select().from(decksTable).where(inArray(decksTable.id, ids));
  if (requestedDecks.length === 0) {
    res.status(404).json({ error: "No matching decks found." });
    return;
  }

  // For every parent (root) deck selected, also pull in its sub-decks automatically
  const selectedParentIds = requestedDecks.filter(d => !d.parentId).map(d => d.id);
  let autoSubDecks: typeof requestedDecks = [];
  if (selectedParentIds.length > 0) {
    autoSubDecks = await db.select().from(decksTable).where(inArray(decksTable.parentId, selectedParentIds));
  }

  // De-duplicate: merge requested + auto-included sub-decks
  const allDeckMap = new Map([...requestedDecks, ...autoSubDecks].map(d => [d.id, d]));
  const allDecks = Array.from(allDeckMap.values());

  // Fetch all cards
  const allCardIds = allDecks.map(d => d.id);
  const allCards = await db.select().from(cardsTable).where(inArray(cardsTable.deckId, allCardIds)).orderBy(cardsTable.createdAt);

  if (allCards.length === 0) {
    res.status(400).json({ error: "Selected decks have no cards to export." });
    return;
  }

  // Decide root label
  // If exporting one parent → use its name; multiple → use exportName or generic
  const rootParents = allDecks.filter(d => !d.parentId);
  const rootLabel =
    exportName?.trim() ||
    (rootParents.length === 1 ? rootParents[0].name : `${rootParents.length} Decks`);

  // ── Build the .apkg ──────────────────────────────────────────────────────
  //
  // Strategy:
  //   1. Create AnkiExport with rootLabel — this becomes the top-level parent deck.
  //   2. For each sub-deck, manually add a deck entry to the SQLite col.decks JSON
  //      using "ParentName::SubDeckName" notation — Anki reads this to build hierarchy.
  //   3. Insert every card directly via SQL with the correct did (deck id).
  //
  // This produces a single .apkg that Anki imports as a proper nested deck tree.
  // ─────────────────────────────────────────────────────────────────────────

  const apkg = AnkiExport(rootLabel);
  const sqlDb = apkg.db; // sql.js Database instance
  const parentDeckId: number = apkg.topDeckId;
  const modelId: number = apkg.topModelId;

  // Read the parent deck template from the current col.decks
  const colDecksRaw = sqlDb.exec("SELECT decks FROM col WHERE id=1");
  const colDecks = JSON.parse(colDecksRaw[0].values[0][0] as string);
  const templateDeck = colDecks[String(parentDeckId)];

  // Build a map: our DB deck.id → Anki deck id + name
  // Root decks (parentId=null) that are in the selection get mapped to either
  // the single rootLabel deck (if only one parent) or get their own entries.
  const ankiDeckIdMap = new Map<number, { ankiId: number; ankiName: string }>();

  // Assign Anki IDs — start from parentDeckId+1 to avoid collision
  let idCounter = parentDeckId + 1;

  // First pass: root (parent) decks
  for (const deck of allDecks.filter(d => !d.parentId)) {
    if (rootParents.length === 1) {
      // Only one root parent — it IS the top-level deck AnkiExport already created
      ankiDeckIdMap.set(deck.id, { ankiId: parentDeckId, ankiName: rootLabel });
    } else {
      // Multiple root parents — add each as a sub-deck of rootLabel
      const ankiName = `${rootLabel}::${deck.name}`;
      const ankiId = idCounter++;
      addDeckEntry(sqlDb, ankiId, ankiName, templateDeck);
      ankiDeckIdMap.set(deck.id, { ankiId, ankiName });
    }
  }

  // Second pass: sub-decks
  for (const deck of allDecks.filter(d => d.parentId)) {
    const parentEntry = ankiDeckIdMap.get(deck.parentId!);
    const parentAnkiName = parentEntry?.ankiName ?? rootLabel;
    const ankiName = `${parentAnkiName}::${deck.name}`;
    const ankiId = idCounter++;
    addDeckEntry(sqlDb, ankiId, ankiName, templateDeck);
    ankiDeckIdMap.set(deck.id, { ankiId, ankiName });
  }

  // Insert all cards with correct deck IDs
  let offset = 0;
  for (const card of allCards) {
    const entry = ankiDeckIdMap.get(card.deckId);
    if (!entry) continue; // deck not in export set (shouldn't happen)

    const baseTags = card.tags ? card.tags.split(/[\s,]+/).map(t => t.trim()).filter(Boolean) : [];

    insertNoteAndCard(sqlDb, {
      front: card.front,
      back: card.back,
      tags: baseTags,
      deckId: entry.ankiId,
      modelId,
      idOffset: offset,
    });
    offset += 10; // ensure unique IDs within same millisecond
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
