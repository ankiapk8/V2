import { useState, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useGenerateCards, useListDecks } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { FileText, Loader2, UploadCloud, X, CheckCircle2, AlertCircle, Sparkles, FolderOpen } from "lucide-react";
import { extractPdfText, isPdfFile, isTextFile } from "@/lib/pdf-extraction";
import type { Deck } from "@workspace/api-client-react/src/generated/api.schemas";

type DeckWithParent = Deck & { parentId?: number | null };

function buildParentOptions(allDecks: DeckWithParent[]): { id: number; label: string; depth: number }[] {
  const roots = allDecks.filter(d => !d.parentId);
  const byParent = new Map<number, DeckWithParent[]>();
  allDecks.filter(d => d.parentId).forEach(d => {
    const pid = d.parentId!;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid)!.push(d);
  });
  const result: { id: number; label: string; depth: number }[] = [];
  function walk(deck: DeckWithParent, label: string, depth: number) {
    result.push({ id: deck.id, label, depth });
    for (const child of (byParent.get(deck.id) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      walk(child, `${label} › ${child.name}`, depth + 1);
    }
  }
  for (const d of roots.sort((a, b) => a.name.localeCompare(b.name))) walk(d, d.name, 0);
  return result;
}

type FileStatus = "extracting" | "ready" | "error" | "generating" | "done";

type FileEntry = {
  id: string;
  name: string;
  status: FileStatus;
  text: string;
  progress: string;
  deckName: string;
  cardCount: number | "";
  generatedCount?: number;
};

