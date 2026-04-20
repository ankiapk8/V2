import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "wouter";
import { 
  useGetDeck, 
  useListDeckCards, 
  useUpdateCard, 
  useDeleteCard, 
  getListDeckCardsQueryKey,
  getGetDeckQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card as CardUI, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { 
  ArrowLeft, Download, Trash2, Edit2, Check, X, 
  FileText, BookOpen, Shuffle, ChevronLeft, ChevronRight,
  RotateCcw, GraduationCap, Eye, Bookmark, Play, Sparkles, Loader2,
  Brain, ClipboardList, Stethoscope
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiUrl } from "@/lib/utils";
import { saveSession, getSavePoint, saveSavePoint, clearSavePoint, type StudySavePoint } from "@/lib/study-stats";
import type { Card, Deck } from "@workspace/api-client-react/src/generated/api.schemas";
import { Drawer } from "vaul";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type DeckWithSubDecks = Deck & { subDecks?: Deck[] };

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function StudyMode({ cards, deckId, deckName, onExit, savePoint }: {
  cards: Card[];
  deckId: number;
  deckName: string;
  onExit: () => void;
  savePoint?: StudySavePoint | null;
}) {
  const buildInitialDeck = () => {
    if (savePoint) {
      const byId = new Map(cards.map(c => [c.id, c]));
      const ordered = savePoint.cardIds.map(id => byId.get(id)).filter(Boolean) as Card[];
      return ordered.length === cards.length ? ordered : cards;
    }
    return cards;
  };

  const [shuffled, setShuffled] = useState(false);
  const [deck, setDeck] = useState<Card[]>(buildInitialDeck);
  const [index, setIndex] = useState(savePoint ? Math.min(savePoint.index, Math.max(0, cards.length - 1)) : 0);
  const [revealed, setRevealed] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set(savePoint?.knownIds ?? []));
  const [unknown, setUnknown] = useState<Set<number>>(new Set(savePoint?.unknownIds ?? []));
  const [done, setDone] = useState(false);
  const [flipping, setFlipping] = useState(false);
  const savedRef = useRef(false);

  const current = deck[index];
  const total = deck.length;
  const progress = total > 0 ? Math.round(((known.size + unknown.size) / total) * 100) : 0;

  type ExplainMode = "full" | "revision" | "osce";
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explainMode, setExplainMode] = useState<ExplainMode | null>(null);
  const [isExplaining, setIsExplaining] = useState(false);

  const EXPLAIN_LABELS: Record<ExplainMode, string> = {
    full: "Full Explanation",
    revision: "1-Page Revision Sheet",
    osce: "OSCE Questions",
  };

  const handleExplain = useCallback(async (mode: ExplainMode) => {
    if (!current || isExplaining) return;
    setExplanation("");
    setExplainMode(mode);
    setIsExplaining(true);
    try {
      const resp = await fetch(apiUrl("api/explain"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ front: current.front, back: current.back, mode }),
      });
      if (!resp.ok || !resp.body) {
        const err = await resp.json().catch(() => ({}));
        setExplanation(err.error ?? "Could not get an explanation.");
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        text += decoder.decode(value, { stream: true });
        setExplanation(text);
      }
    } catch {
      setExplanation("Failed to get an explanation. Please try again.");
    } finally {
      setIsExplaining(false);
    }
  }, [current, isExplaining]);

  // Auto-save progress whenever position or results change
  useEffect(() => {
    if (done) return;
    saveSavePoint({
      deckId,
      cardIds: deck.map(c => c.id),
      index,
      knownIds: Array.from(known),
      unknownIds: Array.from(unknown),
      savedAt: new Date().toISOString(),
    });
  }, [deckId, deck, index, known, unknown, done]);

  useEffect(() => {
    if (done && !savedRef.current && (known.size + unknown.size) > 0) {
      savedRef.current = true;
      clearSavePoint(deckId);
      saveSession({
        deckId,
        deckName,
        total: known.size + unknown.size,
        known: known.size,
        unknown: unknown.size,
        completedAt: new Date().toISOString(),
      });
    }
  }, [done, known.size, unknown.size, deckId, deckName]);

  const handleSaveAndExit = useCallback(() => {
    saveSavePoint({
      deckId,
      cardIds: deck.map(c => c.id),
      index,
      knownIds: Array.from(known),
      unknownIds: Array.from(unknown),
      savedAt: new Date().toISOString(),
    });
    onExit();
  }, [deckId, deck, index, known, unknown, onExit]);

  const handleShuffle = useCallback(() => {
    const next = shuffled ? cards : shuffleArray(cards);
    setShuffled(!shuffled);
    setDeck(next);
    setIndex(0);
    setRevealed(false);
    setKnown(new Set());
    setUnknown(new Set());
    setDone(false);
  }, [shuffled, cards]);

  const handleRestart = useCallback(() => {
    clearSavePoint(deckId);
    setDeck(shuffled ? shuffleArray(cards) : cards);
    setIndex(0);
    setRevealed(false);
    setKnown(new Set());
    setUnknown(new Set());
    setDone(false);
  }, [shuffled, cards, deckId]);

  const transition = useCallback((fn: () => void) => {
    setFlipping(true);
    setExplanation(null);
    setExplainMode(null);
    setTimeout(() => { fn(); setFlipping(false); }, 150);
  }, []);

  const goNext = useCallback(() => {
    if (index + 1 >= total) { setDone(true); return; }
    transition(() => { setIndex(i => i + 1); setRevealed(false); });
  }, [index, total, transition]);

  const goPrev = useCallback(() => {
    if (index === 0) return;
    transition(() => { setIndex(i => i - 1); setRevealed(false); });
  }, [index, transition]);

  const markKnown = useCallback(() => {
    setKnown(prev => new Set([...prev, current.id]));
    setUnknown(prev => { const s = new Set(prev); s.delete(current.id); return s; });
    goNext();
  }, [current?.id, goNext]);

  const markUnknown = useCallback(() => {
    setUnknown(prev => new Set([...prev, current.id]));
    setKnown(prev => { const s = new Set(prev); s.delete(current.id); return s; });
    goNext();
  }, [current?.id, goNext]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!revealed) setRevealed(true); else markKnown(); }
      if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
      if (e.key === "1" && revealed) markKnown();
      if (e.key === "2" && revealed) markUnknown();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [revealed, goNext, goPrev, markKnown, markUnknown]);

  if (done) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-8 animate-in fade-in duration-500">
        <div className="text-center space-y-3">
          <div className="text-5xl mb-4">🎉</div>
          <h2 className="text-2xl font-serif font-bold text-primary">Study session complete!</h2>
          <p className="text-muted-foreground">You went through all {total} cards.</p>
        </div>
        <div className="flex gap-8 text-center">
          <div className="space-y-1">
            <p className="text-3xl font-bold text-green-600">{known.size}</p>
            <p className="text-sm text-muted-foreground">Got it</p>
          </div>
          <div className="w-px bg-border" />
          <div className="space-y-1">
            <p className="text-3xl font-bold text-red-500">{unknown.size}</p>
            <p className="text-sm text-muted-foreground">Still learning</p>
          </div>
        </div>
        {total > 0 && (
          <div className="w-full max-w-xs">
            <Progress value={Math.round((known.size / total) * 100)} className="h-2" />
            <p className="text-xs text-center text-muted-foreground mt-1">{Math.round((known.size / total) * 100)}% known</p>
          </div>
        )}
        <div className="flex gap-3 flex-wrap justify-center">
          <Button variant="outline" onClick={handleRestart} className="gap-2">
            <RotateCcw className="h-4 w-4" /> Study again
          </Button>
          {unknown.size > 0 && (
            <Button onClick={() => {
              const struggling = deck.filter(c => unknown.has(c.id));
              setDeck(struggling);
              setIndex(0);
              setRevealed(false);
              setKnown(new Set());
              setUnknown(new Set());
              setDone(false);
            }} className="gap-2">
              <RotateCcw className="h-4 w-4" /> Review {unknown.size} missed
            </Button>
          )}
          <Button variant="ghost" onClick={onExit} className="gap-2">
            <ArrowLeft className="h-4 w-4" /> Back to deck
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={handleSaveAndExit} className="gap-1.5 text-muted-foreground">
          <Bookmark className="h-4 w-4" /> Save & Exit
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant={shuffled ? "secondary" : "ghost"}
            size="sm"
            onClick={handleShuffle}
            className="gap-1.5 h-8 text-xs"
          >
            <Shuffle className="h-3.5 w-3.5" />
            {shuffled ? "Shuffled" : "Shuffle"}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleRestart} className="gap-1.5 h-8 text-xs text-muted-foreground">
            <RotateCcw className="h-3.5 w-3.5" /> Restart
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Card {index + 1} of {total}</span>
          <span className="flex gap-3">
            {known.size > 0 && <span className="text-green-600 font-medium">✓ {known.size} known</span>}
            {unknown.size > 0 && <span className="text-red-500 font-medium">✗ {unknown.size} learning</span>}
          </span>
        </div>
        <Progress value={progress} className="h-1.5" />
      </div>

      <div
        className={`transition-all duration-150 ${flipping ? "opacity-0 scale-95" : "opacity-100 scale-100"}`}
      >
        <CardUI className="min-h-[280px] sm:min-h-[320px] border-border/50 shadow-lg overflow-hidden">
          <CardContent className="p-0 flex flex-col h-full min-h-[280px] sm:min-h-[320px]">
            <div className="flex-1 flex flex-col p-6 sm:p-8">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-4 flex items-center gap-2">
                <span className="h-5 w-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[9px] font-bold">Q</span>
                Front
              </div>
              <p className="text-lg sm:text-xl font-medium text-foreground leading-relaxed flex-1">
                {current?.front}
              </p>
            </div>

            {revealed ? (
              <div className="border-t border-dashed border-border/60 bg-muted/30 flex flex-col p-6 sm:p-8 animate-in slide-in-from-bottom-2 duration-200">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-4 flex items-center gap-2">
                  <span className="h-5 w-5 rounded-full bg-green-500/10 text-green-600 flex items-center justify-center text-[9px] font-bold">A</span>
                  Back
                </div>
                {(current as Card & { image?: string | null })?.image && (
                  <div className="mb-4 rounded-lg overflow-hidden border border-border/40 bg-background">
                    <img
                      src={(current as Card & { image?: string | null }).image!}
                      alt="Card visual"
                      className="w-full h-auto max-h-64 object-contain"
                    />
                  </div>
                )}
                <p className="text-base sm:text-lg text-foreground leading-relaxed">
                  {current?.back}
                </p>
              </div>
            ) : (
              <div className="border-t border-dashed border-border/30 p-4 sm:p-6 flex justify-center">
                <Button onClick={() => setRevealed(true)} className="gap-2" size="lg">
                  <Eye className="h-4 w-4" /> Reveal Answer
                </Button>
              </div>
            )}
          </CardContent>
        </CardUI>
      </div>

      {revealed && (
        <div className="flex flex-col sm:flex-row gap-3 animate-in fade-in duration-200">
          <Button
            variant="outline"
            className="flex-1 gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 hover:border-red-300 h-12"
            onClick={markUnknown}
          >
            <X className="h-4 w-4" /> Still Learning
            <span className="ml-auto text-xs opacity-50">2</span>
          </Button>
          <Button
            className="flex-1 gap-2 bg-green-600 hover:bg-green-700 text-white h-12"
            onClick={markKnown}
          >
            <Check className="h-4 w-4" /> Got It
            <span className="ml-auto text-xs opacity-70">1</span>
          </Button>
        </div>
      )}

      <div className="flex justify-between items-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={goPrev}
          disabled={index === 0}
          className="gap-1 text-muted-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> Previous
        </Button>
        {!revealed && (
          <span className="text-xs text-muted-foreground">Press Space to reveal</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={goNext}
          className="gap-1 text-muted-foreground"
        >
          Skip <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {revealed && (
        <div className="rounded-xl border border-border/40 bg-muted/20 p-3">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2.5 flex items-center gap-1.5">
            <Sparkles className="h-3 w-3" /> AI Tools
          </p>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => handleExplain("full")}
              disabled={isExplaining}
              className="flex flex-col items-center gap-1.5 rounded-lg border border-border/60 bg-background hover:bg-primary/5 hover:border-primary/30 p-3 transition-all text-center disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <Brain className="h-5 w-5 text-primary group-hover:scale-110 transition-transform" />
              <span className="text-[11px] font-medium leading-tight text-foreground">Full Explanation</span>
            </button>
            <button
              onClick={() => handleExplain("revision")}
              disabled={isExplaining}
              className="flex flex-col items-center gap-1.5 rounded-lg border border-border/60 bg-background hover:bg-primary/5 hover:border-primary/30 p-3 transition-all text-center disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <ClipboardList className="h-5 w-5 text-primary group-hover:scale-110 transition-transform" />
              <span className="text-[11px] font-medium leading-tight text-foreground">Revision Sheet</span>
            </button>
            <button
              onClick={() => handleExplain("osce")}
              disabled={isExplaining}
              className="flex flex-col items-center gap-1.5 rounded-lg border border-border/60 bg-background hover:bg-primary/5 hover:border-primary/30 p-3 transition-all text-center disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <Stethoscope className="h-5 w-5 text-primary group-hover:scale-110 transition-transform" />
              <span className="text-[11px] font-medium leading-tight text-foreground">OSCE Questions</span>
            </button>
          </div>
        </div>
      )}

      <Drawer.Root
        open={explanation !== null}
        onOpenChange={(open) => {
          if (!open) { setExplanation(null); setExplainMode(null); }
        }}
      >
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 bg-black/40 z-40" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl bg-background shadow-2xl outline-none" style={{ maxHeight: "88vh" }}>
            <div className="mx-auto mt-3 mb-1 h-1 w-10 rounded-full bg-muted-foreground/20 shrink-0" />

            <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                {explainMode === "full" && <Brain className="h-4 w-4 text-primary" />}
                {explainMode === "revision" && <ClipboardList className="h-4 w-4 text-primary" />}
                {explainMode === "osce" && <Stethoscope className="h-4 w-4 text-primary" />}
                <span className="font-semibold text-sm text-foreground">
                  {explainMode ? EXPLAIN_LABELS[explainMode] : "AI Explanation"}
                </span>
                {isExplaining && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Generating…
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                {!isExplaining && (["full", "revision", "osce"] as ExplainMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => handleExplain(m)}
                    className={`h-7 px-2.5 rounded-md text-[11px] font-medium transition-colors ${
                      m === explainMode
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}
                  >
                    {m === "full" ? "Full" : m === "revision" ? "Revision" : "OSCE"}
                  </button>
                ))}
                <button
                  onClick={() => { setExplanation(null); setExplainMode(null); }}
                  className="ml-1 h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="px-5 py-5 overflow-y-auto flex-1">
              {isExplaining && (!explanation || explanation.length === 0) ? (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground">
                  <div className="relative">
                    <div className="h-10 w-10 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
                  </div>
                  <p className="text-sm">Generating {explainMode ? EXPLAIN_LABELS[explainMode] : "explanation"}…</p>
                </div>
              ) : (
                <div className="prose prose-sm dark:prose-invert max-w-none
                  prose-headings:font-semibold prose-headings:text-foreground
                  prose-h1:text-xl prose-h1:mt-6 prose-h1:mb-3
                  prose-h2:text-lg prose-h2:mt-5 prose-h2:mb-2 prose-h2:border-b prose-h2:border-border/40 prose-h2:pb-1
                  prose-h3:text-base prose-h3:mt-4 prose-h3:mb-1.5
                  prose-p:text-foreground prose-p:leading-relaxed prose-p:my-2
                  prose-strong:text-foreground prose-strong:font-semibold
                  prose-ul:my-2 prose-li:my-0.5
                  prose-ol:my-2
                  prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
                  prose-blockquote:border-primary/40 prose-blockquote:text-muted-foreground
                  prose-hr:border-border/40
                ">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {explanation ?? ""}
                  </ReactMarkdown>
                  {isExplaining && (
                    <span className="inline-block w-1.5 h-4 bg-primary/60 ml-0.5 animate-pulse rounded-sm align-middle" />
                  )}
                </div>
              )}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </div>
  );
}

export default function DeckDetail() {
  const { id } = useParams();
  const deckId = Number(id);
  const { data: deck, isLoading: isLoadingDeck } = useGetDeck(deckId);
  const { data: cards, isLoading: isLoadingCards } = useListDeckCards(deckId);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateCard = useUpdateCard();
  const deleteCard = useDeleteCard();
  const [isExporting, setIsExporting] = useState(false);
  const [studyMode, setStudyMode] = useState(false);
  const [activeSavePoint, setActiveSavePoint] = useState<StudySavePoint | null>(null);
  const [resumePrompt, setResumePrompt] = useState<StudySavePoint | null>(null);

  const handleStudyClick = useCallback(() => {
    const sp = getSavePoint(deckId);
    if (sp && sp.index > 0) {
      setResumePrompt(sp);
    } else {
      setActiveSavePoint(null);
      setStudyMode(true);
    }
  }, [deckId]);

  const deckWithSubs = deck as DeckWithSubDecks | undefined;
  const subDecks = deckWithSubs?.subDecks ?? [];
  const hasSubDecks = subDecks.length > 0;

  const handleExport = async () => {
    if (!deck) return;
    setIsExporting(true);
    try {
      const resp = await fetch(apiUrl("api/export-apkg"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deckIds: [deckId], exportName: deck.name }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error ?? "Export failed.");
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), {
        href: url,
        download: `${deck.name.replace(/[^a-z0-9_\-]/gi, "_")}.apkg`,
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: `Downloaded ${deck.name}.apkg — ready to import into Anki.` });
    } catch (err) {
      toast({ title: "Export failed", description: err instanceof Error ? err.message : "Something went wrong.", variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoadingDeck) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-10 w-1/3" />
        <div className="grid gap-4"><Skeleton className="h-40 w-full" /></div>
      </div>
    );
  }

  if (!deck) {
    return <div className="text-center py-20">Deck not found</div>;
  }

  const cardList = cards ?? [];

  if (studyMode && cardList.length > 0) {
    return (
      <div className="space-y-6 animate-in fade-in duration-300 pb-20">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-serif font-bold text-primary tracking-tight">{deck.name}</h1>
          <Badge className="gap-1.5 bg-primary/10 text-primary border-primary/20 hover:bg-primary/10">
            <GraduationCap className="h-3.5 w-3.5" /> Study Mode
          </Badge>
        </div>
        <StudyMode
          cards={cardList}
          deckId={deck.id}
          deckName={deck.name}
          savePoint={activeSavePoint}
          onExit={() => { setStudyMode(false); setActiveSavePoint(null); }}
        />
      </div>
    );
  }

  if (resumePrompt) {
    const savedTime = new Date(resumePrompt.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const progress = resumePrompt.cardIds.length > 0
      ? Math.round(((resumePrompt.knownIds.length + resumePrompt.unknownIds.length) / resumePrompt.cardIds.length) * 100)
      : 0;
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-6 animate-in fade-in duration-300 px-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 mb-2">
              <Bookmark className="h-7 w-7 text-primary" />
            </div>
            <h2 className="text-xl font-serif font-bold text-primary">Resume where you left off?</h2>
            <p className="text-sm text-muted-foreground">You saved a study session on {savedTime}</p>
          </div>

          <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Card</span>
              <span className="font-medium">{resumePrompt.index + 1} / {resumePrompt.cardIds.length}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Got it</span>
              <span className="font-medium text-green-600">{resumePrompt.knownIds.length}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Still learning</span>
              <span className="font-medium text-red-500">{resumePrompt.unknownIds.length}</span>
            </div>
            <Progress value={progress} className="h-1.5 mt-1" />
            <p className="text-xs text-center text-muted-foreground">{progress}% answered</p>
          </div>

          <div className="flex flex-col gap-3">
            <Button
              className="w-full gap-2"
              onClick={() => {
                setActiveSavePoint(resumePrompt);
                setResumePrompt(null);
                setStudyMode(true);
              }}
            >
              <Play className="h-4 w-4" /> Continue from card {resumePrompt.index + 1}
            </Button>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => {
                clearSavePoint(deckId);
                setActiveSavePoint(null);
                setResumePrompt(null);
                setStudyMode(true);
              }}
            >
              <RotateCcw className="h-4 w-4" /> Start fresh
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => setResumePrompt(null)}>
              <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to deck
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500 pb-20">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <Link href="/decks" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary mb-2 transition-colors">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to Library
          </Link>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-serif font-bold text-primary tracking-tight">{deck.name}</h1>
            {hasSubDecks && (
              <Badge variant="outline" className="text-sm">
                {subDecks.length} sub-deck{subDecks.length !== 1 ? "s" : ""}
              </Badge>
            )}
          </div>
          {deck.description && <p className="text-muted-foreground mt-1">{deck.description}</p>}
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap">
          {cardList.length > 0 && (
            <Button 
              variant="outline" 
              onClick={handleStudyClick} 
              className="gap-2"
            >
              <BookOpen className="h-4 w-4" />
              Study
              {getSavePoint(deckId)?.index ? (
                <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">resume</Badge>
              ) : null}
            </Button>
          )}
          <Button onClick={handleExport} disabled={isExporting} className="gap-2">
            <Download className="h-4 w-4" />
            Export for Anki
          </Button>
        </div>
      </div>

      {hasSubDecks && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight border-b pb-2">Sub-Decks</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {subDecks.map(sub => (
              <Link key={sub.id} href={`/decks/${sub.id}`}>
                <CardUI className="hover:border-primary/40 hover:shadow-md transition-all cursor-pointer border-border/40">
                  <CardContent className="flex items-center gap-3 py-3 px-4">
                    <div className="h-8 w-8 rounded-md bg-blue-500/10 flex items-center justify-center shrink-0">
                      <FileText className="h-4 w-4 text-blue-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{sub.name}</p>
                    </div>
                    <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded shrink-0">
                      {sub.cardCount} card{sub.cardCount !== 1 ? "s" : ""}
                    </span>
                  </CardContent>
                </CardUI>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-6">
        <div className="flex items-center justify-between border-b pb-2">
          <h2 className="text-xl font-medium tracking-tight">
            Cards ({cardList.length})
            {hasSubDecks && cardList.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground ml-2">across all sub-decks</span>
            )}
          </h2>
        </div>

        {isLoadingCards ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 w-full" />)}
          </div>
        ) : cardList.length === 0 ? (
          <div className="text-center py-12 bg-card rounded-lg border border-dashed">
            <p className="text-muted-foreground">No cards in this deck yet.</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {cardList.map((card, idx) => (
              <EditableCard 
                key={card.id} 
                card={card}
                subDeckName={hasSubDecks ? subDecks.find(s => s.id === card.deckId)?.name : undefined}
                index={idx}
                onUpdate={(id, data) => updateCard.mutate(
                  { id, data },
                  {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: getListDeckCardsQueryKey(deckId) });
                      toast({ title: "Card updated" });
                    }
                  }
                )}
                onDelete={(id) => {
                  if (confirm("Delete this card?")) {
                    deleteCard.mutate({ id }, {
                      onSuccess: () => {
                        queryClient.invalidateQueries({ queryKey: getListDeckCardsQueryKey(deckId) });
                        queryClient.invalidateQueries({ queryKey: getGetDeckQueryKey(deckId) });
                        toast({ title: "Card deleted" });
                      }
                    });
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EditableCard({ 
  card, 
  index,
  subDeckName,
  onUpdate, 
  onDelete 
}: { 
  card: Card;
  index: number;
  subDeckName?: string;
  onUpdate: (id: number, data: { front: string; back: string }) => void; 
  onDelete: (id: number) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);

  const handleSave = () => {
    if (front !== card.front || back !== card.back) {
      onUpdate(card.id, { front, back });
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setFront(card.front);
    setBack(card.back);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <CardUI className="border-primary/40 shadow-md ring-1 ring-primary/20">
        <CardContent className="p-4 space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Front</label>
            <Textarea 
              value={front} 
              onChange={e => setFront(e.target.value)} 
              className="min-h-[80px] font-medium"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Back</label>
            <Textarea 
              value={back} 
              onChange={e => setBack(e.target.value)} 
              className="min-h-[100px]"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              <X className="h-4 w-4 mr-1" /> Cancel
            </Button>
            <Button size="sm" onClick={handleSave}>
              <Check className="h-4 w-4 mr-1" /> Save Changes
            </Button>
          </div>
        </CardContent>
      </CardUI>
    );
  }

  return (
    <CardUI 
      className="group hover-elevate transition-all duration-300 border-border/40 animate-in fade-in slide-in-from-bottom-2"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {subDeckName && (
        <div className="px-4 pt-3 pb-0">
          <span className="text-[10px] font-semibold text-blue-500 bg-blue-500/10 px-2 py-0.5 rounded-sm uppercase tracking-wider">
            {subDeckName}
          </span>
        </div>
      )}
      <CardContent className="p-0 flex flex-col sm:flex-row relative">
        <div className="flex-1 p-4 sm:p-5 border-b sm:border-b-0 sm:border-r border-border/40">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Front</div>
          <p className="font-medium text-foreground whitespace-pre-wrap leading-relaxed">{card.front}</p>
        </div>
        <div className="flex-1 p-4 sm:p-5">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Back</div>
          {(card as Card & { image?: string | null }).image && (
            <div className="mb-3 rounded-md overflow-hidden border border-border/40">
              <img
                src={(card as Card & { image?: string | null }).image!}
                alt="Card visual"
                className="w-full h-auto max-h-48 object-contain bg-background"
              />
            </div>
          )}
          <p className="text-muted-foreground whitespace-pre-wrap leading-relaxed">{card.back}</p>
        </div>
        
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-1 bg-background/80 backdrop-blur-sm rounded-md shadow-sm p-1">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => setIsEditing(true)}>
            <Edit2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => onDelete(card.id)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </CardUI>
  );
}
