"use client";

// ——— Tema visual da Helo: pertence ao USUÁRIO, não ao paciente ———
// A troca é PURAMENTE visual: reescreve os tokens de cor (data-theme no
// <html>) e a escala de fonte (font-size do <html> — a interface inteira usa
// rem, então tudo acompanha). Não remonta orbe, não toca em voz, sessão,
// paciente ou atividade.
//
// Persistência:
//   • autenticado → servidor (user.themePreference + user.themeFontScales) e
//     espelho local por userId;
//   • anônimo     → localStorage (chaves próprias, fora dos "helo." limpos no
//     logout — assim as preferências voltam no próximo acesso).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import {
  THEME_IDS,
  isThemeId,
  sanitizeFontScales,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  type ThemeId,
} from "@/lib/access-types";

export type { ThemeId };
export { FONT_SCALE_MIN, FONT_SCALE_MAX };

/** Escala de fonte por tema (1 = padrão). Ausente = padrão. */
export type FontScales = Partial<Record<ThemeId, number>>;

// Metadados de apresentação dos temas (rótulo, descrição e AMOSTRAS de cor
// para a prévia dos cards). As amostras espelham os tokens do globals.css —
// são só para o preview; a fonte da verdade do tema aplicado é o CSS.
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

// Chaves de armazenamento — prefixo "helo-theme" (com hífen) NÃO começa com
// "helo." e por isso sobrevive ao clearLocalMirrors do logout: as preferências
// voltam no próximo acesso. Por usuário, para nunca vazar entre contas.
const LAST_KEY = "helo-theme:last"; // usado pelo script anti-flash no <head>
const ANON_KEY = "helo-theme:anon";
const userKey = (userId: string) => `helo-theme:user:${userId}`;
const SCALES_LAST_KEY = "helo-theme:scales-last"; // idem, para o anti-flash
const SCALES_ANON_KEY = "helo-theme:scales-anon";
const scalesUserKey = (userId: string) => `helo-theme:scales-user:${userId}`;
// Escolha de tema feita EXPLICITAMENTE enquanto ANÔNIMO, aguardando o 1º
// login para ser gravada no perfil. Regra central: autenticar não pode apagar
// nem sobrescrever a escolha visual feita antes do login. Sobrevive ao logout
// (prefixo "helo-theme"); é CONSUMIDA (apagada) na primeira autenticação, para
// nunca vazar de um usuário para outro no mesmo dispositivo.
const PENDING_KEY = "helo-theme:pending";

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* armazenamento indisponível — segue só em memória */
  }
}
function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* armazenamento indisponível — nada a limpar */
  }
}

function readScales(key: string): FontScales {
  try {
    const parsed: unknown = JSON.parse(safeGet(key) ?? "{}");
    return (sanitizeFontScales(parsed) ?? {}) as FontScales;
  } catch {
    return {};
  }
}

/** Aplica tema + escala de fonte no DOM — a única mutação visual do sistema. */
function applyTheme(id: ThemeId, scales: FontScales): void {
  document.documentElement.dataset.theme = id;
  const s = scales[id];
  // "" remove o override (volta a 100%). A interface usa rem, então o
  // font-size do <html> escala tudo proporcionalmente.
  document.documentElement.style.fontSize =
    typeof s === "number" && s > FONT_SCALE_MIN ? `${Math.round(s * 100)}%` : "";
}