export default function Home() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const generateCards = useGenerateCards();
  const { data: allDecks } = useListDecks();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [manualText, setManualText] = useState("");
  const [manualDeckName, setManualDeckName] = useState("");
  const [manualCardCount, setManualCardCount] = useState<number | "">("");
  const [parentId, setParentId] = useState<string>("none");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);

  const parentOptions = buildParentOptions((allDecks as DeckWithParent[]) ?? []);
  const selectedParentOpt = parentOptions.find(o => o.id.toString() === parentId);
  const resolvedParentId = parentId === "none" ? null : parseInt(parentId, 10);

  const isExtracting = files.some(f => f.status === "extracting");
  const readyFiles = files.filter(f => f.status === "ready" || f.status === "done");
  const hasManualContent = manualText.trim().length > 0 && manualDeckName.trim().length > 0;
  const canGenerate = !isExtracting && !isGeneratingAll && (readyFiles.length > 0 || hasManualContent);

  const updateFile = useCallback((id: string, patch: Partial<FileEntry>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }, []);

  const processFile = useCallback(async (file: File) => {
    const isTxt = isTextFile(file);
    const isPdf = isPdfFile(file);
    if (!isTxt && !isPdf) {
      toast({ title: "Unsupported file", description: `${file.name} is not a .txt or .pdf file.`, variant: "destructive" });
      return;
    }
    const id = `${file.name}-${Date.now()}-${Math.random()}`;
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const entry: FileEntry = { id, name: file.name, status: "extracting", text: "", progress: "Reading…", deckName: baseName, cardCount: "" };
    setFiles(prev => [...prev, entry]);
    try {
      if (isTxt) {
        const text = await file.text();
        updateFile(id, { status: "ready", text, progress: "" });
      } else {
        const buffer = await file.arrayBuffer();
        const extracted = await extractPdfText(buffer, (progress) => updateFile(id, { progress }));
        updateFile(id, { status: "ready", text: extracted, progress: "" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extraction failed";
      updateFile(id, { status: "error", progress: message });
    }
  }, [updateFile, toast]);

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const file of selected) await processFile(file);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    for (const file of Array.from(e.dataTransfer.files)) await processFile(file);
  };

  const removeFile = (id: string) => setFiles(prev => prev.filter(f => f.id !== id));

  const generateOne = (text: string, deckName: string, cardCount: number | ""): Promise<number> =>
    generateCards.mutateAsync(
      { data: { text, deckName, cardCount: cardCount ? Number(cardCount) : undefined, parentId: resolvedParentId } },
    ).then(data => data.generatedCount);

  const handleGenerateAll = async () => {
    setIsGeneratingAll(true);
    let successCount = 0;
    let failCount = 0;

    const targets: Array<{ id?: string; text: string; deckName: string; cardCount: number | "" }> = [];

    for (const f of files.filter(f => f.status === "ready")) {
      if (!f.deckName.trim()) {
        toast({ title: "Deck name required", description: `Please set a deck name for "${f.name}".`, variant: "destructive" });
        setIsGeneratingAll(false);
        return;
      }
      targets.push({ id: f.id, text: f.text, deckName: f.deckName, cardCount: f.cardCount });
    }

    if (hasManualContent) {
      targets.push({ text: manualText, deckName: manualDeckName, cardCount: manualCardCount });
    }

    if (targets.length === 0) {
      setIsGeneratingAll(false);
      return;
    }

    for (const target of targets) {
      if (target.id) updateFile(target.id, { status: "generating", progress: "Generating…" });
      try {
        const count = await generateOne(target.text, target.deckName, target.cardCount);
        if (target.id) updateFile(target.id, { status: "done", progress: "", generatedCount: count });
        successCount++;
      } catch {
        if (target.id) updateFile(target.id, { status: "error", progress: "Generation failed" });
        failCount++;
      }
    }

    setIsGeneratingAll(false);
    queryClient.invalidateQueries({ queryKey: ["/api/decks"] });

    if (successCount > 0 && failCount === 0) {
      toast({ title: "All decks generated!", description: `Successfully created ${successCount} deck${successCount !== 1 ? "s" : ""}.` });
      if (successCount === 1 && targets.length === 1) {
        // single — nothing extra to do, decks page will show it
      }
      setLocation("/decks");
    } else if (successCount > 0) {
      toast({ title: "Partially done", description: `${successCount} deck${successCount !== 1 ? "s" : ""} created, ${failCount} failed.`, variant: "destructive" });
    } else {
      toast({ title: "Generation failed", description: "All decks failed to generate. Please try again.", variant: "destructive" });
    }
  };

  const totalTargets = files.filter(f => f.status === "ready").length + (hasManualContent ? 1 : 0);

  return (
    <div className="flex-1 flex flex-col items-center justify-center max-w-2xl mx-auto w-full animate-in fade-in duration-500 pb-10">
      <div className="text-center mb-10 space-y-3">
        <h1 className="text-4xl md:text-5xl font-serif font-bold tracking-tight text-primary">
          Turn material into mastery.
        </h1>
        <p className="text-muted-foreground text-lg max-w-xl mx-auto">
          Upload multiple files — each becomes its own Anki deck, generated separately by AI.
        </p>
      </div>

      <div className="w-full space-y-4">
        {/* Parent deck selector */}
        <Card className="border-border/50 shadow-sm">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <FolderOpen className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <div>
                  <Label className="text-sm font-medium">Parent Deck</Label>
                  <p className="text-xs text-muted-foreground">Generated decks will be nested inside this deck</p>
                </div>
                <Select value={parentId} onValueChange={setParentId}>
                  <SelectTrigger className="h-8 text-sm w-full">
                    {parentId === "none" || !selectedParentOpt
                      ? <span className="text-muted-foreground">Standalone (no parent)</span>
                      : <span className="truncate">{selectedParentOpt.label}</span>
                    }
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="none">Standalone (no parent)</SelectItem>
                    {parentOptions.map(opt => (
                      <SelectItem key={opt.id} value={opt.id.toString()} className="py-1.5">
                        <span className="flex items-center gap-1 min-w-0">
                          {opt.depth > 0 && (
                            <span className="text-muted-foreground shrink-0 text-xs font-mono">
                              {"  ".repeat(opt.depth - 1)}{"└─"}
                            </span>
                          )}
                          <span className="truncate">{opt.label.split(" › ").pop()}</span>
                          {opt.depth === 0 && (
                            <span className="text-xs text-muted-foreground ml-1 shrink-0">(topic)</span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                    {parentOptions.length === 0 && (
                      <div className="px-2 py-3 text-sm text-muted-foreground text-center">
                        No decks yet — generated decks will be standalone
                      </div>
                    )}
                  </SelectContent>
                </Select>
                {selectedParentOpt && (
                  <p className="text-xs text-muted-foreground">
                    Decks will be placed inside <span className="font-medium text-foreground">{selectedParentOpt.label}</span>
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Drop zone */}
        <Card className="border-border/50 shadow-lg shadow-primary/5">
          <CardContent className="pt-5 pb-5">
            <div
              className={`relative border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileInput}
                accept=".txt,.pdf"
                multiple
                disabled={isGeneratingAll}
              />
              <UploadCloud className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm font-medium">Drop files here or click to browse</p>
              <p className="text-xs text-muted-foreground mt-1">PDF and TXT — select multiple files at once</p>
            </div>
          </CardContent>
        </Card>

        {/* Per-file cards */}
        {files.map(f => (
          <Card key={f.id} className="border-border/50 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                {f.status === "extracting" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />}
                {f.status === "ready" && <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />}
                {f.status === "generating" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />}
                {f.status === "done" && <Sparkles className="h-4 w-4 shrink-0 text-green-500" />}
                {f.status === "error" && <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />}
                <CardTitle className="text-sm font-medium truncate flex-1">{f.name}</CardTitle>
                {f.status === "extracting" && (
                  <span className="text-xs text-muted-foreground shrink-0">{f.progress}</span>
                )}
                {f.status === "ready" && (
                  <Badge variant="secondary" className="text-xs shrink-0">{(f.text.length / 1000).toFixed(1)}k chars</Badge>
                )}
                {f.status === "generating" && (
                  <span className="text-xs text-muted-foreground shrink-0">Generating…</span>
                )}
                {f.status === "done" && (
                  <Badge className="text-xs shrink-0 bg-green-500 hover:bg-green-600">{f.generatedCount} cards</Badge>
                )}
                {f.status === "error" && (
                  <span className="text-xs text-destructive shrink-0">{f.progress}</span>
                )}
                <button
                  onClick={() => removeFile(f.id)}
                  className="text-muted-foreground hover:text-foreground shrink-0 ml-1"
                  disabled={isGeneratingAll || f.status === "generating"}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </CardHeader>

            {(f.status === "ready" || f.status === "error") && (
              <CardContent className="pt-0">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor={`deckName-${f.id}`} className="text-xs">Deck Name</Label>
                    <Input
                      id={`deckName-${f.id}`}
                      placeholder="e.g. Biology 101"
                      value={f.deckName}
                      onChange={(e) => updateFile(f.id, { deckName: e.target.value })}
                      disabled={isGeneratingAll}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`cardCount-${f.id}`} className="text-xs">Target Card Count</Label>
                    <Input
                      id={`cardCount-${f.id}`}
                      type="number"
                      placeholder="e.g. 20"
                      min="1"
                      max="100"
                      value={f.cardCount}
                      onChange={(e) => updateFile(f.id, { cardCount: e.target.value ? Number(e.target.value) : "" })}
                      disabled={isGeneratingAll}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </CardContent>
            )}
          </Card>
        ))}

        {/* Manual text section */}
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Manual Text</CardTitle>
            <CardDescription className="text-xs">Optionally paste extra text as its own deck.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <Textarea
              placeholder="Paste study material here…"
              className="min-h-[120px] resize-none text-sm"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              disabled={isGeneratingAll}
            />
            {manualText.trim().length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="manualDeckName" className="text-xs">Deck Name</Label>
                  <Input
                    id="manualDeckName"
                    placeholder="e.g. Lecture Notes"
                    value={manualDeckName}
                    onChange={(e) => setManualDeckName(e.target.value)}
                    disabled={isGeneratingAll}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="manualCardCount" className="text-xs">Target Card Count</Label>
                  <Input
                    id="manualCardCount"
                    type="number"
                    placeholder="e.g. 15"
                    min="1"
                    max="100"
                    value={manualCardCount}
                    onChange={(e) => setManualCardCount(e.target.value ? Number(e.target.value) : "")}
                    disabled={isGeneratingAll}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Generate button */}
        <Button
          className="w-full py-6 text-lg font-medium"
          size="lg"
          onClick={handleGenerateAll}
          disabled={!canGenerate}
        >
          {isGeneratingAll ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Generating Decks…
            </>
          ) : isExtracting ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Processing Files…
            </>
          ) : (
            <>
              <FileText className="mr-2 h-5 w-5" />
              {totalTargets > 1
                ? `Generate ${totalTargets} Decks Separately`
                : totalTargets === 1
                ? "Generate Flashcards"
                : "Generate Flashcards"}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
