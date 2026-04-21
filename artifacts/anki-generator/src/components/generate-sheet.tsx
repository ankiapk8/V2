import { useState, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGenerateCards, useCreateDeck, useListDecks, getListDecksQueryKey } from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Progress } from "@/components/ui/progress";
import { UploadCloud, X, CheckCircle2, AlertCircle, Loader2, FileText, Sparkles, FolderOpen, ImageIcon } from "lucide-react";
import { extractPdf, isPdfFile, isTextFile } from "@/lib/pdf-extraction";
import type { Deck } from "@workspace/api-client-react/src/generated/api.schemas";

function parseProgressPercent(message: string): number | null {
  const match = message.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  const current = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  if (!total) return null;
  return Math.round((current / total) * 100);
}

function getProgressPhase(message: string): "text" | "images" | "ocr" | "server" | "other" {
  if (message.startsWith("Extracting page")) return "text";
  if (message.startsWith("Capturing page")) return "images";
  if (message.startsWith("OCR page")) return "ocr";
  if (message.includes("server") || message.includes("Server")) return "server";
  return "other";
}

type FileStatus = "extracting" | "ready" | "error" | "generating" | "done";

type FileEntry = {
  id: string;
  name: string;
  status: FileStatus;
  text: string;
  pageImages: string[];
  progress: string;
  deckName: string;
  cardCount: number | "";
  generatedCount?: number;
};

type DeckWithParent = Deck & { parentId?: number | null };

interface GenerateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
  defaultParentId?: number | null;
}

function buildParentOptions(allDecks: DeckWithParent[]): { id: number; label: string; depth: number }[] {
  const rootDecks = allDecks.filter(d => !d.parentId);
  const byParent = new Map<number, DeckWithParent[]>();
  allDecks.filter(d => d.parentId).forEach(d => {
    const pid = d.parentId!;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid)!.push(d);
  });

  const result: { id: number; label: string; depth: number }[] = [];

  function walk(deck: DeckWithParent, label: string, depth: number) {
    result.push({ id: deck.id, label, depth });
    const children = byParent.get(deck.id) ?? [];
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      walk(child, `${label} › ${child.name}`, depth + 1);
    }
  }

  for (const d of rootDecks.sort((a, b) => a.name.localeCompare(b.name))) {
    walk(d, d.name, 0);
  }

  return result;
}

