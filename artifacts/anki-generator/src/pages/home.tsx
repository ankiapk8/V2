import { useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useGenerateCards } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { FileText, Loader2, UploadCloud, X, CheckCircle2, AlertCircle } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type FileEntry = {
  id: string;
  name: string;
  status: "extracting" | "ready" | "error";
  text: string;
  progress: string;
};

export default function Home() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const generateCards = useGenerateCards();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [manualText, setManualText] = useState("");
  const [deckName, setDeckName] = useState("");
  const [cardCount, setCardCount] = useState<number | "">("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const combinedText = [manualText, ...files.filter(f => f.status === "ready").map(f => f.text)]
    .filter(Boolean)
    .join("\n\n");

  const isExtracting = files.some(f => f.status === "extracting");

  const updateFile = (id: string, patch: Partial<FileEntry>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  };

  const extractPdfText = async (buffer: ArrayBuffer): Promise<string> => {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadingTask.promise;
    const pageTexts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pageText = content.items.map((item: any) => (typeof item.str === "string" ? item.str : "")).join(" ");
      pageTexts.push(pageText);
    }
    return pageTexts.join("\n").replace(/\s+/g, " ").trim();
  };

  const ocrPdfPages = async (buffer: ArrayBuffer, id: string, totalPages: number): Promise<string> => {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadingTask.promise;
    const worker = await createWorker("eng");
    const pageTexts: string[] = [];

    for (let i = 1; i <= totalPages; i++) {
      updateFile(id, { progress: `OCR page ${i}/${totalPages}…` });
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const { data } = await worker.recognize(blob);
      pageTexts.push(data.text);
    }

    await worker.terminate();
    return pageTexts.join("\n").replace(/\s+/g, " ").trim();
  };

  const processFile = useCallback(async (file: File) => {
    const id = `${file.name}-${Date.now()}`;
    const isTxt = file.type === "text/plain" || file.name.endsWith(".txt");
    const isPdf = file.type === "application/pdf" || file.name.endsWith(".pdf");

    if (!isTxt && !isPdf) {
      toast({ title: "Unsupported file", description: `${file.name} is not a .txt or .pdf file.`, variant: "destructive" });
      return;
    }

    const entry: FileEntry = { id, name: file.name, status: "extracting", text: "", progress: "Reading…" };
    setFiles(prev => [...prev, entry]);

    if (!deckName) setDeckName(file.name.replace(/\.[^.]+$/, ""));

    try {
      if (isTxt) {
        const text = await file.text();
        updateFile(id, { status: "ready", text, progress: "" });
      } else {
        const buffer = await file.arrayBuffer();
        updateFile(id, { progress: "Extracting text…" });
        const extracted = await extractPdfText(buffer);

        if (extracted && extracted.length > 20) {
          updateFile(id, { status: "ready", text: extracted, progress: "" });
        } else {
          updateFile(id, { progress: "Starting OCR…" });
          const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
          const pdf = await loadingTask.promise;
          const ocrText = await ocrPdfPages(buffer, id, pdf.numPages);
          if (ocrText && ocrText.length > 20) {
            updateFile(id, { status: "ready", text: ocrText, progress: "" });
          } else {
            updateFile(id, { status: "error", progress: "No text found" });
          }
        }
      }
    } catch {
      updateFile(id, { status: "error", progress: "Extraction failed" });
    }
  }, [deckName, toast]);

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const file of selected) {
      await processFile(file);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    for (const file of dropped) {
      await processFile(file);
    }
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const handleGenerate = () => {
    if (!combinedText.trim()) {
      toast({ title: "No content", description: "Paste text or upload at least one file.", variant: "destructive" });
      return;
    }
    if (!deckName.trim()) {
      toast({ title: "Deck name required", description: "Please enter a name for your deck.", variant: "destructive" });
      return;
    }

    generateCards.mutate(
      { data: { text: combinedText, deckName, cardCount: cardCount ? Number(cardCount) : undefined } },
      {
        onSuccess: (data) => {
          toast({ title: "Cards generated!", description: `Created ${data.generatedCount} cards.` });
          setLocation(`/decks/${data.deck.id}`);
        },
        onError: () => {
          toast({ title: "Generation failed", description: "There was an error generating your cards. Please try again.", variant: "destructive" });
        },
      }
    );
  };

  const readyCount = files.filter(f => f.status === "ready").length;

  return (
    <div className="flex-1 flex flex-col items-center justify-center max-w-2xl mx-auto w-full animate-in fade-in duration-500">
      <div className="text-center mb-10 space-y-3">
        <h1 className="text-4xl md:text-5xl font-serif font-bold tracking-tight text-primary">
          Turn material into mastery.
        </h1>
        <p className="text-muted-foreground text-lg max-w-xl mx-auto">
          Upload multiple files or paste your notes — AI will instantly generate focused Anki flashcards.
        </p>
      </div>

      <Card className="w-full border-border/50 shadow-lg shadow-primary/5">
        <CardHeader>
          <CardTitle>Source Material</CardTitle>
          <CardDescription>Upload one or more files and/or paste additional text.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">

          {/* Drop zone */}
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
              disabled={generateCards.isPending}
            />
            <UploadCloud className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm font-medium">Drop files here or click to browse</p>
            <p className="text-xs text-muted-foreground mt-1">Supports PDF and TXT — select multiple files at once</p>
          </div>

          {/* File list */}
          {files.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                {readyCount}/{files.length} file{files.length !== 1 ? "s" : ""} ready
              </p>
              {files.map(f => (
                <div key={f.id} className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50 border border-border/50">
                  {f.status === "extracting" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />}
                  {f.status === "ready" && <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />}
                  {f.status === "error" && <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />}
                  <span className="text-sm flex-1 truncate">{f.name}</span>
                  {f.status === "extracting" && (
                    <span className="text-xs text-muted-foreground shrink-0">{f.progress}</span>
                  )}
                  {f.status === "ready" && (
                    <Badge variant="secondary" className="text-xs shrink-0">
                      {(f.text.length / 1000).toFixed(1)}k chars
                    </Badge>
                  )}
                  {f.status === "error" && (
                    <span className="text-xs text-destructive shrink-0">{f.progress}</span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFile(f.id); }}
                    className="ml-1 text-muted-foreground hover:text-foreground shrink-0"
                    disabled={generateCards.isPending}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Manual text area */}
          <div className="space-y-1">
            <Label className="text-sm text-muted-foreground">
              Additional text {files.length > 0 ? "(optional)" : ""}
            </Label>
            <Textarea
              placeholder="Paste additional study material here..."
              className="min-h-[140px] resize-none text-base"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              disabled={generateCards.isPending}
            />
          </div>

          {combinedText.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Total content: {(combinedText.length / 1000).toFixed(1)}k characters
            </p>
          )}

          {/* Deck settings */}
          <div className="grid md:grid-cols-2 gap-4 pt-4 border-t">
            <div className="space-y-2">
              <Label htmlFor="deckName">Deck Name</Label>
              <Input
                id="deckName"
                placeholder="e.g. Biology 101 Midterm"
                value={deckName}
                onChange={(e) => setDeckName(e.target.value)}
                disabled={generateCards.isPending || isExtracting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cardCount">Target Card Count (Optional)</Label>
              <Input
                id="cardCount"
                type="number"
                placeholder="e.g. 20"
                min="1"
                max="100"
                value={cardCount}
                onChange={(e) => setCardCount(e.target.value ? Number(e.target.value) : "")}
                disabled={generateCards.isPending || isExtracting}
              />
            </div>
          </div>

          <Button
            className="w-full py-6 text-lg font-medium"
            size="lg"
            onClick={handleGenerate}
            disabled={generateCards.isPending || isExtracting || !combinedText.trim() || !deckName.trim()}
          >
            {generateCards.isPending ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Generating Cards…
              </>
            ) : isExtracting ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Processing Files…
              </>
            ) : (
              <>
                <FileText className="mr-2 h-5 w-5" />
                Generate Flashcards
                {readyCount > 0 && ` from ${readyCount} file${readyCount !== 1 ? "s" : ""}${manualText.trim() ? " + text" : ""}`}
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
