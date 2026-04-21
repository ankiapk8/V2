import { useState, useRef, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateDeck, useListDecks, getListDecksQueryKey } from "@workspace/api-client-react";
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
import { UploadCloud, X, CheckCircle2, AlertCircle, Loader2, FileText, Sparkles, FolderOpen, ImageIcon, ArrowLeft, Type, Layers } from "lucide-react";
import { extractPdf, isPdfFile, isTextFile } from "@/lib/pdf-extraction";
import { apiUrl } from "@/lib/utils";
import type { Deck } from "@workspace/api-client-react/src/generated/api.schemas";

const DEFAULT_TARGET_CARDS = 20;
const CHARS_PER_CARD = 220;
const MAX_CAPACITY = 200;

function estimateCardCapacity(text: string, pageImages: number): number {
  const chars = text.trim().length;
  if (chars === 0 && pageImages === 0) return 0;
  const textCards = Math.round(chars / CHARS_PER_CARD);
  const visualCards = Math.min(pageImages, 50);
  return Math.max(3, Math.min(MAX_CAPACITY, textCards + visualCards));
}

function estimatedCards(text: string, pageImages: number, target: number | ""): number {
  const capacity = estimateCardCapacity(text, pageImages);
  if (capacity === 0) return 0;
  const goal = typeof target === "number" && target > 0 ? target : DEFAULT_TARGET_CARDS;
  return Math.min(goal, capacity);
}

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

type DeckType = "text" | "visual" | "both";

