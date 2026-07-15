import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Permite um dev server paralelo (ex.: preview de outra sessão) sem brigar
  // pelo lock em .next/dev — cada instância aponta seu próprio distDir.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    // Há um segundo package-lock.json em ../ e o Next inferiria a raiz lá —
    // fazendo o Tailwind escanear os PDFs/PPTX da pasta pai e gerar CSS
    // corrompido. A raiz do app é ESTA pasta.
    root: __dirname,
  },
};

export default nextConfig;