export function GenerateSheet({ open, onOpenChange, onDone, defaultParentId }: GenerateSheetProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const generateCards = useGenerateCards();
  const createDeck = useCreateDeck();
  const { data: allDecks } = useListDecks();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualDeckName, setManualDeckName] = useState("");
  const [manualCardCount, setManualCardCount] = useState<number | "">("");
  const [parentId, setParentId] = useState<string>(defaultParentId?.toString() ?? "none");

  const [emptyName, setEmptyName] = useState("");
  const [emptyDesc, setEmptyDesc] = useState("");
  const [emptyParentId, setEmptyParentId] = useState<string>(defaultParentId?.toString() ?? "none");
  const [isCreating, setIsCreating] = useState(false);

  const isExtracting = files.some(f => f.status === "extracting");
  const readyFiles = files.filter(f => f.status === "ready");
  const hasManual = manualText.trim().length > 0 && manualDeckName.trim().length > 0;
  const canGenerate = !isExtracting && !isGeneratingAll && (readyFiles.length > 0 || hasManual);

  const parentOptions = buildParentOptions((allDecks as DeckWithParent[]) ?? []);

  const updateFile = useCallback((id: string, patch: Partial<FileEntry>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }, []);

  const processFile = useCallback(async (file: File) => {
    const isTxt = isTextFile(file);
    const isPdf = isPdfFile(file);
    if (!isTxt && !isPdf) {
      toast({ title: "Unsupported file", description: `${file.name} is not .txt or .pdf`, variant: "destructive" });
      return;
    }
    const id = `${file.name}-${Date.now()}-${Math.random()}`;
    const baseName = file.name.replace(/\.[^.]+$/, "");
    setFiles(prev => [...prev, { id, name: file.name, status: "extracting", text: "", pageImages: [], progress: "Reading…", deckName: baseName, cardCount: "" }]);
    try {
      if (isTxt) {
        const text = await file.text();
        updateFile(id, { status: "ready", text, pageImages: [], progress: "" });
      } else {
        const buffer = await file.arrayBuffer();
        const { text, pageImages } = await extractPdf(buffer, (progress) => updateFile(id, { progress }));
        updateFile(id, { status: "ready", text, pageImages, progress: "" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extraction failed";
      updateFile(id, { status: "error", progress: message });
    }
  }, [updateFile, toast]);

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const f of selected) await processFile(f);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    for (const f of Array.from(e.dataTransfer.files)) await processFile(f);
  };

  const resolvedParentId = parentId === "none" ? null : parseInt(parentId, 10);

  const pauseBetweenFiles = () => new Promise(resolve => setTimeout(resolve, 1500));

  const getGenerationErrorMessage = (error: unknown) => {
    if (error && typeof error === "object") {
      const data = (error as { data?: unknown }).data;
      if (data && typeof data === "object") {
        const apiError = (data as { error?: unknown }).error;
        if (typeof apiError === "string" && apiError.trim()) return apiError;
      }
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message.replace(/^HTTP \d+\s+[^:]+:\s*/, "");
      }
    }
    return "Generation failed";
  };

  const generateOne = (text: string, deckName: string, cardCount: number | "", pid: number | null, pageImages?: string[]): Promise<number> =>
    generateCards.mutateAsync(
      { data: { text, deckName, cardCount: cardCount ? Number(cardCount) : undefined, parentId: pid, pageImages: pageImages && pageImages.length > 0 ? pageImages : undefined } },
    ).then(d => d.generatedCount);

  const handleGenerateAll = async () => {
    setIsGeneratingAll(true);
    let ok = 0, fail = 0;
    const targets = [
      ...readyFiles.map(f => ({ id: f.id, text: f.text, deckName: f.deckName, cardCount: f.cardCount, pageImages: f.pageImages })),
      ...(hasManual ? [{ id: undefined, text: manualText, deckName: manualDeckName, cardCount: manualCardCount, pageImages: [] as string[] }] : []),
    ];

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t.deckName.trim()) {
        toast({ title: "Deck name required", variant: "destructive" });
        setIsGeneratingAll(false);
        return;
      }
      if (t.id) updateFile(t.id, { status: "generating", progress: "Generating…" });
      try {
        const count = await generateOne(t.text, t.deckName, t.cardCount, resolvedParentId, t.pageImages);
        if (t.id) updateFile(t.id, { status: "done", progress: "", generatedCount: count });
        ok++;
      } catch (error) {
        const message = getGenerationErrorMessage(error);
        if (t.id) updateFile(t.id, { status: "error", progress: message });
        toast({ title: `Could not generate ${t.deckName}`, description: message, variant: "destructive" });
        fail++;
      }
      if (i < targets.length - 1) await pauseBetweenFiles();
    }

    setIsGeneratingAll(false);
    queryClient.invalidateQueries({ queryKey: getListDecksQueryKey() });

    if (ok > 0) {
      toast({
        title: ok === 1 ? "Deck generated!" : `${ok} decks generated!`,
        description: fail > 0 ? `${fail} file${fail === 1 ? "" : "s"} still need attention.` : undefined,
      });
      if (fail === 0) { resetState(); onDone?.(); onOpenChange(false); }
    } else {
      toast({ title: "Generation failed", variant: "destructive" });
    }
  };

  const resetState = () => {
    setFiles([]);
    setManualText(""); setManualDeckName(""); setManualCardCount("");
    setParentId(defaultParentId?.toString() ?? "none");
  };

  const handleCreateEmpty = async () => {
    if (!emptyName.trim()) return;
    setIsCreating(true);
    const pid = emptyParentId === "none" ? null : parseInt(emptyParentId, 10);
    try {
      await createDeck.mutateAsync({ data: { name: emptyName, description: emptyDesc, parentId: pid } });
      queryClient.invalidateQueries({ queryKey: getListDecksQueryKey() });
      toast({ title: "Deck created." });
      setEmptyName(""); setEmptyDesc(""); setEmptyParentId("none");
      onDone?.(); onOpenChange(false);
    } catch {
      toast({ title: "Failed to create deck", variant: "destructive" });
    } finally {
      setIsCreating(false);
    }
  };

  const totalTargets = readyFiles.length + (hasManual ? 1 : 0);

  const ParentSelector = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
    const selected = parentOptions.find(o => o.id.toString() === value);
    return (
      <div className="space-y-1.5">
        <Label className="text-sm flex items-center gap-1.5">
          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
          Parent Deck <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="h-8 text-sm">
            {value === "none" || !selected
              ? <span className="text-muted-foreground">No parent — standalone deck</span>
              : <span className="truncate">{selected.label}</span>
            }
          </SelectTrigger>
          <SelectContent className="max-h-64">
            <SelectItem value="none">No parent — standalone deck</SelectItem>
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
          </SelectContent>
        </Select>
        {selected && selected.depth > 0 && (
          <p className="text-xs text-muted-foreground">
            Cards will be added inside <span className="font-medium">{selected.label}</span>
          </p>
        )}
      </div>
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="font-serif text-2xl">New Deck</SheetTitle>
          <SheetDescription>Generate AI flashcards from files or create an empty deck.</SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="generate" className="w-full">
          <TabsList className="w-full mb-5">
            <TabsTrigger value="generate" className="flex-1 gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> Generate with AI
            </TabsTrigger>
            <TabsTrigger value="empty" className="flex-1 gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Empty Deck
            </TabsTrigger>
          </TabsList>

          {/* ── Generate tab ── */}
          <TabsContent value="generate" className="space-y-4 mt-0">
            {parentOptions.length > 0 && (
              <ParentSelector value={parentId} onChange={setParentId} />
            )}

            {/* Drop zone */}
            <div
              className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors ${isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInput} accept=".txt,.pdf" multiple disabled={isGeneratingAll} />
              <UploadCloud className="h-7 w-7 mx-auto mb-1.5 text-muted-foreground" />
              <p className="text-sm font-medium">Drop files or click to browse</p>
              <p className="text-xs text-muted-foreground mt-0.5">PDF and TXT — multiple files at once</p>
            </div>

            {/* File entries */}
            {files.map(f => {
              const extractPercent = f.status === "extracting" ? parseProgressPercent(f.progress) : null;
              const extractPhase = f.status === "extracting" ? getProgressPhase(f.progress) : null;
              const phaseLabel =
                extractPhase === "text" ? "Reading text" :
                extractPhase === "images" ? "Capturing screenshots" :
                extractPhase === "ocr" ? "Running OCR" :
                extractPhase === "server" ? "Server extraction" :
                f.progress || "Processing…";

              return (
              <Card key={f.id} className="border-border/50">
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    {f.status === "extracting" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />}
                    {f.status === "ready"      && <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />}
                    {f.status === "generating" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />}
                    {f.status === "done"       && <Sparkles className="h-4 w-4 shrink-0 text-green-500" />}
                    {f.status === "error"      && <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />}
                    <span className="text-sm font-medium flex-1 truncate">{f.name}</span>
                    {f.status === "ready"      && (
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge variant="secondary" className="text-xs">{(f.text.length / 1000).toFixed(1)}k chars</Badge>
                        {f.pageImages.length > 0 && (
                          <Badge variant="outline" className="text-xs gap-1">
                            <ImageIcon className="h-2.5 w-2.5" />{f.pageImages.length} pg
                          </Badge>
                        )}
                      </div>
                    )}
                    {f.status === "generating" && <span className="text-xs text-muted-foreground shrink-0">Generating…</span>}
                    {f.status === "done"       && <Badge className="text-xs shrink-0 bg-green-500 hover:bg-green-600">{f.generatedCount} cards</Badge>}
                    {f.status === "error"      && <span className="text-xs text-destructive shrink-0">{f.progress}</span>}
                    <button onClick={() => setFiles(p => p.filter(x => x.id !== f.id))} className="text-muted-foreground hover:text-foreground ml-1 shrink-0" disabled={isGeneratingAll || f.status === "generating"}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {f.status === "extracting" && (
                    <div className="space-y-1 pt-0.5">
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] text-muted-foreground">{phaseLabel}</span>
                        {extractPercent !== null && (
                          <span className="text-[11px] text-muted-foreground font-medium">{extractPercent}%</span>
                        )}
                      </div>
                      {extractPercent !== null ? (
                        <Progress value={extractPercent} className="h-1.5" />
                      ) : (
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full w-1/3 rounded-full bg-primary/50 animate-[shimmer_1.2s_ease-in-out_infinite]"
                            style={{ animation: "shimmer 1.2s ease-in-out infinite", backgroundImage: "linear-gradient(90deg, transparent 0%, hsl(var(--primary)/0.5) 50%, transparent 100%)", backgroundSize: "200% 100%" }}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {f.status === "generating" && (
                    <div className="space-y-1 pt-0.5">
                      <span className="text-[11px] text-muted-foreground">AI is generating flashcards…</span>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-primary/60"
                          style={{ width: "60%", animation: "pulse 1.5s ease-in-out infinite" }}
                        />
                      </div>
                    </div>
                  )}

                  {(f.status === "ready" || f.status === "error") && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Deck Name</Label>
                        <Input value={f.deckName} onChange={e => updateFile(f.id, { deckName: e.target.value })} className="h-7 text-xs" placeholder="e.g. Chapter 1" disabled={isGeneratingAll} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Target Cards</Label>
                        <Input type="number" value={f.cardCount} onChange={e => updateFile(f.id, { cardCount: e.target.value ? Number(e.target.value) : "" })} className="h-7 text-xs" placeholder="e.g. 20" min="1" max="200" disabled={isGeneratingAll} />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
              );
            })}

            {/* Manual text */}
            <div className="space-y-1.5">
              <Label className="text-sm text-muted-foreground">Additional text {files.length > 0 && "(optional)"}</Label>
              <Textarea placeholder="Paste study material here…" className="min-h-[90px] resize-none text-sm" value={manualText} onChange={e => setManualText(e.target.value)} disabled={isGeneratingAll} />
            </div>
            {manualText.trim().length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Deck Name</Label>
                  <Input value={manualDeckName} onChange={e => setManualDeckName(e.target.value)} className="h-7 text-xs" placeholder="e.g. Notes" disabled={isGeneratingAll} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Target Cards</Label>
                  <Input type="number" value={manualCardCount} onChange={e => setManualCardCount(e.target.value ? Number(e.target.value) : "")} className="h-7 text-xs" placeholder="e.g. 15" min="1" max="200" disabled={isGeneratingAll} />
                </div>
              </div>
            )}

            <Button className="w-full" onClick={handleGenerateAll} disabled={!canGenerate}>
              {isGeneratingAll
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generating…</>
                : isExtracting
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processing files…</>
                : <><Sparkles className="mr-2 h-4 w-4" />{totalTargets > 1 ? `Generate ${totalTargets} Decks` : "Generate Deck"}</>
              }
            </Button>
          </TabsContent>

          {/* ── Empty deck tab ── */}
          <TabsContent value="empty" className="space-y-4 mt-0">
            {parentOptions.length > 0 && (
              <ParentSelector value={emptyParentId} onChange={setEmptyParentId} />
            )}
            <div className="space-y-2">
              <Label htmlFor="emptyName">Deck Name</Label>
              <Input id="emptyName" value={emptyName} onChange={e => setEmptyName(e.target.value)} placeholder="e.g. Spanish Vocabulary" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="emptyDesc">Description <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea id="emptyDesc" value={emptyDesc} onChange={e => setEmptyDesc(e.target.value)} placeholder="What is this deck for?" className="resize-none" rows={3} />
            </div>
            <Button className="w-full" onClick={handleCreateEmpty} disabled={!emptyName.trim() || isCreating}>
              {isCreating
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating…</>
                : <><FileText className="mr-2 h-4 w-4" />Create Empty Deck</>
              }
            </Button>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
