import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ледовый штаб — фэнтези КХЛ",
  description: "Расчёт состава и оптимальных замен в фэнтези КХЛ по правилам Sports.ru.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="x-body antialiased">{children}</body>
    </html>
  );
}
