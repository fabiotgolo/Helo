"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { OrbPalette } from "./ui";
import { ORB_VERTEX, ORB_FRAGMENT, makeOrbUniforms } from "./orb-shader";

// ——— Orbe 3D isolado: uma esfera, um canvas. Usado pelo Orb decorativo
// com `breathe`. O palco dos três modos (OrbStage) tem cena própria. ———

export default function Orb3D({ palette }: { palette: OrbPalette }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      return; // sem WebGL, o gradiente CSS por baixo permanece visível
    }

    // Cores cruas em sRGB, iguais às do CSS — sem conversão de color management
    THREE.ColorManagement.enabled = false;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
    camera.position.z = 2.58; // esfera de raio 1 preenche o quadro quase por completo

    const material = new THREE.ShaderMaterial({
      vertexShader: ORB_VERTEX,
      fragmentShader: ORB_FRAGMENT,
      uniforms: makeOrbUniforms(palette),
    });
    const geometry = new THREE.SphereGeometry(1, 96, 96);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const resize = () => {
      const size = canvas.parentElement?.clientWidth ?? 128;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(size, size, false);
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let raf = 0;
    const renderFrame = () => {
      material.uniforms.uTime.value = (performance.now() - start) / 1000;
      renderer.render(scene, camera);
      if (!reducedMotion) raf = requestAnimationFrame(renderFrame);
    };
    renderFrame();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [palette]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 h-full w-full rounded-full"
    />
  );
}
