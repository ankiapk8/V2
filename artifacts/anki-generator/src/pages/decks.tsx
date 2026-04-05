import { Link } from "wouter";
import { useListDecks, useCreateDeck, useDeleteDeck, getListDecksQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Trash2, Layers, Plus, Download, CheckSquare, X, Search, FileText } from "lucide-react";
import { useState, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";

export default function Decks() {
  const { data: decks, isLoading } = useListDecks();
  const deleteDeck = useDeleteDeck();
  const createDeck = useCreateDeck();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [newDeckName, setNewDeckName] = useState("");
  const [newDeckDesc, setNewDeckDesc] = useState("");
  const [search, setSearch] = useState("");

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);

  const totalCards = decks?.reduce((sum, d) => sum + d.cardCount, 0) ?? 0;

  const filteredDecks = useMemo(() => {
    const sorted = [...(decks ?? [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    if (!search.trim()) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(d => d.name.toLowerCase().includes(q) || d.description?.toLowerCase().includes(q));
  }, [decks, search]);

  const handleCreate = () => {
    if (!newDeckName.trim()) return;
    createDeck.mutate(
      { data: { name: newDeckName, description: newDeckDesc } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListDecksQueryKey() });
          setCreateOpen(false);
          setNewDeckName("");
          setNewDeckDesc("");
          toast({ title: "Deck created successfully." });
        },
      }
    );
  };

  const handleDelete = (id: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm("Are you sure you want to delete this deck?")) {
      deleteDeck.mutate(
        { id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListDecksQueryKey() });
            setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
            toast({ title: "Deck deleted." });
          },
        }
      );
    }
  };

  const toggleSelect = (id: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!filteredDecks) return;
    if (selectedIds.size === filteredDecks.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(filteredDecks.map(d => d.id)));
  };

  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()); };

  const handleExportApkg = async () => {
    if (selectedIds.size === 0) return;
    setExporting(true);
    try {
      const deckIds = Array.from(selectedIds);
      const selectedDecks = decks?.filter(d => selectedIds.has(d.id)) ?? [];
      const exportName = selectedDecks.length === 1 ? selectedDecks[0].name : `${selectedDecks.length} Decks`;
      const response = await fetch("/api/export-apkg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckIds, exportName }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Export failed." }));
        throw new Error(err.error ?? "Export failed.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${exportName.replace(/[^a-z0-9_\-]/gi, "_")}.apkg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: `Downloaded ${exportName}.apkg with cards from ${selectedDecks.length} deck${selectedDecks.length > 1 ? "s" : ""}.` });
    } catch (err: unknown) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Something went wrong.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-32">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-primary tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${decks?.length ?? 0} deck${(decks?.length ?? 0) !== 1 ? "s" : ""} · ${totalCards} card${totalCards !== 1 ? "s" : ""} total`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!selectMode ? (
            <>
              {(decks?.length ?? 0) > 0 && (
                <Button variant="outline" className="gap-2" onClick={() => setSelectMode(true)}>
                  <CheckSquare className="h-4 w-4" />
                  Select
                </Button>
              )}
              <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogTrigger asChild>
                  <Button className="gap-2">
                    <Plus className="h-4 w-4" />
                    New Deck
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create New Deck</DialogTitle>
                    <DialogDescription>Create an empty deck to add cards to later.</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Name</Label>
                      <Input id="name" value={newDeckName} onChange={e => setNewDeckName(e.target.value)} placeholder="e.g. Spanish Vocab" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="desc">Description (Optional)</Label>
                      <Textarea id="desc" value={newDeckDesc} onChange={e => setNewDeckDesc(e.target.value)} placeholder="What is this deck for?" />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button onClick={handleCreate} disabled={!newDeckName.trim() || createDeck.isPending}>Create</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={toggleSelectAll} className="text-muted-foreground">
                {selectedIds.size === filteredDecks.length ? "Deselect all" : "Select all"}
              </Button>
              <Button variant="ghost" size="icon" onClick={exitSelectMode} className="text-muted-foreground">
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Search bar */}
      {(decks?.length ?? 0) > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search decks…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {/* Deck grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-48 rounded-xl" />)}
        </div>
      ) : decks?.length === 0 ? (
        <div className="text-center py-20 border-2 border-dashed rounded-xl bg-card">
          <Layers className="mx-auto h-12 w-12 text-muted-foreground opacity-50" />
          <h3 className="mt-4 text-lg font-medium">No decks yet</h3>
          <p className="text-muted-foreground mt-1 mb-4">Start by generating cards from your study material.</p>
          <Link href="/generate">
            <Button>Generate Cards</Button>
          </Link>
        </div>
      ) : filteredDecks.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed rounded-xl bg-card">
          <Search className="mx-auto h-10 w-10 text-muted-foreground opacity-40 mb-3" />
          <p className="font-medium">No decks match "{search}"</p>
          <Button variant="ghost" className="mt-2" onClick={() => setSearch("")}>Clear search</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredDecks.map((deck, idx) => {
            const isSelected = selectedIds.has(deck.id);
            return (
              <div key={deck.id} className="relative">
                {selectMode && (
                  <div className="absolute top-3 left-3 z-10" onClick={e => toggleSelect(deck.id, e)}>
                    <Checkbox checked={isSelected} className="h-5 w-5 shadow-sm bg-background border-2" />
                  </div>
                )}
                <Link href={selectMode ? "#" : `/decks/${deck.id}`}>
                  <Card
                    className={`h-full cursor-pointer transition-all duration-200 border shadow-sm animate-in fade-in slide-in-from-bottom-4 ${
                      selectMode
                        ? isSelected
                          ? "border-primary ring-2 ring-primary/30 bg-primary/5"
                          : "border-border/50 opacity-70 hover:opacity-100"
                        : "hover-elevate border-border/50"
                    }`}
                    style={{ animationDelay: `${idx * 50}ms` }}
                    onClick={selectMode ? e => toggleSelect(deck.id, e as React.MouseEvent) : undefined}
                  >
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className={selectMode ? "pl-7" : ""}>
                          <CardTitle className="text-xl line-clamp-1">{deck.name}</CardTitle>
                          <CardDescription className="mt-1 flex items-center gap-1">
                            {format(new Date(deck.createdAt), "MMM d, yyyy")}
                          </CardDescription>
                        </div>
                        {!selectMode && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 -mt-2 -mr-2"
                            onClick={e => handleDelete(deck.id, e)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground line-clamp-2 min-h-[40px]">
                        {deck.description || "AI-generated flashcard deck."}
                      </p>
                    </CardContent>
                    <CardFooter className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-medium text-primary bg-primary/10 px-3 py-1.5 rounded-md">
                        <Layers className="h-4 w-4" />
                        {deck.cardCount} {deck.cardCount === 1 ? "card" : "cards"}
                      </div>
                      {deck.cardCount > 0 && (
                        <Badge variant="secondary" className="text-xs gap-1">
                          <FileText className="h-3 w-3" />
                          Ready to study
                        </Badge>
                      )}
                    </CardFooter>
                  </Card>
                </Link>
              </div>
            );
          })}
        </div>
      )}

      {/* Floating export bar */}
      {selectMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 duration-200">
          <div className="flex items-center gap-3 bg-card border border-border shadow-2xl rounded-2xl px-5 py-3">
            <span className="text-sm font-medium text-foreground">
              {selectedIds.size === 0 ? "Select decks to export" : `${selectedIds.size} deck${selectedIds.size > 1 ? "s" : ""} selected`}
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
