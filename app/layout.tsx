import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { PatientProvider } from "@/lib/patient";
import { HeloProvider } from "@/lib/helo-state";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Helo — o elo entre sentir e dizer",
  description:
    "Comunicação assistiva com respeito, cuidado e consentimento. O paciente escolhe, o Helo dá voz.",
};

// viewportFit cover + env(safe-area-inset-*) — telas com notch
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <PatientProvider>
          <HeloProvider>{children}</HeloProvider>
        </PatientProvider>
      </body>
    </html>
  );
}
