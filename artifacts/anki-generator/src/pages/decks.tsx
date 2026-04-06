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
  Sparkles, BookOpen, MoreHorizontal,
} from "lucide-react";
import { useState, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";
import type { Deck } from "@workspace/api-client-react/src/generated/api.schemas";

type DeckWithParent = Deck & { parentId?: number | null };

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
  const [collapsedTopics, setCollapsedTopics] = useState<Set<number>>(new Set());

  const totalCards = (decks as DeckWithParent[] | undefined)?.reduce((sum, d) => sum + d.cardCount, 0) ?? 0;

  const { rootDecks, subDecksByParent } = useMemo(() => {
    const all = (decks as DeckWithParent[] | undefined) ?? [];
    const root = all.filter(d => !d.parentId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const byParent = new Map<number, DeckWithParent[]>();
    all.filter(d => d.parentId).forEach(d => {
      const pid = d.parentId!;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid)!.push(d);
    });
    return { rootDecks: root, subDecksByParent: byParent };
  }, [decks]);

  const filteredRoot = useMemo(() => {
    if (!search.trim()) return rootDecks;
    const q = search.toLowerCase();
    return rootDecks.filter(d =>
      d.name.toLowerCase().includes(q) ||
      d.description?.toLowerCase().includes(q) ||
      (subDecksByParent.get(d.id) ?? []).some(s => s.name.toLowerCase().includes(q))
    );
  }, [rootDecks, subDecksByParent, search]);

  const allSelectableIds = useMemo(() =>
    ((decks as DeckWithParent[] | undefined) ?? []).map(d => d.id),
    [decks]
  );

  const openDeckForm = (mode: DeckFormMode) => { setDeckFormMode(mode); setDeckFormOpen(true); };

  const handleDelete = (id: number, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!confirm("Delete this deck? Sub-decks will become standalone.")) return;
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
    setCollapsedTopics(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
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
      const resp = await fetch("/api/export-apkg", {
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
      toast({ title: "Export complete", description: `Downloaded ${exportName}.apkg (sub-decks included).` });
    } catch (err) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Something went wrong.", variant: "destructive" });
    } finally { setExporting(false); }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-32">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-primary tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${(decks as DeckWithParent[])?.length ?? 0} deck${((decks as DeckWithParent[])?.length ?? 0) !== 1 ? "s" : ""} · ${totalCards} card${totalCards !== 1 ? "s" : ""} total`}
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
              {/* New Topic button */}
              <Button variant="outline" className="gap-2" onClick={() => openDeckForm({ type: "new-topic" })}>
                <FolderOpen className="h-4 w-4" /> New Topic
              </Button>
              {/* New Deck dropdown */}
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

      {/* Search */}
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

      {/* Deck list */}
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
          {filteredRoot.map((deck, idx) => {
            const subDecks = subDecksByParent.get(deck.id) ?? [];
            const isCollapsed = collapsedTopics.has(deck.id);
            const hasSubDecks = subDecks.length > 0;
            const isSelected = selectedIds.has(deck.id);
            const totalTopicCards = deck.cardCount + subDecks.reduce((s, d) => s + d.cardCount, 0);

            return (
              <div key={deck.id} className="animate-in fade-in slide-in-from-bottom-2" style={{ animationDelay: `${idx * 40}ms` }}>
                {/* Root deck row */}
                <div className="relative group">
                  {selectMode && (
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 z-10" onClick={e => toggleSelect(deck.id, e)}>
                      <Checkbox checked={isSelected} className="h-5 w-5 bg-background border-2 shadow-sm" />
                    </div>
                  )}
                  <Link href={selectMode ? "#" : `/decks/${deck.id}`}>
                    <Card
                      className={`cursor-pointer transition-all border shadow-sm ${
                        selectMode
                          ? isSelected ? "border-primary ring-2 ring-primary/30 bg-primary/5" : "border-border/50 opacity-80"
                          : "hover:border-primary/40 hover:shadow-md border-border/50"
                      }`}
                      onClick={selectMode ? e => toggleSelect(deck.id, e as React.MouseEvent) : undefined}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                          {hasSubDecks && !selectMode && (
                            <button className="text-muted-foreground hover:text-foreground shrink-0" onClick={e => toggleCollapse(deck.id, e)}>
                              {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </button>
                          )}
                          <div className={`h-9 w-9 rounded-md flex items-center justify-center shrink-0 ${hasSubDecks ? "bg-primary/15" : "bg-primary/10"}`}>
                            {hasSubDecks ? <FolderOpen className="h-4 w-4 text-primary" /> : <Layers className="h-4 w-4 text-primary" />}
                          </div>
                          <div className={`flex-1 min-w-0 ${selectMode ? "pl-5" : ""}`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-semibold truncate">{deck.name}</p>
                              {hasSubDecks && (
                                <Badge variant="outline" className="text-xs shrink-0">
                                  {subDecks.length} sub-deck{subDecks.length !== 1 ? "s" : ""}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {format(new Date(deck.createdAt), "MMM d, yyyy")}
                              {deck.description ? ` · ${deck.description}` : ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                            <span className="text-sm font-medium text-primary bg-primary/10 px-2.5 py-1 rounded-md">
                              {hasSubDecks ? totalTopicCards : deck.cardCount} card{(hasSubDecks ? totalTopicCards : deck.cardCount) !== 1 ? "s" : ""}
                            </span>
                            {!selectMode && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost" size="icon"
                                    className="h-8 w-8 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                    onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                                  >
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem className="gap-2 cursor-pointer" onClick={e => { e.preventDefault(); e.stopPropagation(); openDeckForm({ type: "edit", deck }); }}>
                                    <Pencil className="h-4 w-4" /> Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem className="gap-2 cursor-pointer" onClick={e => { e.preventDefault(); e.stopPropagation(); openDeckForm({ type: "new-subdeck", parentId: deck.id }); }}>
                                    <Plus className="h-4 w-4" /> Add sub-deck
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem className="gap-2 cursor-pointer text-destructive focus:text-destructive" onClick={e => handleDelete(deck.id, e)}>
                                    <Trash2 className="h-4 w-4" /> Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                </div>

                {/* Sub-decks */}
                {hasSubDecks && !isCollapsed && (
                  <div className="ml-6 mt-1.5 space-y-1 border-l-2 border-primary/20 pl-4">
                    {subDecks
                      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
                      .map(sub => {
                        const subSelected = selectedIds.has(sub.id);
                        return (
                          <div key={sub.id} className="relative group">
                            {selectMode && (
                              <div className="absolute left-3 top-1/2 -translate-y-1/2 z-10" onClick={e => toggleSelect(sub.id, e)}>
                                <Checkbox checked={subSelected} className="h-4 w-4 bg-background border-2 shadow-sm" />
                              </div>
                            )}
                            <Link href={selectMode ? "#" : `/decks/${sub.id}`}>
                              <Card
                                className={`cursor-pointer transition-all border shadow-sm ${
                                  selectMode
                                    ? subSelected ? "border-primary ring-1 ring-primary/20 bg-primary/5" : "border-border/30 opacity-80"
                                    : "hover:border-primary/30 hover:shadow-sm border-border/30 bg-muted/20"
                                }`}
                                onClick={selectMode ? e => toggleSelect(sub.id, e as React.MouseEvent) : undefined}
                              >
                                <CardContent className="py-2.5 px-3">
                                  <div className="flex items-center gap-2.5">
                                    <div className="h-7 w-7 rounded-md bg-blue-500/10 flex items-center justify-center shrink-0">
                                      <FileText className="h-3.5 w-3.5 text-blue-500" />
                                    </div>
                                    <div className={`flex-1 min-w-0 ${selectMode ? "pl-5" : ""}`}>
                                      <p className="text-sm font-medium truncate">{sub.name}</p>
                                      <p className="text-xs text-muted-foreground">{format(new Date(sub.createdAt), "MMM d, yyyy")}</p>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded">
                                        {sub.cardCount} card{sub.cardCount !== 1 ? "s" : ""}
                                      </span>
                                      {!selectMode && (
                                        <DropdownMenu>
                                          <DropdownMenuTrigger asChild>
                                            <Button
                                              variant="ghost" size="icon"
                                              className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                              onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                                            >
                                              <MoreHorizontal className="h-3.5 w-3.5" />
                                            </Button>
                                          </DropdownMenuTrigger>
                                          <DropdownMenuContent align="end">
                                            <DropdownMenuItem className="gap-2 cursor-pointer" onClick={e => { e.preventDefault(); e.stopPropagation(); openDeckForm({ type: "edit", deck: sub }); }}>
                                              <Pencil className="h-4 w-4" /> Edit
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem className="gap-2 cursor-pointer text-destructive focus:text-destructive" onClick={e => handleDelete(sub.id, e)}>
                                              <Trash2 className="h-4 w-4" /> Delete
                                            </DropdownMenuItem>
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                                      )}
                                    </div>
                                  </div>
                                </CardContent>
                              </Card>
                            </Link>
                          </div>
                        );
                      })}
                    {/* Add sub-deck inline button */}
                    {!selectMode && (
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-primary transition-colors rounded-md hover:bg-primary/5"
                        onClick={() => openDeckForm({ type: "new-subdeck", parentId: deck.id })}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add sub-deck to <span className="font-medium">{deck.name}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <GenerateSheet open={generateSheetOpen} onOpenChange={setGenerateSheetOpen} />
      <DeckFormSheet open={deckFormOpen} onOpenChange={setDeckFormOpen} mode={deckFormMode} />

      {/* Floating export bar */}
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
