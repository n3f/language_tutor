import {
  Outlet,
  Link,
  createRootRoute,
  HeadContent,
  Scripts,
  useLocation,
} from "@tanstack/react-router";
import { Mic, BookOpen, Settings, Coffee, Sun, Moon } from "lucide-react";
import { Toaster } from "sonner";
import { createContext, useContext, useState, useEffect, useCallback } from "react";

import appCss from "../styles.css?url";

type Theme = "light" | "dark";

const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void }>({
  theme: "dark",
  toggleTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AI-powered Language Practice Through Conversation" },
      {
        name: "description",
        content: "Language speaking practice with an AI tutor",
      },
      { name: "author", content: "Alex Shelaev" },
      { property: "og:title", content: "AI-powered Language Practice Through Conversation" },
      { property: "og:description", content: "Language speaking practice with an AI tutor" },
      { property: "og:type", content: "website" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("fvt_theme") as Theme) || "dark";
    }
    return "dark";
  });

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem("fvt_theme", next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.className = theme === "dark" ? "dark" : "";
  }, [theme]);

  return (
    <html lang="en" className={theme === "dark" ? "dark" : ""}>
      <head>
        <HeadContent />
        <link rel="preconnect" href="https://api.openai.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://api.groq.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-background text-foreground antialiased">
        <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
        <Toaster position="top-center" richColors />
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const location = useLocation();
  const isSetupOrUnlock = location.pathname === "/setup" || location.pathname === "/unlock";

  return (
    <div className="flex min-h-[100dvh] flex-col">
      {!isSetupOrUnlock && <TopNav />}
      <div className="flex-1">
        <Outlet />
      </div>
      {!isSetupOrUnlock && (
        <footer className="border-t border-border bg-card px-4 py-3 text-center space-y-1">
          <p className="text-xs text-muted-foreground">Built by Alex Shelaev, 2026</p>
          <div className="flex items-center justify-center gap-3">
            <a
              href="https://www.linkedin.com/in/shelaev/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline transition-colors"
            >
              Contact me
            </a>
            <a
              href="https://paypal.me/AShelaev"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-primary hover:underline transition-colors"
            >
              <Coffee className="h-3.5 w-3.5" />
              Buy me a coffee
            </a>
          </div>
        </footer>
      )}
    </div>
  );
}

function GitHubIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function TopNav() {
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const tabs = [
    { to: "/" as const, label: "Practice", icon: Mic },
    { to: "/instructions" as const, label: "Guide", icon: BookOpen },
    { to: "/settings" as const, label: "Settings", icon: Settings },
  ];

  return (
    <nav className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="relative">
        <button
          className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          title="Toggle theme"
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
          onClick={toggleTheme}
        >
          {theme === "dark" ? (
            <Sun style={{ width: "20px", height: "20px" }} />
          ) : (
            <Moon style={{ width: "20px", height: "20px" }} />
          )}
        </button>
        <button
          className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          title="GitHub"
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
          onClick={() =>
            window.open(
              "https://github.com/mamnunam/language_tutor",
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          <GitHubIcon style={{ width: "20px", height: "20px" }} />
        </button>
        <div className="mx-auto flex max-w-lg">
          {tabs.map(({ to, label, icon: Icon }) => {
            const active = location.pathname === to;
            return (
              <Link
                key={to}
                to={to}
                className={`flex flex-1 flex-col items-center gap-1 pt-3 pb-2 text-xs transition-colors ${
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-5 w-5" />
                <span>{label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
