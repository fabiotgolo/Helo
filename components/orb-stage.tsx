"use client";

// ——— OrbStage: palco persistente dos três modos do Helo ———
// Um único canvas WebGL com as três esferas na mesma cena (contextos WebGL
// são recurso escasso). O orbe do modo ativo fica no centro, maior; os
// inativos ficam menores — nas laterais (desktop/tablet) ou abaixo (mobile).
// Trocar de modo interpola posição, escala e profundidade — nada remonta.
//
// Acessibilidade: o canvas é decorativo (aria-hidden); a interação real são
// três <button> circulares sobrepostos aos orbes, operáveis por mouse,
// teclado e toque, que acompanham o layout com transições CSS.

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useHelo, HELO_MODES, MODE_ORDER, type HeloMode } from "@/lib/helo-state";
import { Orb } from "@/components/ui";
import { ORB_VERTEX, ORB_FRAGMENT, makeOrbUniforms } from "@/components/orb-shader";

type Rect = { x: number; y: number; d: number };
type Layout = Record<HeloMode, Rect>;

/**
 * Variantes do palco:
 *   aberto   — home: trio protagonista, orbes são botões de entrada.
 *   compacto — experiência aberta: trio pequeno no topo, conteúdo abaixo.
 *   imersivo — experiência aberta: o ativo permanece GRANDE e central,
 *              presença viva atrás do overlay translúcido de conteúdo.
 */
export type StageVariant = "aberto" | "compacto" | "imersivo";

// Composição própria por formato — mobile não é desktop encolhido:
//   ≥640px (sm):  [ menor ]  [ MAIOR ]  [ menor ]  ( [ menor ] … )
//   <640px:            [ MAIOR ]
//                 [ menor ]  [ menor ]  ( [ menor ] … )
// Compacto (experiência aberta): fila horizontal pequena, o ativo segue
// protagonista e todos permanecem visíveis e clicáveis sobre o overlay.
//
// Os inativos ocupam "slots" simétricos a partir do centro: ±1 reproduz
// exatamente o trio original; modos adicionais entram em ±2 — o palco
// aceita novos modos sem redesenhar a coreografia.
const SLOTS = [-1, 1, -2, 2];

/** Deslocamento horizontal do slot: meio do grande + k orbes pequenos + k folgas. */
function slotX(
  center: number,
  slot: number,
  big: number,
  small: number,
  gap: number
): number {
  const k = Math.abs(slot);
  return center + Math.sign(slot) * (big / 2 + small * (k - 0.5) + gap * k);
}

function clampX(x: number, d: number, w: number): number {
  return Math.min(Math.max(x, d / 2 + 12), w - d / 2 - 12);
}

/**
 * Distribui os orbes recolhidos numa FILA horizontal única, centralizada em
 * `cx`, com espaçamento IGUAL entre vizinhos e mesmo tamanho — o conjunto
 * fica simétrico, sem "buraco" no meio (diferente dos slots ±k, que cercam o
 * orbe ativo). Se a fila não couber, a folga encolhe por igual: nada é
 * cortado nem desalinhado. Todos ficam na mesma linha `y`.
 */
function rowLayout(
  lay: Layout,
  modes: HeloMode[],
  cx: number,
  y: number,
  d: number,
  gap: number,
  w: number
): void {
  const n = modes.length;
  if (n === 0) return;
  const maxRow = w - d - 24; // 12px de respiro em cada borda
  const g = n > 1 ? Math.min(gap, Math.max(8, (maxRow - n * d) / (n - 1))) : gap;
  const rowW = n * d + (n - 1) * g;
  const startX = cx - rowW / 2 + d / 2;
  modes.forEach((m, i) => {
    lay[m] = { x: startX + i * (d + g), y, d };
  });
}