type ThemeContextValue = {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
  themes: ThemeMeta[];
  /** Escala de fonte por tema (1 quando ausente). */
  fontScales: FontScales;
  setFontScale: (id: ThemeId, scale: number) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Estado inicial DETERMINÍSTICO (igual ao SSR) para não gerar mismatch de
  // hidratação no painel de seleção. O tema REAL aplicado no DOM já veio do
  // script anti-flash; aqui alinhamos o estado logo após montar (efeito abaixo).
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);
  const [fontScales, setFontScalesState] = useState<FontScales>({});
  const userIdRef = useRef<string | null>(null);
  // undefined = ainda não sincronizou nenhuma vez (força a 1ª aplicação).
  const syncedForId = useRef<string | null | undefined>(undefined);
  // Espelho síncrono das escalas — applyTheme dentro de callbacks não pode
  // depender de estado possivelmente desatualizado.
  const scalesRef = useRef<FontScales>({});
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pós-hidratação: alinha o estado ao que o anti-flash já aplicou no DOM,
  // sem esperar a resposta de /api/auth/me — assim a seleção do painel bate
  // com a interface imediatamente. É o padrão idiomático para evitar mismatch
  // de SSR em tema (o estado inicial precisa ser determinístico; só depois de
  // montar lemos o armazenamento local). Roda uma vez.
  useEffect(() => {
    const last = safeGet(LAST_KEY);
    const scales = readScales(SCALES_LAST_KEY);
    scalesRef.current = scales;
    if (isThemeId(last)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setThemeState(last);
    }
    setFontScalesState(scales);
  }, []);

  const persistLocal = useCallback((id: ThemeId, scales: FontScales) => {
    safeSet(LAST_KEY, id);
    safeSet(SCALES_LAST_KEY, JSON.stringify(scales));
    const uid = userIdRef.current;
    safeSet(uid ? userKey(uid) : ANON_KEY, id);
    safeSet(uid ? scalesUserKey(uid) : SCALES_ANON_KEY, JSON.stringify(scales));
  }, []);

  // Espelha no servidor (fire-and-forget — o local já valeu). O slider dispara
  // muitas mudanças por arrasto, então as escritas são adiadas (debounce).
  const pushToServer = useCallback((body: Record<string, unknown>, debounceMs = 0) => {
    if (!userIdRef.current) return;
    const send = () => {
      void fetch("/api/preferences/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {
        /* rede indisponível — a preferência local permanece válida */
      });
    };
    if (pushTimer.current) clearTimeout(pushTimer.current);
    if (debounceMs > 0) {
      pushTimer.current = setTimeout(send, debounceMs);
    } else {
      pushTimer.current = null;
      send();
    }
  }, []);

  const setTheme = useCallback(
    (id: ThemeId) => {
      if (!isThemeId(id)) return;
      setThemeState(id);
      applyTheme(id, scalesRef.current);
      persistLocal(id, scalesRef.current);
      // Escolha explícita ainda ANÔNIMO: marca como pendente para sobreviver ao
      // próximo login e virar a preferência do perfil — em vez de a preferência
      // remota (possivelmente antiga) sobrescrevê-la assim que autenticar.
      // Autenticado, o pushToServer já persiste no perfil; nada a marcar.
      if (!userIdRef.current) safeSet(PENDING_KEY, id);
      pushToServer({ theme: id, fontScales: scalesRef.current });
    },
    [persistLocal, pushToServer]
  );

  const themeRef = useRef(theme);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  const setFontScale = useCallback(
    (id: ThemeId, scale: number) => {
      if (!isThemeId(id) || !Number.isFinite(scale)) return;
      const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale));
      const next: FontScales = { ...scalesRef.current };
      if (clamped > FONT_SCALE_MIN) next[id] = Math.round(clamped * 100) / 100;
      else delete next[id];
      scalesRef.current = next;
      setFontScalesState(next);
      // Só re-aplica no DOM se a escala alterada é a do tema em uso.
      if (id === themeRef.current) applyTheme(id, next);
      persistLocal(themeRef.current, next);
      pushToServer({ fontScales: next }, 400);
    },
    [persistLocal, pushToServer]
  );

  // Descobre o usuário e carrega as preferências DELE (servidor > espelho
  // local). Se anônimo, usa as preferências anônimas. Nunca aplica as de outro.
  const syncFromAuth = useCallback(
    (signal?: AbortSignal) =>
      fetch("/api/auth/me", { signal })
        .then((r) => r.json())
        .then(
          (d: {
            user?: {
              id?: string;
              themePreference?: string | null;
              themeFontScales?: Record<string, number> | null;
            } | null;
          }) => {
            const user = d.user ?? null;
            const nextId = user?.id ?? null;
            // Já sincronizou para ESTA identidade? Evita reprocessar a cada
            // navegação. Mas SEMPRE aplica na 1ª sincronização (sentinela
            // undefined) e sempre que a identidade muda (login/logout) — assim
            // preferências nunca vazam de um usuário para outro.
            if (syncedForId.current !== undefined && nextId === syncedForId.current) {
              return;
            }
            syncedForId.current = nextId;
            let chosen: ThemeId;
            let scales: FontScales;
            if (user?.id) {
              userIdRef.current = user.id;
              // Regra central: uma escolha feita ANTES deste login não pode ser
              // apagada pela autenticação. Se há tema pendente (escolhido
              // anônimo), ele vence a preferência remota e passa a ser a
              // preferência do perfil — consumido aqui para não vazar entre
              // contas no mesmo dispositivo.
              const pending = safeGet(PENDING_KEY);
              if (isThemeId(pending)) {
                safeRemove(PENDING_KEY);
                chosen = pending;
                // Mantém as escalas de fonte atuais (do estado anônimo) e leva
                // tudo ao perfil, para os próximos acessos restaurarem o tema.
                scales = scalesRef.current;
                pushToServer({ theme: chosen, fontScales: scales });
              } else {
                const server = user.themePreference;
                const local = safeGet(userKey(user.id));
                chosen = isThemeId(server) ? server : isThemeId(local) ? local : DEFAULT_THEME;
                const serverScales = sanitizeFontScales(user.themeFontScales);
                scales = (serverScales ?? readScales(scalesUserKey(user.id))) as FontScales;
              }
            } else {
              userIdRef.current = null;
              const local = safeGet(ANON_KEY);
              chosen = isThemeId(local) ? local : DEFAULT_THEME;
              scales = readScales(SCALES_ANON_KEY);
            }
            scalesRef.current = scales;
            setThemeState(chosen);
            setFontScalesState(scales);
            applyTheme(chosen, scales);
            persistLocal(chosen, scales);
          }
        )
        .catch(() => {
          /* sem sessão legível — mantém o que o anti-flash aplicou */
        }),
    [persistLocal, pushToServer]
  );

  // Re-sincroniza quando a IDENTIDADE pode ter mudado: no mount e a cada
  // navegação (login e logout usam router.replace — troca de rota, sem reload).
  // Assim, ao entrar, as preferências salvas do usuário voltam sem recarregar.
  const pathname = usePathname();
  useEffect(() => {
    const controller = new AbortController();
    void syncFromAuth(controller.signal);
    return () => controller.abort();
  }, [pathname, syncFromAuth]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, themes: THEMES, fontScales, setFontScale }),
    [theme, setTheme, fontScales, setFontScale]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme precisa estar dentro de <ThemeProvider>");
  }
  return ctx;
}

// Script inline (anti-flash) injetado no início do <body>: aplica o último
// tema E a escala de fonte dele ANTES da primeira pintura. Sem dependências —
// roda durante o parse do HTML. Um "sistema" legado guardado no armazenamento
// não passa na lista de ids e cai no padrão.
export const THEME_INIT_SCRIPT = `(function(){try{var ids=${JSON.stringify(
  THEME_IDS
)};var t=localStorage.getItem('${LAST_KEY}');if(!t||ids.indexOf(t)<0){t='${DEFAULT_THEME}';}document.documentElement.dataset.theme=t;var sc={};try{sc=JSON.parse(localStorage.getItem('${SCALES_LAST_KEY}')||'{}')||{}}catch(e){}var s=sc[t];if(typeof s==='number'&&s>${FONT_SCALE_MIN}&&s<=${FONT_SCALE_MAX}){document.documentElement.style.fontSize=Math.round(s*100)+'%';}}catch(e){document.documentElement.dataset.theme='${DEFAULT_THEME}';}})();`;
