import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { PatientProvider } from "@/lib/patient";
import { HeloProvider } from "@/lib/helo-state";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/theme";
import { HeloAgentProvider } from "@/components/helo-agent-provider";

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
      {/* suppressHydrationWarning: extensões do navegador (antivírus,
          gerenciadores de senha) injetam atributos no <body> antes da
          hidratação — só silencia atributos deste nó, não erros reais. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {/* Anti-flash: aplica o tema salvo antes da primeira pintura. Precisa
            ser o primeiro nó do body e rodar de forma síncrona. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <PatientProvider>
          <ThemeProvider>
            <HeloProvider>
              <HeloAgentProvider>{children}</HeloAgentProvider>
            </HeloProvider>
          </ThemeProvider>
        </PatientProvider>
      </body>
    </html>
  );
}
