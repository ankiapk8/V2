import { Link, useLocation } from "wouter";
import { BookOpen, LayoutDashboard, Library, Sparkles } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navLinks = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/generate", label: "Generate", icon: Sparkles },
    { href: "/decks", label: "Library", icon: Library },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center px-4 md:px-6 max-w-5xl mx-auto">
          <Link href="/" className="flex items-center gap-2 mr-8">
            <BookOpen className="h-6 w-6 text-primary" />
            <span className="font-serif text-lg font-bold tracking-tight">AnkiGen</span>
          </Link>
          <nav className="flex items-center gap-1">
            {navLinks.map(({ href, label, icon: Icon }) => {
              const isActive = href === "/"
                ? location === "/"
                : href === "/decks"
                ? location.startsWith("/decks")
                : location === href;
              return (
                <Link key={href} href={href}>
                  <span
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-foreground/60 hover:text-foreground hover:bg-muted"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 flex flex-col w-full max-w-5xl mx-auto p-4 md:p-8">
        {children}
      </main>
    </div>
  );
}
