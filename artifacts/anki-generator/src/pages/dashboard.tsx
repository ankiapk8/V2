import { Link } from "wouter";
import { useListDecks } from "@workspace/api-client-react";
import { format, isThisWeek, isToday } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Layers, FileText, Sparkles, TrendingUp, ChevronRight, PlusCircle, Clock } from "lucide-react";

export default function Dashboard() {
  const { data: decks, isLoading } = useListDecks();

  const totalDecks = decks?.length ?? 0;
  const totalCards = decks?.reduce((sum, d) => sum + d.cardCount, 0) ?? 0;
  const thisWeekDecks = decks?.filter(d => isThisWeek(new Date(d.createdAt))).length ?? 0;
  const todayCards = decks
    ?.filter(d => isToday(new Date(d.createdAt)))
    .reduce((sum, d) => sum + d.cardCount, 0) ?? 0;

  const recentDecks = [...(decks ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ).slice(0, 5);

  const stats = [
    { label: "Total Decks", value: totalDecks, icon: Layers, color: "text-primary" },
    { label: "Total Cards", value: totalCards, icon: FileText, color: "text-blue-500" },
    { label: "Decks This Week", value: thisWeekDecks, icon: TrendingUp, color: "text-green-500" },
    { label: "Cards Today", value: todayCards, icon: Sparkles, color: "text-amber-500" },
  ];

  return (
    <div className="space-y-8 animate-in fade-in duration-500 pb-10">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-primary tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Your study progress at a glance.</p>
        </div>
        <Link href="/generate">
          <Button className="gap-2">
            <PlusCircle className="h-4 w-4" />
            Generate Cards
          </Button>
        </Link>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="border-border/50 shadow-sm">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
            </CardHeader>
            <CardContent className="pb-4 px-4">
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <p className="text-3xl font-bold tracking-tight">{value}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link href="/generate">
          <Card className="border-border/50 shadow-sm hover:border-primary/40 hover:shadow-md transition-all cursor-pointer group">
            <CardContent className="flex items-center gap-4 p-5">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold">Generate New Decks</p>
                <p className="text-sm text-muted-foreground">Upload files or paste text to create flashcards</p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </CardContent>
          </Card>
        </Link>
        <Link href="/decks">
          <Card className="border-border/50 shadow-sm hover:border-primary/40 hover:shadow-md transition-all cursor-pointer group">
            <CardContent className="flex items-center gap-4 p-5">
              <div className="h-10 w-10 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 group-hover:bg-blue-500/20 transition-colors">
                <Layers className="h-5 w-5 text-blue-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold">Browse Library</p>
                <p className="text-sm text-muted-foreground">View, edit, and export all your decks</p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Recent decks */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight">Recent Decks</h2>
          {totalDecks > 5 && (
            <Link href="/decks">
              <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground">
                View all <ChevronRight className="h-3 w-3" />
              </Button>
            </Link>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 rounded-lg" />)}
          </div>
        ) : recentDecks.length === 0 ? (
          <Card className="border-2 border-dashed border-border/50">
            <CardContent className="text-center py-12">
              <Layers className="mx-auto h-10 w-10 text-muted-foreground opacity-40 mb-3" />
              <p className="font-medium text-muted-foreground">No decks yet</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4">Generate your first deck to get started.</p>
              <Link href="/generate">
                <Button size="sm" className="gap-2">
                  <PlusCircle className="h-4 w-4" />
                  Generate Cards
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {recentDecks.map((deck, idx) => (
              <Link key={deck.id} href={`/decks/${deck.id}`}>
                <Card
                  className="border-border/50 shadow-sm hover:border-primary/40 hover:shadow-md transition-all cursor-pointer animate-in fade-in slide-in-from-bottom-2"
                  style={{ animationDelay: `${idx * 40}ms` }}
                >
                  <CardContent className="flex items-center gap-4 py-3 px-4">
                    <div className="h-9 w-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                      <Layers className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{deck.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(deck.createdAt), "MMM d, yyyy 'at' h:mm a")}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-sm font-medium text-primary bg-primary/10 px-2.5 py-1 rounded-md">
                        {deck.cardCount} {deck.cardCount === 1 ? "card" : "cards"}
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
