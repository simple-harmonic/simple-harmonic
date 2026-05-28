"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

// ---------------------------------------------------------------------------
// Theme provider
//
// Stores the user's preference in localStorage as one of:
//   "system" | "light" | "dark"
//
// "system" tracks prefers-color-scheme live (re-applies if the OS toggles).
// The .dark class on <html> is the actual switch; CSS variables read from it.
//
// A small inline script (see THEME_INIT_SCRIPT) runs before paint in
// layout.tsx so there's no light-flash on first load when the user prefers
// dark. Keep this provider in sync with that script.
// ---------------------------------------------------------------------------

export type ThemePref = "system" | "light" | "dark";

const STORAGE_KEY = "simple-harmonic-theme";

interface ThemeContextValue {
  pref: ThemePref;
  // The actual applied theme (resolves "system" to "light" or "dark").
  resolved: "light" | "dark";
  setPref: (pref: ThemePref) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readSystemPref(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readStoredPref(): ThemePref {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function applyTheme(resolved: "light" | "dark") {
  const html = document.documentElement;
  if (resolved === "dark") {
    html.classList.add("dark");
  } else {
    html.classList.remove("dark");
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Default to "system" during SSR; the init script handles first paint.
  const [pref, setPrefState] = useState<ThemePref>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  // Hydrate from localStorage + system on mount.
  useEffect(() => {
    const stored = readStoredPref();
    setPrefState(stored);
    const next = stored === "system" ? readSystemPref() : stored;
    setResolved(next);
    applyTheme(next);
  }, []);

  // When pref is "system", keep in sync with OS changes.
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next = mq.matches ? "dark" : "light";
      setResolved(next);
      applyTheme(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    const r = next === "system" ? readSystemPref() : next;
    setResolved(r);
    applyTheme(r);
  }, []);

  return (
    <ThemeContext.Provider value={{ pref, resolved, setPref }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Allow components to be used outside the provider in tests; return a
    // sensible default rather than throwing.
    return { pref: "system", resolved: "light", setPref: () => {} };
  }
  return ctx;
}

// Inlined into layout.tsx via <script dangerouslySetInnerHTML>. Runs before
// React hydrates so the .dark class is on <html> for first paint.
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}');
    var pref = (stored === 'light' || stored === 'dark') ? stored : 'system';
    var resolved = pref === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    if (resolved === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  } catch (e) {}
})();
`;
