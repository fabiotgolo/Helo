import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Permite um dev server paralelo (ex.: preview de outra sessão) sem brigar
  // pelo lock em .next/dev — cada instância aponta seu próprio distDir.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
