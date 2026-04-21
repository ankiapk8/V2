import { Link } from "wouter";
import { useListDecks, useDeleteDeck, getListDecksQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GenerateSheet } from "@/components/generate-sheet";
import { DeckFormSheet, type DeckFormMode } from "@/components/deck-form-sheet";
import {
  Trash2, Layers, Plus, Download, CheckSquare, X, Search,
  FileText, FolderOpen, ChevronDown, ChevronRight, Pencil,
  Sparkles, BookOpen, Upload,
} from "lucide-react";
import { useState, useMemo, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { apiUrl } from "@/lib/utils";
import type { Deck } from "@workspace/api-client-react/src/generated/api.schemas";

type DeckWithParent = Deck & { parentId?: number | null };

function getAllDescendants(deckId: number, childrenMap: Map<number, DeckWithParent[]>): DeckWithParent[] {
  const direct = childrenMap.get(deckId) ?? [];
  return [...direct, ...direct.flatMap(d => getAllDescendants(d.id, childrenMap))];
}

type DeckRowProps = {
  deck: DeckWithParent;
  depth: number;
  collapsedIds: Set<number>;
  toggleCollapse: (id: number, e: React.MouseEvent) => void;
  deckChildrenMap: Map<number, DeckWithParent[]>;
  selectMode: boolean;
  selectedIds: Set<number>;
  toggleSelect: (id: number, e: React.MouseEvent) => void;
  openDeckForm: (mode: DeckFormMode) => void;
  handleDelete: (id: number, e: React.MouseEvent) => void;
};

function DeckRow({
  deck, depth, collapsedIds, toggleCollapse,
  deckChildrenMap, selectMode, selectedIds, toggleSelect,
  openDeckForm, handleDelete,
}: DeckRowProps) {
  const children = (deckChildrenMap.get(deck.id) ?? []).sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );
  const hasChildren = children.length > 0;
  const isCollapsed = collapsedIds.has(deck.id);
  const isSelected = selectedIds.has(deck.id);
  const allDescendants = getAllDescendants(deck.id, deckChildrenMap);
  const totalCards = deck.cardCount + allDescendants.reduce((s, d) => s + d.cardCount, 0);

  const clampedDepth = Math.min(depth, 2);

  const cardClass = [
    "cursor-pointer transition-all border",
    clampedDepth === 0
      ? "border-border/50 shadow-sm hover:border-primary/40 hover:shadow-md"
      : clampedDepth === 1
      ? "border-border/30 bg-muted/20 hover:border-primary/30 hover:shadow-sm"
      : "border-border/20 bg-muted/30 hover:border-primary/20",
    selectMode
      ? isSelected ? "border-primary ring-1 ring-primary/20 bg-primary/5" : "opacity-80"
      : "",
  ].join(" ");

  const iconBg = clampedDepth === 0
    ? (hasChildren ? "bg-primary/15" : "bg-primary/10")
    : clampedDepth === 1
    ? (hasChildren ? "bg-blue-500/15" : "bg-blue-500/10")
    : (hasChildren ? "bg-violet-500/15" : "bg-violet-500/10");

  const iconColor = clampedDepth === 0 ? "text-primary" : clampedDepth === 1 ? "text-blue-500" : "text-violet-500";
  const iconBoxSize = clampedDepth === 0 ? "h-9 w-9" : clampedDepth === 1 ? "h-7 w-7" : "h-6 w-6";
  const iconSize = clampedDepth === 0 ? "h-4 w-4" : clampedDepth === 1 ? "h-3.5 w-3.5" : "h-3 w-3";
  const cardPadding = clampedDepth === 0 ? "p-4" : clampedDepth === 1 ? "py-2.5 px-3" : "py-2 px-3";
  const nameClass = clampedDepth === 0 ? "font-semibold" : clampedDepth === 1 ? "text-sm font-medium" : "text-xs font-medium";
  const chevronClass = clampedDepth === 0 ? "h-4 w-4" : "h-3.5 w-3.5";
  const checkboxClass = clampedDepth === 0 ? "h-5 w-5" : "h-4 w-4";
  const btnSize = clampedDepth === 0 ? "h-8 w-8" : "h-7 w-7";
  const btnIconSize = clampedDepth === 0 ? "h-3.5 w-3.5" : "h-3 w-3";
  const cardCount = hasChildren ? totalCards : deck.cardCount;
  const cardCountClass = clampedDepth === 0
    ? "text-sm font-medium text-primary bg-primary/10 px-2.5 py-1 rounded-md"
    : "text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded";

  const indentClass = depth === 0
    ? ""
    : depth === 1
    ? "ml-6 mt-1.5 space-y-1 border-l-2 border-primary/20 pl-4"
    : "ml-5 mt-1 space-y-1 border-l-2 border-blue-200/40 pl-3";

  const addBtnHover = depth <= 1
    ? "hover:text-primary hover:bg-primary/5"
    : "hover:text-violet-500 hover:bg-violet-500/5";

  return (
    <div>
      <div className="relative group">
        {selectMode && (
          <div
            className="absolute left-3 top-1/2 -translate-y-1/2 z-10"
            onClick={e => toggleSelect(deck.id, e)}
          >
            <Checkbox checked={isSelected} className={`${checkboxClass} bg-background border-2 shadow-sm`} />
          </div>
        )}
        <Link href={selectMode ? "#" : `/decks/${deck.id}`}>
          <Card
            className={cardClass}
            onClick={selectMode ? e => toggleSelect(deck.id, e as React.MouseEvent) : undefined}
          >
            <CardContent className={cardPadding}>
              <div className="flex items-center gap-2.5">
                {hasChildren && !selectMode && (
                  <button
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    onClick={e => toggleCollapse(deck.id, e)}
                  >
                    {isCollapsed
                      ? <ChevronRight className={chevronClass} />
                      : <ChevronDown className={chevronClass} />}
                  </button>
                )}
                <div className={`${iconBoxSize} rounded-md flex items-center justify-center shrink-0 ${iconBg}`}>
                  {hasChildren
                    ? <FolderOpen className={`${iconSize} ${iconColor}`} />
                    : depth === 0
                    ? <Layers className={`${iconSize} ${iconColor}`} />
                    : <FileText className={`${iconSize} ${iconColor}`} />}
                </div>
                <div className={`flex-1 min-w-0 ${selectMode ? "pl-5" : ""}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`${nameClass} truncate`}>{deck.name}</p>
                    {hasChildren && (
                      <Badge variant="outline" className="text-xs shrink-0 py-0 px-1.5">
                        {children.length} sub-deck{children.length !== 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {format(new Date(deck.createdAt), "MMM d, yyyy")}
                    {depth === 0 && deck.description ? ` · ${deck.description}` : ""}
                  </p>
                  {hasChildren && isCollapsed && !selectMode && (
                    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                      {children.slice(0, 4).map(child => (
                        <span
                          key={child.id}
                          className="inline-flex items-center gap-1 text-[11px] bg-muted/60 text-muted-foreground border border-border/40 rounded px-1.5 py-0.5 font-medium"
                        >
                          <FileText className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate max-w-[80px]">{child.name}</span>
                          <span className="shrink-0 text-primary font-semibold">{child.cardCount}</span>
                        </span>
                      ))}
                      {children.length > 4 && (
                        <span className="text-[11px] text-muted-foreground">+{children.length - 4} more</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                  <span className={cardCountClass}>
                    {cardCount} card{cardCount !== 1 ? "s" : ""}
                  </span>
                  {!selectMode && (
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost" size="icon"
                        className={`${btnSize} text-muted-foreground hover:text-foreground`}
                        title="Edit"
                        onClick={e => { e.preventDefault(); e.stopPropagation(); openDeckForm({ type: "edit", deck }); }}
                      >
                        <Pencil className={btnIconSize} />
                      </Button>
                      <Button
                        variant="ghost" size="icon"
                        className={`${btnSize} text-muted-foreground hover:text-destructive hover:bg-destructive/10`}
                        title="Delete"
                        onClick={e => handleDelete(deck.id, e)}
                      >
                        <Trash2 className={btnIconSize} />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {hasChildren && !isCollapsed && (
        <div className={indentClass}>
          {children.map(child => (
            <DeckRow
              key={child.id}
              deck={child}
              depth={depth + 1}
              collapsedIds={collapsedIds}
              toggleCollapse={toggleCollapse}
              deckChildrenMap={deckChildrenMap}
              selectMode={selectMode}
              selectedIds={selectedIds}
              toggleSelect={toggleSelect}
              openDeckForm={openDeckForm}
              handleDelete={handleDelete}
            />
          ))}
          {!selectMode && (
            <button
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors rounded-md ${addBtnHover}`}
              onClick={() => openDeckForm({ type: "new-subdeck", parentId: deck.id })}
            >
              <Plus className="h-3 w-3" />
              Add sub-deck to <span className="font-medium ml-0.5">{deck.name}</span>
            </button>
          )}
        </div>
      )}

      {!hasChildren && !selectMode && depth > 0 && (
        <div className="ml-5 mt-0.5">
          <button
            className={`flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground transition-colors rounded ${addBtnHover}`}
            onClick={() => openDeckForm({ type: "new-subdeck", parentId: deck.id })}
          >
            <Plus className="h-3 w-3" />
            Add sub-deck
          </button>
        </div>
      )}
    </div>
  );
}