function computeLayout(w: number, h: number, active: HeloMode, variant: StageVariant): Layout {
  const inactive = MODE_ORDER.filter((m) => m !== active);
  const mobile = w < 640;
  const lay = {} as Layout;

  if (variant === "imersivo") {
    // O ativo ocupa o centro do palco, atrás do overlay de conteúdo; os
    // inativos repousam pequenos no topo, ainda alcançáveis para trocar
    // de experiência sem fechar nada.
    // Orbe ativo GRANDE — do mesmo tamanho da Orb da tela deslogada (login:
    // 88vmin, teto 44rem/704px). Presença viva que transborda acima e abaixo
    // do painel, com o modal centralizado sobre ela.
    const D = Math.min(Math.min(w, h) * 0.88, 704);
    const d = mobile ? 52 : 68;
    const y = mobile ? 44 : 54;
    const gap = mobile ? 32 : 44;
    // Centro deslocado levemente abaixo do meio: o painel de conteúdo é
    // centrado verticalmente numa área com respiro de topo (pt-20/24), então
    // ~0.52h alinha o centro da Orb ao centro do modal.
    lay[active] = { x: w * 0.5, y: h * 0.52, d: D };
    // Recolhidos: fila única, centralizada e com espaçamento igual — não
    // cercam o ativo (que fica grande e central, atrás do conteúdo).
    rowLayout(lay, inactive, w * 0.5, y, d, gap, w);
    return lay;
  }

  if (variant === "compacto") {
    const D = Math.min(h * 0.72, mobile ? 112 : 150);
    const d = D * 0.45;
    const gap = mobile ? 18 : 28;
    lay[active] = { x: w * 0.5, y: h * 0.5, d: D };
    inactive.forEach((m, i) => {
      lay[m] = {
        x: clampX(slotX(w * 0.5, SLOTS[i], D, d, gap), d, w),
        y: h * 0.56,
        d,
      };
    });
    return lay;
  }

  if (mobile) {
    // Home mobile (referência visual): o orbe ativo é o protagonista absoluto
    // — quase a largura da tela — com "Conversar / Toque para falar" logo
    // abaixo; os demais modos formam a fila de acesso rápido na base, acima
    // do menu inferior. O palco recebe a altura útil inteira do layout.
    const D = Math.min(w * 0.82, h * 0.52, 400);
    const n = inactive.length;
    const d = Math.min(D * 0.28, w / (n + 1) - 14);
    lay[active] = { x: w * 0.5, y: h * 0.38, d: D };
    inactive.forEach((m, i) => {
      lay[m] = { x: (w * (i + 1)) / (n + 1), y: h * 0.84, d };
    });
    return lay;
  }

  // Composição da referência visual (Fase 10): central grande ao centro,
  // laterais menores quase na mesma linha, muito espaço negativo.
  const D = Math.min(w * 0.34, h * 0.72, 340);
  const d = D * 0.48;
  const gap = Math.max(28, w * 0.03);
  lay[active] = { x: w * 0.5, y: h * 0.46, d: D };
  inactive.forEach((m, i) => {
    lay[m] = {
      x: clampX(slotX(w * 0.5, SLOTS[i], D, d, gap), d, w),
      y: h * 0.55,
      d,
    };
  });
  return lay;
}

