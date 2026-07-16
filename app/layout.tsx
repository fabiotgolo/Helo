import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { PatientProvider } from "@/lib/patient";
import { HeloProvider } from "@/lib/helo-state";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/theme";

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
    <html
      lang="pt-BR"
      className={`${inter.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* Anti-flash: aplica o tema salvo antes da primeira pintura. Precisa
            ser o primeiro nó do body e rodar de forma síncrona. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <PatientProvider>
          <ThemeProvider>
            <HeloProvider>{children}</HeloProvider>
          </ThemeProvider>
        </PatientProvider>
      </body>
    </html>
  );
}