export default function Decks() {
  const { data: decks, isLoading } = useListDecks();
  const deleteDeck = useDeleteDeck();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [generateSheetOpen, setGenerateSheetOpen] = useState(false);
  const [deckFormOpen, setDeckFormOpen] = useState(false);
  const [deckFormMode, setDeckFormMode] = useState<DeckFormMode>({ type: "new-topic" });
  const [search, setSearch] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleImportJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch { throw new Error("That file isn't valid JSON."); }
      const resp = await fetch(apiUrl("api/import-deck-json"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error ?? "Import failed.");
      queryClient.invalidateQueries({ queryKey: getListDecksQueryKey() });
      toast({
        title: "Deck imported",
        description: `“${data.importedName}” added — ${data.deckCount} deck${data.deckCount !== 1 ? "s" : ""}, ${data.cardCount} card${data.cardCount !== 1 ? "s" : ""}.`,
      });
    } catch (err) {
      toast({ title: "Import failed", description: err instanceof Error ? err.message : "Something went wrong.", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set());
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!decks || initializedRef.current) return;
    const all = decks as DeckWithParent[];
    const parentIds = all.filter(d => d.parentId).map(d => d.parentId!);
    const parentSet = new Set(parentIds);
    const toCollapse = all.filter(d => parentSet.has(d.id)).map(d => d.id);
    if (toCollapse.length > 0) {
      setCollapsedIds(new Set(toCollapse));
      initializedRef.current = true;
    }
  }, [decks]);

  const totalCards = (decks as DeckWithParent[] | undefined)?.reduce((sum, d) => sum + d.cardCount, 0) ?? 0;

  const { rootDecks, deckChildrenMap } = useMemo(() => {
    const all = (decks as DeckWithParent[] | undefined) ?? [];
    const root = all.filter(d => !d.parentId).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const byParent = new Map<number, DeckWithParent[]>();
    all.filter(d => d.parentId).forEach(d => {
      const pid = d.parentId!;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid)!.push(d);
    });
    return { rootDecks: root, deckChildrenMap: byParent };
  }, [decks]);

  const filteredRoot = useMemo(() => {
    if (!search.trim()) return rootDecks;
    const q = search.toLowerCase();
    function matchesSearch(d: DeckWithParent): boolean {
      if (d.name.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q)) return true;
      return (deckChildrenMap.get(d.id) ?? []).some(child => matchesSearch(child));
    }
    return rootDecks.filter(d => matchesSearch(d));
  }, [rootDecks, deckChildrenMap, search]);

  const allSelectableIds = useMemo(
    () => ((decks as DeckWithParent[] | undefined) ?? []).map(d => d.id),
    [decks]
  );

  const openDeckForm = (mode: DeckFormMode) => { setDeckFormMode(mode); setDeckFormOpen(true); };

  const handleDelete = (id: number, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const all = (decks as DeckWithParent[] | undefined) ?? [];
    function collectDescendants(pid: number): DeckWithParent[] {
      const direct = all.filter(d => d.parentId === pid);
      return [...direct, ...direct.flatMap(d => collectDescendants(d.id))];
    }
    const descendants = collectDescendants(id);
    const target = all.find(d => d.id === id);
    const totalCards = (target?.cardCount ?? 0) + descendants.reduce((s, d) => s + d.cardCount, 0);
    const msg = descendants.length > 0
      ? `Delete "${target?.name}" and ALL ${descendants.length} sub-deck${descendants.length !== 1 ? "s" : ""} inside it?\n\nThis will permanently remove ${totalCards} card${totalCards !== 1 ? "s" : ""}. This cannot be undone.`
      : `Delete "${target?.name}"? This will permanently remove ${totalCards} card${totalCards !== 1 ? "s" : ""}. This cannot be undone.`;
    if (!confirm(msg)) return;
    deleteDeck.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDecksQueryKey() });
        setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
        toast({ title: "Deck deleted." });
      },
    });
  };

  const toggleCollapse = (id: number, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setCollapsedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const toggleSelect = (id: number, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === allSelectableIds.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(allSelectableIds));
  };

  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()); };

  const handleExportApkg = async () => {
    if (selectedIds.size === 0) return;
    setExporting(true);
    try {
      const deckIds = Array.from(selectedIds);
      const selectedDecks = (decks as DeckWithParent[] | undefined)?.filter(d => selectedIds.has(d.id)) ?? [];
      const exportName = selectedDecks.length === 1 ? selectedDecks[0].name : `${selectedDecks.length} Decks`;
      const resp = await fetch(apiUrl("api/export-apkg"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckIds, exportName }),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error ?? "Export failed.");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: `${exportName.replace(/[^a-z0-9_\-]/gi, "_")}.apkg` });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: `Downloaded ${exportName}.apkg (all nested decks included).` });
    } catch (err) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Something went wrong.", variant: "destructive" });
    } finally { setExporting(false); }
  };

  const sharedRowProps = {
    collapsedIds,
    toggleCollapse,
    deckChildrenMap,
    selectMode,
    selectedIds,
    toggleSelect,
    openDeckForm,
    handleDelete,
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-32">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-primary tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-1">
            {isLoading
              ? "Loading…"
              : `${(decks as DeckWithParent[])?.length ?? 0} deck${((decks as DeckWithParent[])?.length ?? 0) !== 1 ? "s" : ""} · ${totalCards} card${totalCards !== 1 ? "s" : ""} total`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!selectMode ? (
            <>
              {((decks as DeckWithParent[])?.length ?? 0) > 0 && (
                <Button variant="outline" className="gap-2" onClick={() => setSelectMode(true)}>
                  <CheckSquare className="h-4 w-4" /> Select
                </Button>
              )}
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
                title="Import a deck from another device (.ankigen.json)"
              >
                <Upload className="h-4 w-4" /> {importing ? "Importing…" : "Import"}
              </Button>
              <input
                ref={importInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleImportJson}
              />
              <Button variant="outline" className="gap-2" onClick={() => openDeckForm({ type: "new-topic" })}>
                <FolderOpen className="h-4 w-4" /> New Topic
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className="gap-2">
                    <Plus className="h-4 w-4" /> New Deck
                    <ChevronDown className="h-3.5 w-3.5 ml-0.5 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => setGenerateSheetOpen(true)}>
                    <Sparkles className="h-4 w-4 text-primary" />
                    <div>
                      <div className="text-sm font-medium">Generate with AI</div>
                      <div className="text-xs text-muted-foreground">From files or text</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => openDeckForm({ type: "new-subdeck" })}>
                    <FileText className="h-4 w-4 text-blue-500" />
                    <div>
                      <div className="text-sm font-medium">Empty Sub-deck</div>
                      <div className="text-xs text-muted-foreground">Inside a topic</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2.5 cursor-pointer" onClick={() => openDeckForm({ type: "new-topic" })}>
                    <FolderOpen className="h-4 w-4 text-primary" />
                    <div>
                      <div className="text-sm font-medium">New Main Topic</div>
                      <div className="text-xs text-muted-foreground">With optional sub-decks</div>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={toggleSelectAll} className="text-muted-foreground">
                {selectedIds.size === allSelectableIds.length ? "Deselect all" : "Select all"}
              </Button>
              <Button variant="ghost" size="icon" onClick={exitSelectMode} className="text-muted-foreground">
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {((decks as DeckWithParent[])?.length ?? 0) > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input placeholder="Search decks…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-4">{[1, 2, 3].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      ) : rootDecks.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed rounded-xl bg-card">
          <BookOpen className="mx-auto h-12 w-12 text-muted-foreground opacity-40 mb-4" />
          <h3 className="text-lg font-medium mb-1">No decks yet</h3>
          <p className="text-muted-foreground text-sm mb-5">Start by creating a main topic or generating cards with AI.</p>
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => openDeckForm({ type: "new-topic" })}>
              <FolderOpen className="mr-2 h-4 w-4" /> New Topic
            </Button>
            <Button onClick={() => setGenerateSheetOpen(true)}>
              <Sparkles className="mr-2 h-4 w-4" /> Generate with AI
            </Button>
          </div>
        </div>
      ) : filteredRoot.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed rounded-xl bg-card">
          <Search className="mx-auto h-10 w-10 text-muted-foreground opacity-40 mb-3" />
          <p className="font-medium">No decks match "{search}"</p>
          <Button variant="ghost" className="mt-2" onClick={() => setSearch("")}>Clear search</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredRoot.map((deck, idx) => (
            <div key={deck.id} className="animate-in fade-in slide-in-from-bottom-2" style={{ animationDelay: `${idx * 40}ms` }}>
              <DeckRow deck={deck} depth={0} {...sharedRowProps} />
            </div>
          ))}
        </div>
      )}

      <GenerateSheet open={generateSheetOpen} onOpenChange={setGenerateSheetOpen} />
      <DeckFormSheet open={deckFormOpen} onOpenChange={setDeckFormOpen} mode={deckFormMode} />

      {selectMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 duration-200">
          <div className="flex items-center gap-3 bg-card border border-border shadow-2xl rounded-2xl px-5 py-3">
            <span className="text-sm font-medium">
              {selectedIds.size === 0 ? "Select decks to export" : `${selectedIds.size} selected`}
            </span>
            <Button onClick={handleExportApkg} disabled={selectedIds.size === 0 || exporting} className="gap-2">
              <Download className="h-4 w-4" />
              {exporting ? "Exporting…" : "Export .apkg"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
