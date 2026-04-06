import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateDeck, useUpdateDeck, useListDecks, getListDecksQueryKey } from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, FolderOpen, Layers, FileText, Plus, X } from "lucide-react";
import type { Deck } from "@workspace/api-client-react/src/generated/api.schemas";

type DeckWithParent = Deck & { parentId?: number | null };

export type DeckFormMode =
  | { type: "new-topic" }
  | { type: "new-subdeck"; parentId?: number }
  | { type: "edit"; deck: DeckWithParent };

interface DeckFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: DeckFormMode;
  onDone?: () => void;
}

export function DeckFormSheet({ open, onOpenChange, mode, onDone }: DeckFormSheetProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createDeck = useCreateDeck();
  const updateDeck = useUpdateDeck();
  const { data: allDecks } = useListDecks();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState<string>("none");
  const [isSaving, setIsSaving] = useState(false);

  // Sub-deck slots (for new-topic mode: optionally create sub-decks right away)
  const [subSlots, setSubSlots] = useState<{ id: string; name: string }[]>([]);

  // Topic decks = root decks that are not the deck being edited
  const topicDecks = ((allDecks as DeckWithParent[]) ?? []).filter(d => {
    if (!d.parentId) {
      if (mode.type === "edit" && d.id === mode.deck.id) return false;
      return true;
    }
    return false;
  });

  // Reset form when mode or open changes
  useEffect(() => {
    if (!open) return;
    if (mode.type === "new-topic") {
      setName(""); setDescription(""); setParentId("none"); setSubSlots([]);
    } else if (mode.type === "new-subdeck") {
      setName(""); setDescription("");
      setParentId(mode.parentId?.toString() ?? "none");
      setSubSlots([]);
    } else {
      setName(mode.deck.name);
      setDescription(mode.deck.description ?? "");
      setParentId(mode.deck.parentId?.toString() ?? "none");
      setSubSlots([]);
    }
  }, [open, mode.type]);

  const resolvedParentId = parentId === "none" ? null : parseInt(parentId, 10);

  const addSubSlot = () => {
    if (subSlots.length >= 8) return;
    setSubSlots(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, name: "" }]);
  };

  const removeSubSlot = (id: string) => setSubSlots(prev => prev.filter(s => s.id !== id));
  const updateSubSlot = (id: string, name: string) =>
    setSubSlots(prev => prev.map(s => s.id === id ? { ...s, name } : s));

  const handleSave = async () => {
    if (!name.trim()) return;
    setIsSaving(true);

    try {
      if (mode.type === "edit") {
        await new Promise<void>((resolve, reject) =>
          updateDeck.mutate(
            { id: mode.deck.id, data: { name: name.trim(), description: description.trim() || null, parentId: resolvedParentId } },
            { onSuccess: () => resolve(), onError: reject }
          )
        );
        toast({ title: "Deck updated." });
      } else {
        // Create the main deck / sub-deck
        const created = await new Promise<DeckWithParent>((resolve, reject) =>
          createDeck.mutate(
            { data: { name: name.trim(), description: description.trim() || null, parentId: resolvedParentId } },
            { onSuccess: d => resolve(d as DeckWithParent), onError: reject }
          )
        );

        // If we're creating a topic and have sub-deck slots, create them too
        if (mode.type === "new-topic" && subSlots.length > 0) {
          const validSlots = subSlots.filter(s => s.name.trim());
          await Promise.all(
            validSlots.map(s =>
              new Promise<void>((resolve, reject) =>
                createDeck.mutate(
                  { data: { name: s.name.trim(), parentId: created.id } },
                  { onSuccess: () => resolve(), onError: reject }
                )
              )
            )
          );
          toast({
            title: "Topic created!",
            description: validSlots.length > 0
              ? `"${name}" created with ${validSlots.length} sub-deck${validSlots.length !== 1 ? "s" : ""}.`
              : `"${name}" topic created.`,
          });
        } else {
          toast({ title: mode.type === "new-topic" ? "Topic created!" : "Deck created!" });
        }
      }

      queryClient.invalidateQueries({ queryKey: getListDecksQueryKey() });
      onDone?.();
      onOpenChange(false);
    } catch {
      toast({ title: "Something went wrong.", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const title =
    mode.type === "new-topic" ? "New Main Topic" :
    mode.type === "new-subdeck" ? "New Sub-deck" :
    "Edit Deck";

  const description_ =
    mode.type === "new-topic" ? "Create a topic to organise related decks under one folder." :
    mode.type === "new-subdeck" ? "Create a deck inside an existing main topic." :
    "Update this deck's name, description, or topic assignment.";

  const Icon = mode.type === "new-topic" ? FolderOpen : mode.type === "new-subdeck" ? FileText : Layers;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <SheetTitle className="font-serif text-2xl">{title}</SheetTitle>
          </div>
          <SheetDescription>{description_}</SheetDescription>
        </SheetHeader>

        <div className="space-y-5">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="deck-name">
              {mode.type === "new-topic" ? "Topic Name" : "Deck Name"} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="deck-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={mode.type === "new-topic" ? "e.g. Biology, Machine Learning…" : "e.g. Chapter 1, Week 3 Notes…"}
              autoFocus
              disabled={isSaving}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="deck-desc">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Textarea
              id="deck-desc"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What is this for?"
              rows={2}
              className="resize-none"
              disabled={isSaving}
            />
          </div>

          {/* Parent topic selector — shown for subdeck or edit mode */}
          {(mode.type === "new-subdeck" || mode.type === "edit") && (
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                {mode.type === "edit" ? "Main Topic" : "Main Topic"}{" "}
                {mode.type === "new-subdeck" && <span className="text-destructive">*</span>}
                {mode.type === "edit" && <span className="text-muted-foreground font-normal">(optional)</span>}
              </Label>
              <Select value={parentId} onValueChange={setParentId} disabled={isSaving}>
                <SelectTrigger>
                  <SelectValue placeholder={mode.type === "new-subdeck" ? "Select a main topic…" : "No parent — standalone"} />
                </SelectTrigger>
                <SelectContent>
                  {mode.type === "edit" && <SelectItem value="none">No parent — standalone deck</SelectItem>}
                  {topicDecks.map(d => (
                    <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>
                  ))}
                  {topicDecks.length === 0 && mode.type === "new-subdeck" && (
                    <div className="px-2 py-3 text-sm text-muted-foreground text-center">
                      No topics yet. Create a main topic first.
                    </div>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Sub-decks to create alongside topic — only for new-topic mode */}
          {mode.type === "new-topic" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  Sub-decks <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                {subSlots.length < 8 && (
                  <button
                    onClick={addSubSlot}
                    className="text-xs text-primary hover:underline flex items-center gap-0.5"
                    disabled={isSaving}
                  >
                    <Plus className="h-3 w-3" /> Add
                  </button>
                )}
              </div>

              {subSlots.length === 0 ? (
                <button
                  onClick={addSubSlot}
                  className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg py-3 text-sm text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
                  disabled={isSaving}
                >
                  <Plus className="h-4 w-4" /> Add sub-decks inside this topic
                </button>
              ) : (
                <div className="space-y-2">
                  {subSlots.map((slot, idx) => (
                    <div key={slot.id} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-5 text-right shrink-0">{idx + 1}.</span>
                      <Input
                        value={slot.name}
                        onChange={e => updateSubSlot(slot.id, e.target.value)}
                        placeholder={`Sub-deck ${idx + 1} name…`}
                        className="h-8 text-sm flex-1"
                        disabled={isSaving}
                      />
                      <button
                        onClick={() => removeSubSlot(slot.id)}
                        className="text-muted-foreground hover:text-destructive shrink-0"
                        disabled={isSaving}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {subSlots.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {subSlots.filter(s => s.name.trim()).length} named sub-deck{subSlots.filter(s => s.name.trim()).length !== 1 ? "s" : ""} will be created.
                </p>
              )}
            </div>
          )}

          {/* Preview */}
          {mode.type === "new-topic" && name.trim() && (
            <div className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Preview</p>
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm font-medium">{name.trim()}</span>
                {subSlots.some(s => s.name.trim()) && (
                  <Badge variant="outline" className="text-xs ml-auto">
                    {subSlots.filter(s => s.name.trim()).length} sub-deck{subSlots.filter(s => s.name.trim()).length !== 1 ? "s" : ""}
                  </Badge>
                )}
              </div>
              {subSlots.filter(s => s.name.trim()).map((s, i) => (
                <div key={s.id} className="flex items-center gap-2 ml-4 border-l-2 border-primary/20 pl-3">
                  <FileText className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                  <span className="text-xs text-muted-foreground">{name.trim()}::{s.name.trim()}</span>
                </div>
              ))}
            </div>
          )}

          <Button className="w-full" onClick={handleSave} disabled={!name.trim() || isSaving || (mode.type === "new-subdeck" && parentId === "none" && topicDecks.length > 0)}>
            {isSaving
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
              : mode.type === "edit" ? "Save Changes"
              : mode.type === "new-topic"
                ? subSlots.some(s => s.name.trim())
                  ? `Create Topic + ${subSlots.filter(s => s.name.trim()).length} Sub-deck${subSlots.filter(s => s.name.trim()).length !== 1 ? "s" : ""}`
                  : "Create Topic"
              : "Create Deck"
            }
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
