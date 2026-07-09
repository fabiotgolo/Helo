import * as THREE from "three";
import type { OrbPalette } from "./ui";

// ——— Shader do orbe Helo: ruído fluido inspirado no orbe da ElevenLabs ———
// Compartilhado entre o Orb3D isolado e o OrbStage (palco dos três modos).
// Cores em sRGB cru (sem color management) para bater com as paletas CSS.

export const PALETTE_COLORS: Record<OrbPalette, [string, string, string, string]> = {
  coral: ["#c3cdea", "#f6c1cd", "#ef4b52", "#f89b4b"],
  lilas: ["#b7aede", "#7f78ce", "#f4b98a", "#ecd4c0"],
  oliva: ["#a9c3e2", "#b6c79a", "#6f7d3f", "#e79a4e"],
  rosa: ["#fbe3e0", "#f9ded9", "#f6c9c2", "#f3c4bd"],
  ambar: ["#f7dcb4", "#f2c48d", "#e0803f", "#e89a55"],
  ceu: ["#dbe7f5", "#c4d7ee", "#8fb2dd", "#9dbde4"],
};

export function hexToVec3(hex: string): THREE.Vector3 {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Simplex noise 3D (Ashima Arts / Stefan Gustavson, MIT)
const SNOISE = /* glsl */ `
  vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 1.0/7.0;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }
`;

export const ORB_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uAudio;
  varying vec3 vNormal;
  varying vec3 vPos;
  ${SNOISE}
  void main() {
    float wobble = snoise(normal * 1.6 + vec3(0.0, uTime * 0.18, 0.0));
    // A voz da Helo amplia a ondulação — o orbe "fala" junto com o áudio.
    // Deslocamento proporcional ao raio: mesma forma em qualquer escala.
    float amp = 0.035 + uAudio * 0.05;
    vec3 displaced = position * (1.0 + wobble * amp);
    vNormal = normalMatrix * normal;
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

export const ORB_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAudio;
  uniform float uDim;
  uniform float uOpacity;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform vec3 uColorD;
  varying vec3 vNormal;
  varying vec3 vPos;
  ${SNOISE}
  void main() {
    vec3 p = normalize(vPos);
    float t = uTime * 0.1;

    // Oitava única em frequência baixa: manchas gigantes e difusas, sem granulado
    float warp = snoise(p * 0.7 + vec3(0.0, -t * 0.5, t * 0.3));
    float n1 = 0.5 + 0.5 * snoise(p * 0.9 + warp * 0.6 + vec3(t, 0.0, -t * 0.4));
    float n2 = 0.5 + 0.5 * snoise(p * 1.1 - warp * 0.5 + vec3(-t * 0.7, t * 0.5, 0.0));

    // Transições largas — faixas de cor difusas, como aquarela
    vec3 col = mix(uColorA, uColorB, smoothstep(0.05, 0.95, n1));
    col = mix(col, uColorC, smoothstep(0.25, 1.0, n2) * 0.8);
    col = mix(col, uColorD, smoothstep(0.4, 1.0, n1 * n2 * 2.2) * 0.65);

    // Véu leitoso em regiões amplas — aspecto de vidro fosco da ElevenLabs
    float milk = 0.5 + 0.5 * snoise(p * 0.8 - warp * 0.4 + vec3(t * 0.3, -t * 0.2, 0.0));
    col = mix(col, vec3(0.99, 0.97, 0.96), smoothstep(0.4, 1.0, milk) * 0.6);

    // Luz suave vinda de cima/esquerda
    vec3 nrm = normalize(vNormal);
    float light = clamp(dot(nrm, normalize(vec3(-0.4, 0.85, 0.55))), 0.0, 1.0);
    col += vec3(0.16) * pow(light, 2.0);

    // Borda leitosa (fresnel) — aspecto translúcido do orbe
    float fresnel = pow(1.0 - abs(dot(nrm, vec3(0.0, 0.0, 1.0))), 2.2);
    col = mix(col, vec3(1.0), fresnel * 0.38);

    // Voz clareia sutilmente; orbes inativos se aproximam do fundo (repouso)
    col += vec3(0.08) * uAudio;
    col = mix(col, vec3(0.949, 0.945, 0.929), uDim);

    gl_FragColor = vec4(col, uOpacity);
  }
`;

export function makeOrbUniforms(palette: OrbPalette) {
  const [a, b, c, d] = PALETTE_COLORS[palette];
  return {
    uTime: { value: 0 },
    uAudio: { value: 0 },
    uDim: { value: 0 },
    uOpacity: { value: 1 },
    uColorA: { value: hexToVec3(a) },
    uColorB: { value: hexToVec3(b) },
    uColorC: { value: hexToVec3(c) },
    uColorD: { value: hexToVec3(d) },
  };
}