type FileEntry = {
  id: string;
  name: string;
  status: FileStatus;
  text: string;
  pageImages: string[];
  progress: string;
  deckName: string;
  cardCount: number | "";
  visualCardCount: number | "";
  deckType: DeckType;
  generatedCount?: number;
  generatingPercent?: number;
  generatingMessage?: string;
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
  const createDeck = useCreateDeck();
  const { data: allDecks } = useListDecks();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualDeckName, setManualDeckName] = useState("");
  const [manualCardCount, setManualCardCount] = useState<number | "">("");
  // Manual text never has page images — deck type is forced to "text"
  const [parentId, setParentId] = useState<string>(defaultParentId?.toString() ?? "none");

  const [emptyName, setEmptyName] = useState("");
  const [emptyDesc, setEmptyDesc] = useState("");
  const [emptyParentId, setEmptyParentId] = useState<string>(defaultParentId?.toString() ?? "none");
  const [isCreating, setIsCreating] = useState(false);

  const isExtracting = files.some(f => f.status === "extracting");
  const readyFiles = files.filter(f => f.status === "ready");
  const hasManual = manualText.trim().length > 0 && manualDeckName.trim().length > 0;
  const canGenerate = !isExtracting && !isGeneratingAll && (readyFiles.length > 0 || hasManual);

  const parentOptions = useMemo(
    () => buildParentOptions((allDecks as DeckWithParent[]) ?? []),
    [allDecks]
  );

  const updateFile = useCallback((id: string, patch: Partial<FileEntry>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }, []);

  const progressThrottleRef = useRef<Map<string, number>>(new Map());

  const throttledProgressUpdate = useCallback((id: string, progress: string) => {
    const now = Date.now();
    const last = progressThrottleRef.current.get(id) ?? 0;
    if (now - last >= 150) {
      progressThrottleRef.current.set(id, now);
      setFiles(prev => prev.map(f => f.id === id ? { ...f, progress } : f));
    }
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
    setFiles(prev => [...prev, { id, name: file.name, status: "extracting", text: "", pageImages: [], progress: "Reading…", deckName: baseName, cardCount: "", visualCardCount: "", deckType: "both" }]);
    try {
      if (isTxt) {
        const text = await file.text();
        updateFile(id, { status: "ready", text, pageImages: [], progress: "" });
      } else {
        const buffer = await file.arrayBuffer();
        const { text, pageImages } = await extractPdf(buffer, (progress) => throttledProgressUpdate(id, progress));
        updateFile(id, { status: "ready", text, pageImages, progress: "", deckType: pageImages.length > 0 ? "both" : "text" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extraction failed";
      updateFile(id, { status: "error", progress: message });
    }
  }, [updateFile, throttledProgressUpdate, toast]);

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

  const generateOne = (
    text: string,
    deckName: string,
    cardCount: number | "",
    pid: number | null,
    pageImages?: string[],
    fileId?: string,
    deckType: DeckType = "text",
    visualCardCount: number | "" = "",
  ): Promise<number> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({
        text, deckName,
        cardCount: cardCount ? Number(cardCount) : undefined,
        visualCardCount: visualCardCount ? Number(visualCardCount) : undefined,
        deckType,
        parentId: pid,
        pageImages: pageImages && pageImages.length > 0 ? pageImages : undefined,
      });

      fetch(apiUrl("api/generate/stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }).then(async resp => {
        if (!resp.ok || !resp.body) {
          const err = await resp.json().catch(() => ({}));
          reject(new Error((err as { error?: string }).error ?? "Generation failed"));
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            try {
              const event = JSON.parse(line.slice(5).trim()) as {
                type: string; percent?: number; message?: string; generatedCount?: number;
              };
              if (event.type === "progress" && fileId) {
                setFiles(prev => prev.map(f =>
                  f.id === fileId
                    ? { ...f, generatingPercent: event.percent, generatingMessage: event.message }
                    : f
                ));
              } else if (event.type === "done") {
                resolve(event.generatedCount ?? 0);
                return;
              } else if (event.type === "error") {
                reject(new Error(event.message ?? "Generation failed"));
                return;
              }
            } catch { continue; }
          }
        }
        reject(new Error("Stream ended unexpectedly"));
      }).catch(reject);
    });

  const handleGenerateAll = async () => {
    setIsGeneratingAll(true);
    let ok = 0, fail = 0;
    const targets = [
      ...readyFiles.map(f => ({ id: f.id, text: f.text, deckName: f.deckName, cardCount: f.cardCount, pageImages: f.pageImages, deckType: f.deckType, visualCardCount: f.visualCardCount })),
      ...(hasManual ? [{ id: undefined, text: manualText, deckName: manualDeckName, cardCount: manualCardCount, pageImages: [] as string[], deckType: "text" as DeckType, visualCardCount: "" as number | "" }] : []),
    ];

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t.deckName.trim()) {
        toast({ title: "Deck name required", variant: "destructive" });
        setIsGeneratingAll(false);
        return;
      }
      if (t.id) updateFile(t.id, { status: "generating", progress: "Generating…", generatingPercent: 0, generatingMessage: "Starting…" });
      try {
        const count = await generateOne(t.text, t.deckName, t.cardCount, resolvedParentId, t.pageImages, t.id, t.deckType, t.visualCardCount);
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
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto p-0 bg-gradient-to-b from-background to-muted/20">
        <div className="px-6 pt-5 pb-4 border-b bg-background/60 backdrop-blur-sm sticky top-0 z-10">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={isGeneratingAll}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors mb-3 -ml-1 px-1 py-0.5 rounded hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <SheetHeader>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center shrink-0">
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0 text-left">
                <SheetTitle className="font-serif text-2xl leading-tight">New Deck</SheetTitle>
                <SheetDescription className="text-xs mt-0.5">
                  Generate AI flashcards or start from scratch.
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
        </div>

        <div className="px-6 py-5">
        <Tabs defaultValue="generate" className="w-full">
          <TabsList className="w-full mb-6 h-10 p-1 bg-muted/60">
            <TabsTrigger value="generate" className="flex-1 gap-1.5 h-8 data-[state=active]:shadow-sm">
              <Sparkles className="h-3.5 w-3.5" /> Generate with AI
            </TabsTrigger>
            <TabsTrigger value="empty" className="flex-1 gap-1.5 h-8 data-[state=active]:shadow-sm">
              <FileText className="h-3.5 w-3.5" /> Empty Deck
            </TabsTrigger>
          </TabsList>

          {/* ── Generate tab ── */}
          <TabsContent value="generate" className="space-y-5 mt-0">
            <ParentSelector value={parentId} onChange={setParentId} />

            {/* Drop zone */}
            <div
              className={`relative border-2 border-dashed rounded-xl p-7 text-center cursor-pointer transition-all duration-200 group ${
                isDragging
                  ? "border-primary bg-primary/5 scale-[1.01] shadow-sm"
                  : "border-border/70 hover:border-primary/60 hover:bg-primary/[0.02]"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInput} accept=".txt,.pdf" multiple disabled={isGeneratingAll} />
              <div className={`h-12 w-12 mx-auto mb-3 rounded-full flex items-center justify-center transition-all ${
                isDragging
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary"
              }`}>
                <UploadCloud className="h-6 w-6" />
              </div>
              <p className="text-sm font-semibold text-foreground">
                {isDragging ? "Release to upload" : "Drop files or click to browse"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                PDF and TXT · Upload multiple at once
              </p>
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

              const accentClass =
                f.status === "error" ? "border-l-destructive/70"
                : f.status === "done" ? "border-l-green-500/70"
                : f.status === "ready" ? "border-l-primary/50"
                : "border-l-muted-foreground/30";

              return (
              <Card key={f.id} className={`border-border/60 border-l-[3px] ${accentClass} shadow-sm bg-card/80 backdrop-blur-sm transition-shadow hover:shadow-md`}>
                <CardContent className="p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2.5">
                    <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${
                      f.status === "error" ? "bg-destructive/10" :
                      f.status === "done" ? "bg-green-500/10" :
                      f.status === "ready" ? "bg-primary/10" :
                      "bg-muted"
                    }`}>
                      {f.status === "extracting" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                      {f.status === "ready"      && <FileText className="h-3.5 w-3.5 text-primary" />}
                      {f.status === "generating" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                      {f.status === "done"       && <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />}
                      {f.status === "error"      && <AlertCircle className="h-3.5 w-3.5 text-destructive" />}
                    </div>
                    <span className="text-sm font-medium flex-1 truncate">{f.name}</span>
                    {f.status === "ready"      && (
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge variant="secondary" className="text-[10px] font-normal px-1.5 py-0 h-5">{(f.text.length / 1000).toFixed(1)}k chars</Badge>
                        {f.pageImages.length > 0 && (
                          <Badge variant="outline" className="text-[10px] gap-1 px-1.5 py-0 h-5 font-normal">
                            <ImageIcon className="h-2.5 w-2.5" />{f.pageImages.length} pg
                          </Badge>
                        )}
                      </div>
                    )}
                    {f.status === "generating" && <span className="text-xs text-primary font-medium shrink-0">Generating…</span>}
                    {f.status === "done"       && <Badge className="text-[10px] shrink-0 bg-green-600 hover:bg-green-600 px-1.5 py-0 h-5">{f.generatedCount} cards</Badge>}
                    {f.status === "error"      && <span className="text-xs text-destructive shrink-0 max-w-[140px] truncate">{f.progress}</span>}
                    <button onClick={() => setFiles(p => p.filter(x => x.id !== f.id))} className="text-muted-foreground hover:text-foreground ml-0.5 shrink-0 p-0.5 rounded hover:bg-muted transition-colors" disabled={isGeneratingAll || f.status === "generating"}>
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
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] text-muted-foreground truncate pr-2">
                          {f.generatingMessage ?? "Generating…"}
                        </span>
                        <span className="text-[11px] font-medium text-primary shrink-0">
                          {f.generatingPercent ?? 0}%
                        </span>
                      </div>
                      <Progress value={f.generatingPercent ?? 0} className="h-1.5" />
                    </div>
                  )}

                  {(f.status === "ready" || f.status === "error") && (
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Deck Name</Label>
                        <Input value={f.deckName} onChange={e => updateFile(f.id, { deckName: e.target.value })} className="h-7 text-xs" placeholder="e.g. Chapter 1" disabled={isGeneratingAll} />
                      </div>

                      {f.pageImages.length > 0 && (
                        <div className="space-y-1">
                          <Label className="text-xs">Deck Type</Label>
                          <div className="grid grid-cols-3 gap-1 p-0.5 rounded-md bg-muted/60">
                            {([
                              { value: "text" as DeckType, label: "Text only", icon: Type },
                              { value: "visual" as DeckType, label: "Visual", icon: ImageIcon },
                              { value: "both" as DeckType, label: "Both", icon: Layers },
                            ]).map(opt => {
                              const Icon = opt.icon;
                              const active = f.deckType === opt.value;
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  disabled={isGeneratingAll}
                                  onClick={() => updateFile(f.id, { deckType: opt.value })}
                                  className={`flex items-center justify-center gap-1 h-7 rounded text-[11px] font-medium transition-colors disabled:opacity-50 ${
                                    active
                                      ? "bg-background shadow-sm text-foreground"
                                      : "text-muted-foreground hover:text-foreground"
                                  }`}
                                >
                                  <Icon className="h-3 w-3" />
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>
                          {f.deckType === "both" && (
                            <p className="text-[10px] text-muted-foreground">
                              Creates two decks: <span className="font-medium">"{f.deckName} – Text"</span> and <span className="font-medium">"{f.deckName} – Visual"</span>.
                            </p>
                          )}
                        </div>
                      )}

                      <div className={`grid gap-2 ${f.pageImages.length > 0 && (f.deckType === "both" || f.deckType === "visual") && f.deckType !== "visual" ? "grid-cols-2" : "grid-cols-1"}`}>
                        {(f.deckType === "text" || f.deckType === "both") && (
                          <div className="space-y-1">
                            <Label className="text-xs flex items-center justify-between gap-1">
                              <span className="flex items-center gap-1"><Type className="h-3 w-3" />Text Cards</span>
                              <span className="text-[10px] font-normal text-muted-foreground">
                                ~{estimatedCards(f.text, 0, f.cardCount)} likely
                              </span>
                            </Label>
                            <Input type="number" value={f.cardCount} onChange={e => updateFile(f.id, { cardCount: e.target.value ? Number(e.target.value) : "" })} className="h-7 text-xs" placeholder={`e.g. ${DEFAULT_TARGET_CARDS}`} min="1" max="200" disabled={isGeneratingAll} />
                          </div>
                        )}
                        {(f.deckType === "visual" || f.deckType === "both") && f.pageImages.length > 0 && (
                          <div className="space-y-1">
                            <Label className="text-xs flex items-center justify-between gap-1">
                              <span className="flex items-center gap-1"><ImageIcon className="h-3 w-3" />Visual Cards</span>
                              <span className="text-[10px] font-normal text-muted-foreground">
                                up to {Math.min(f.pageImages.length * 3, 200)}
                              </span>
                            </Label>
                            <Input type="number" value={f.visualCardCount} onChange={e => updateFile(f.id, { visualCardCount: e.target.value ? Number(e.target.value) : "" })} className="h-7 text-xs" placeholder={`e.g. ${Math.min(f.pageImages.length * 2, 30)}`} min="1" max="200" disabled={isGeneratingAll} />
                          </div>
                        )}
                      </div>

                      {(() => {
                        if (f.deckType === "visual") return null;
                        const capacity = estimateCardCapacity(f.text, 0);
                        const target = typeof f.cardCount === "number" ? f.cardCount : DEFAULT_TARGET_CARDS;
                        if (target > capacity && capacity > 0) {
                          return (
                            <p className="text-[10px] text-amber-600 dark:text-amber-500">
                              Text content likely only supports ~{capacity} cards — target will be capped.
                            </p>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  )}
                </CardContent>
              </Card>
              );
            })}

            {/* Manual text */}
            <div className="relative pt-1">
              <div className="absolute inset-x-0 top-0 flex items-center" aria-hidden>
                <div className="flex-1 h-px bg-border/70" />
                <span className="px-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                  {files.length > 0 ? "Or add text" : "Or paste text"}
                </span>
                <div className="flex-1 h-px bg-border/70" />
              </div>
              <div className="space-y-1.5 pt-5">
                <Textarea placeholder="Paste study material, notes, or an article here…" className="min-h-[100px] resize-none text-sm bg-background/80" value={manualText} onChange={e => setManualText(e.target.value)} disabled={isGeneratingAll} />
              </div>
            </div>
            {manualText.trim().length > 0 && (
              <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Deck Name</Label>
                    <Input value={manualDeckName} onChange={e => setManualDeckName(e.target.value)} className="h-7 text-xs" placeholder="e.g. Notes" disabled={isGeneratingAll} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs flex items-center justify-between gap-1">
                      <span>Target Cards</span>
                      <span className="text-[10px] font-normal text-muted-foreground">
                        ~{estimatedCards(manualText, 0, manualCardCount)} likely
                      </span>
                    </Label>
                    <Input type="number" value={manualCardCount} onChange={e => setManualCardCount(e.target.value ? Number(e.target.value) : "")} className="h-7 text-xs" placeholder={`e.g. ${DEFAULT_TARGET_CARDS}`} min="1" max="200" disabled={isGeneratingAll} />
                  </div>
                </div>
                {(() => {
                  const capacity = estimateCardCapacity(manualText, 0);
                  const target = typeof manualCardCount === "number" ? manualCardCount : DEFAULT_TARGET_CARDS;
                  if (target > capacity && capacity > 0) {
                    return (
                      <p className="text-[10px] text-amber-600 dark:text-amber-500">
                        Content likely only supports ~{capacity} cards — target will be capped.
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
            )}

            <div className="sticky bottom-0 -mx-6 px-6 pt-3 pb-1 bg-gradient-to-t from-background via-background to-background/80 backdrop-blur-sm">
              {totalTargets > 0 && !isGeneratingAll && !isExtracting && (
                <div className="flex items-center justify-between mb-2 px-0.5 text-xs">
                  <span className="text-muted-foreground">
                    Ready to generate
                  </span>
                  <span className="font-medium text-foreground">
                    {totalTargets} {totalTargets === 1 ? "deck" : "decks"}
                  </span>
                </div>
              )}
              <Button
                className="w-full h-11 shadow-sm font-medium"
                onClick={handleGenerateAll}
                disabled={!canGenerate}
                size="lg"
              >
                {isGeneratingAll
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generating…</>
                  : isExtracting
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processing files…</>
                  : <><Sparkles className="mr-2 h-4 w-4" />{totalTargets > 1 ? `Generate ${totalTargets} Decks` : "Generate Deck"}</>
                }
              </Button>
            </div>
          </TabsContent>

          {/* ── Empty deck tab ── */}
          <TabsContent value="empty" className="space-y-4 mt-0">
            <ParentSelector value={emptyParentId} onChange={setEmptyParentId} />
            <div className="space-y-2">
              <Label htmlFor="emptyName">Deck Name</Label>
              <Input id="emptyName" value={emptyName} onChange={e => setEmptyName(e.target.value)} placeholder="e.g. Spanish Vocabulary" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="emptyDesc">Description <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea id="emptyDesc" value={emptyDesc} onChange={e => setEmptyDesc(e.target.value)} placeholder="What is this deck for?" className="resize-none" rows={3} />
            </div>
            <Button className="w-full h-11 shadow-sm font-medium" size="lg" onClick={handleCreateEmpty} disabled={!emptyName.trim() || isCreating}>
              {isCreating
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating…</>
                : <><FileText className="mr-2 h-4 w-4" />Create Empty Deck</>
              }
            </Button>
          </TabsContent>
        </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
