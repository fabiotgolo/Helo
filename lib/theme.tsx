"use client";

// ——— Tema visual da Helo: pertence ao PACIENTE ativo ———
// A aparência é uma configuração compartilhada do paciente. Trocar de
// paciente aplica imediatamente as settings dele; se não houver configuração,
// volta para Helo Original, sem reaproveitar a aparência anterior.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  isThemeId,
  sanitizeFontScales,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  type ThemeId,
} from "@/lib/access-types";
import { PATIENT_SETTING_KEYS } from "@/lib/defaults";
import { usePatient } from "@/lib/patient";

export type { ThemeId };
export { FONT_SCALE_MIN, FONT_SCALE_MAX };

export type FontScales = Partial<Record<ThemeId, number>>;

export type ThemeSwatches = {
  bg: string;
  surface: string;
  text: string;
  textSoft: string;
  accent: string;
};

export type ThemeMeta = {
  id: ThemeId;
  label: string;
  description: string;
  swatches: ThemeSwatches;
};

export const THEMES: ThemeMeta[] = [
  {
    id: "helo-original",
    label: "Helo Original",
    description: "A identidade clara e calma da Helo, com contraste corrigido.",
    swatches: { bg: "#f2f1ed", surface: "#fdfdfb", text: "#141414", textSoft: "#5b5a53", accent: "#141414" },
  },
  {
    id: "alto-contraste",
    label: "Alto Contraste",
    description: "Legibilidade máxima: textos, bordas e foco reforçados.",
    swatches: { bg: "#ffffff", surface: "#ffffff", text: "#000000", textSoft: "#1a1a1a", accent: "#000000" },
  },
  {
    id: "suave",
    label: "Suave",
    description: "Claro e acolhedor, sem abrir mão da legibilidade.",
    swatches: { bg: "#f4f2ef", surface: "#fbfaf8", text: "#2b2a27", textSoft: "#5f5d56", accent: "#3a3833" },
  },
  {
    id: "quente",
    label: "Quente",
    description: "Creme, pêssego e laranja suave — tons acolhedores.",
    swatches: { bg: "#fbf3ea", surface: "#fffaf3", text: "#33261d", textSoft: "#6b503f", accent: "#b04e2c" },
  },
  {
    id: "frio",
    label: "Frio",
    description: "Azul, lilás e cinza azulado — tons serenos.",
    swatches: { bg: "#eef1f6", surface: "#f9fbfe", text: "#1e2530", textSoft: "#47505f", accent: "#3d5c8c" },
  },
  {
    id: "escuro",
    label: "Escuro",
    description: "Modo escuro completo, com orbes ainda equilibrados.",
    swatches: { bg: "#17171a", surface: "#212127", text: "#ededec", textSoft: "#b8b7b1", accent: "#8ab4ff" },
  },
];

const DEFAULT_THEME: ThemeId = "helo-original";

function readFontScales(value: string | undefined): FontScales {
  try {
    return (sanitizeFontScales(JSON.parse(value ?? "{}")) ?? {}) as FontScales;
  } catch {
    return {};
  }
}

/** A única mutação visual global: tokens CSS e escala do paciente ativo. */
function applyTheme(id: ThemeId, scales: FontScales): void {
  document.documentElement.dataset.theme = id;
  const scale = scales[id];
  document.documentElement.style.fontSize =
    typeof scale === "number" && scale > FONT_SCALE_MIN
      ? `${Math.round(scale * 100)}%`
      : "";
}

type ThemeContextValue = {
  theme: ThemeId;
  setTheme: (id: ThemeId) => Promise<boolean>;
  themes: ThemeMeta[];
  fontScales: FontScales;
  setFontScale: (id: ThemeId, scale: number) => Promise<boolean>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { patientId, settings, saveSettings } = usePatient();
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);
  const [fontScales, setFontScalesState] = useState<FontScales>({});
  const patientIdRef = useRef<number | null>(patientId);
  const themeRef = useRef<ThemeId>(DEFAULT_THEME);
  const scalesRef = useRef<FontScales>({});

  useEffect(() => {
    patientIdRef.current = patientId;
    const storedTheme = settings[PATIENT_SETTING_KEYS.appearanceTheme];
    const nextTheme: ThemeId = isThemeId(storedTheme)
      ? storedTheme
      : DEFAULT_THEME;
    const nextScales = readFontScales(settings[PATIENT_SETTING_KEYS.appearanceFontScales]);
    themeRef.current = nextTheme;
    scalesRef.current = nextScales;
    // O estado React precisa acompanhar a troca externa do paciente para que
    // os controles reflitam a aparência já aplicada no DOM.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThemeState(nextTheme);
    setFontScalesState(nextScales);
    applyTheme(nextTheme, nextScales);
  }, [patientId, settings]);

  const setTheme = useCallback(
    async (id: ThemeId): Promise<boolean> => {
      if (!isThemeId(id)) return false;
      // Sem paciente ativo (ex.: tela de login): a troca é imediata e apenas
      // visual — nada é persistido, e a preferência do paciente volta a
      // mandar assim que houver um ativo (efeito de settings acima).
      if (patientId == null) {
        themeRef.current = id;
        setThemeState(id);
        applyTheme(id, scalesRef.current);
        return true;
      }
      const targetPatientId = patientId;
      const previousTheme = themeRef.current;
      const previousScales = scalesRef.current;
      themeRef.current = id;
      setThemeState(id);
      applyTheme(id, previousScales);
      const ok = await saveSettings({ [PATIENT_SETTING_KEYS.appearanceTheme]: id });
      if (!ok && patientIdRef.current === targetPatientId) {
        themeRef.current = previousTheme;
        setThemeState(previousTheme);
        applyTheme(previousTheme, previousScales);
      }
      return ok;
    },
    [patientId, saveSettings]
  );

  const setFontScale = useCallback(
    async (id: ThemeId, scale: number): Promise<boolean> => {
      if (!isThemeId(id) || !Number.isFinite(scale) || patientId == null) return false;
      const targetPatientId = patientId;
      const previousScales = scalesRef.current;
      const nextScales = { ...previousScales };
      const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale));
      if (clamped > FONT_SCALE_MIN) nextScales[id] = Math.round(clamped * 100) / 100;
      else delete nextScales[id];
      scalesRef.current = nextScales;
      setFontScalesState(nextScales);
      applyTheme(themeRef.current, nextScales);
      const ok = await saveSettings({
        [PATIENT_SETTING_KEYS.appearanceFontScales]: JSON.stringify(nextScales),
      });
      if (!ok && patientIdRef.current === targetPatientId) {
        scalesRef.current = previousScales;
        setFontScalesState(previousScales);
        applyTheme(themeRef.current, previousScales);
      }
      return ok;
    },
    [patientId, saveSettings]
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, themes: THEMES, fontScales, setFontScale }),
    [theme, setTheme, fontScales, setFontScale]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme precisa estar dentro de <ThemeProvider>");
  return ctx;
}

// Antes da hidratação não existe um paciente confiável no cliente. Aplicar o
// padrão seguro evita que a aparência de um paciente anterior apareça por um
// instante; o ThemeProvider troca para a configuração do paciente ativo.
export const THEME_INIT_SCRIPT = `(function(){document.documentElement.dataset.theme='${DEFAULT_THEME}';document.documentElement.style.fontSize='';})();`;
