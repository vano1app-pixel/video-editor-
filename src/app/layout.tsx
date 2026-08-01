import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "EditAi — AI video editor",
  description: "Tell EditAi what you want and it edits your video.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-ink text-fg antialiased">{children}</body>
    </html>
  );
}