export default function OrbStage({
  className = "",
  variant = "aberto",
}: {
  className?: string;
  /** Composição do palco — ver StageVariant. */
  variant?: StageVariant;
}) {
  const { activeMode, setActiveMode, enterMode, modes, getAmplitude } = useHelo();

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Este componente só monta no cliente (dynamic ssr:false) — detecção direta
  const [webglOk] = useState(() => {
    try {
      const probe = document.createElement("canvas");
      return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
    } catch {
      return false;
    }
  });

  // Refs lidas pelo loop de animação (nunca estado React, para não re-renderizar)
  const layoutRef = useRef<Layout | null>(null);
  const activeRef = useRef<HeloMode>(activeMode);
  const amplitudeRef = useRef(getAmplitude);
  const meshesRef = useRef<Record<HeloMode, THREE.Mesh> | null>(null);

  const layout = size ? computeLayout(size.w, size.h, activeMode, variant) : null;

  // Botões viajam com transição apenas quando o MODO troca (a coreografia).
  // Montagem e mudanças de TAMANHO (resize, medição tardia do contêiner)
  // reposicionam na hora — como o `placed` dos meshes — sem deslize fantasma.
  const sizeKey = size ? `${size.w}x${size.h}` : "";
  const [stableSize, setStableSize] = useState("");
  useEffect(() => {
    if (!sizeKey) return;
    const raf = requestAnimationFrame(() => setStableSize(sizeKey));
    return () => cancelAnimationFrame(raf);
  }, [sizeKey]);
  const travel =
    stableSize === sizeKey
      ? "transition-all duration-700 ease-out motion-reduce:transition-none"
      : "transition-none";

  // Espelha os valores do render nas refs do loop — após cada render
  useEffect(() => {
    activeRef.current = activeMode;
    amplitudeRef.current = getAmplitude;
    layoutRef.current = layout;
  });

  // Medição do contêiner — dirige o canvas e os botões com a mesma geometria
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Cena Three.js — montada uma única vez; posições/escala animam por lerp
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !webglOk) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      return; // detecção acima já cobre; sem renderer, o canvas fica vazio
    }
    THREE.ColorManagement.enabled = false;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 400);
    const geometry = new THREE.SphereGeometry(0.5, 96, 96);

    const meshes = {} as Record<HeloMode, THREE.Mesh>;
    for (const mode of MODE_ORDER) {
      const material = new THREE.ShaderMaterial({
        vertexShader: ORB_VERTEX,
        fragmentShader: ORB_FRAGMENT,
        uniforms: makeOrbUniforms(HELO_MODES[mode].palette),
        transparent: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      // Fases de tempo distintas — cada orbe flui diferente, como três presenças
      mesh.userData.timeOffset = mode.length * 37.7;
      scene.add(mesh);
      meshes[mode] = mesh;
    }
    meshesRef.current = meshes;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let last = start;
    let raf = 0;
    let smoothAmp = 0;
    let placed = false;

    // ——— Coreografia da troca (Fase 10) ———
    // Quando um orbe lateral assume o centro, ele e o antigo protagonista
    // percorrem o MESMO segmento em sentidos opostos — sem correção, eles se
    // atravessam no meio do caminho. A troca ganha:
    //   1. um arco vertical suave e oposto (o que chega passa por cima,
    //      o que sai mergulha de leve) — eles se contornam, não se cruzam;
    //   2. profundidade resolvida mais rápido que a posição — o que chega
    //      fica à frente desde o início da viagem.
    const SWAP_MS = 850;
    let swapStart = -1;
    let swapIn: HeloMode | null = null;
    let swapOut: HeloMode | null = null;
    let prevActive: HeloMode = activeRef.current;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      const lay = layoutRef.current;
      if (!lay) return;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== w * Math.min(devicePixelRatio, 2)) {
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        renderer.setSize(w, h, false);
      }
      camera.left = -w / 2;
      camera.right = w / 2;
      camera.top = h / 2;
      camera.bottom = -h / 2;
      camera.updateProjectionMatrix();

      // Suavização exponencial — calma, sem molas nem exageros
      const f = reducedMotion || !placed ? 1 : 1 - Math.exp(-4.5 * dt);
      const t = reducedMotion ? 12 : (now - start) / 1000;

      const rawAmp = amplitudeRef.current();
      smoothAmp += (rawAmp - smoothAmp) * 0.18;

      // Detecta a troca de protagonista e arma a coreografia do par.
      // A profundidade é cravada NA HORA: com câmera ortográfica, z não
      // muda a aparência — só a ordem de desenho — então o salto é
      // invisível e quem chega cobre quem sai desde o primeiro frame.
      if (activeRef.current !== prevActive) {
        swapIn = activeRef.current;
        swapOut = prevActive;
        swapStart = now;
        prevActive = activeRef.current;
        meshes[swapIn].position.z = 60;
        meshes[swapOut].position.z = -60;
      }
      // Progresso do arco: 0→1 em SWAP_MS; sin(π·p) sobe e volta a zero,
      // então o desvio nunca deixa resíduo na posição final.
      const swapP =
        swapStart >= 0 ? Math.min(1, (now - swapStart) / SWAP_MS) : 1;
      const arc =
        reducedMotion || !placed || swapP >= 1
          ? 0
          : Math.sin(Math.PI * swapP) * Math.min(48, h * 0.09);

      for (const mode of MODE_ORDER) {
        const mesh = meshes[mode];
        const material = mesh.material as THREE.ShaderMaterial;
        const target = lay[mode];
        const isActive = mode === activeRef.current;
        // Tela (y para baixo) → mundo (y para cima); ativo à frente
        const tx = target.x - w / 2;
        // O que chega ao centro arqueia por cima; o que sai mergulha de leve
        const arcY = mode === swapIn ? arc : mode === swapOut ? -arc * 0.6 : 0;
        const ty = h / 2 - target.y + arcY;
        const tz = isActive ? 60 : -60;
        mesh.position.x += (tx - mesh.position.x) * f;
        mesh.position.y += (ty - mesh.position.y) * f;
        // Profundidade converge ~3× mais rápido que a posição: quem chega
        // assume a frente logo no início — nunca há interseção ambígua.
        const fz = reducedMotion || !placed ? 1 : 1 - Math.exp(-14 * dt);
        mesh.position.z += (tz - mesh.position.z) * fz;
        const s = mesh.scale.x + (target.d - mesh.scale.x) * f;
        mesh.scale.setScalar(s);
        material.uniforms.uTime.value = t + (mesh.userData.timeOffset as number);
        material.uniforms.uAudio.value = isActive ? (reducedMotion ? 0 : smoothAmp) : 0;
        // Inativos repousam: levemente esmaecidos em direção ao fundo
        const dimTarget = isActive ? 0 : 0.3;
        const u = material.uniforms.uDim;
        u.value += (dimTarget - u.value) * f;
      }
      placed = true;
      renderer.render(scene, camera);
    };
    frame();

    // Aba oculta: nada anima, nada gasta
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        frame();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      geometry.dispose();
      for (const mode of MODE_ORDER) (meshes[mode].material as THREE.Material).dispose();
      renderer.dispose();
      meshesRef.current = null;
    };
  }, [webglOk]);

  const onOrbClick = useCallback(
    (mode: HeloMode) => {
      if (variant !== "aberto") {
        // Overlay aberto: trocar de modo troca a experiência, sem fechar nada
        if (mode !== activeMode) enterMode(mode);
      } else if (mode === activeMode || mode === "emergencia" || mode === "helo") {
        // Entrar na experiência do orbe central. Emergência abre com UM
        // toque mesmo da lateral: o orbe vai ao centro e as ações aparecem
        // juntas. O Helo também abre sua interface contextual no primeiro
        // toque, mas só pede o microfone após o CTA explícito do usuário.
        enterMode(mode);
      } else {
        setActiveMode(mode); // trazer o orbe ao centro, ainda na home
      }
    },
    [variant, activeMode, setActiveMode, enterMode]
  );

  return (
    <div
      ref={containerRef}
      // Posicionamento (relative/absolute) vem de quem monta o palco
      className={`w-full ${className}`}
      role="group"
      aria-label={`Modos do Helo: ${MODE_ORDER.map((m) => HELO_MODES[m].title).join(", ")}`}
    >
      {/* Fallback sem WebGL: os mesmos orbes, em gradiente CSS */}
      {!webglOk && layout && (
        <div aria-hidden="true" className="absolute inset-0">
          {MODE_ORDER.map((mode) => {
            const r = layout[mode];
            return (
              <div
                key={mode}
                className={`absolute ${travel}`}
                style={{
                  left: r.x - r.d / 2,
                  top: r.y - r.d / 2,
                  width: r.d,
                  height: r.d,
                  // O protagonista cobre o par durante a viagem — mesmo sem
                  // WebGL a troca nunca mostra sobreposição invertida.
                  zIndex: mode === activeMode ? 2 : 1,
                }}
              >
                <Orb palette={modes[mode].palette} className="h-full w-full" />
              </div>
            );
          })}
        </div>
      )}

      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {/* Botões reais sobre os orbes — mouse, teclado e toque */}
      {layout &&
        MODE_ORDER.map((mode) => {
          const r = layout[mode];
          const info = modes[mode];
          const isActive = mode === activeMode;
          const idle = variant !== "aberto" && isActive; // presença, não botão — nada a acionar
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onOrbClick(mode)}
              disabled={idle}
              aria-pressed={isActive}
              aria-label={
                idle
                  ? `${info.title} — modo ativo`
                  : isActive
                    ? `${info.title} — modo ativo. Entrar`
                    : variant !== "aberto"
                      ? `Mudar para ${info.title}`
                      : `Ativar modo ${info.title}`
              }
              className={`absolute rounded-full ${travel}
                focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-4`}
              style={{ left: r.x - r.d / 2, top: r.y - r.d / 2, width: r.d, height: r.d }}
            >
              <span
                className={`pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-center font-medium tracking-tight transition-all duration-500 motion-reduce:transition-none ${
                  variant === "aberto"
                    ? isActive
                      ? "text-2xl text-ink sm:text-2xl"
                      : // Fila da Home mobile: os nomes dividem a largura da
                        // tela em N fatias (~75px em 375px), então o rótulo
                        // é dimensionado em px FIXOS para caber na fatia —
                        // em rem ele acompanharia a escala de fonte do
                        // paciente (130% já colide) e os nomes se encavalam.
                        // O desktop tem folga de sobra e mantém text-sm.
                        "text-[11px] text-ink-soft sm:text-sm"
                    : isActive
                      ? // presença central (atrás do conteúdo): sem rótulo visível
                        "sr-only"
                      : // recolhido: nome logo abaixo, pequeno e discreto
                        "text-[11px] text-ink-mute sm:text-xs"
                }`}
              >
                {info.title}
                {variant === "aberto" && isActive && (
                  // Convite ao toque da referência mobile — o desktop mantém
                  // a descrição e o CTA da página da Home.
                  <span className="mt-1 block text-base font-normal text-ink-soft sm:hidden">
                    Toque para falar
                  </span>
                )}
              </span>
            </button>
          );
        })}
    </div>
  );
}
