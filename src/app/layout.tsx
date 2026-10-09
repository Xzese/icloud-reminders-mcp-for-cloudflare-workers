import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "iCloud Reminders",
  description: "Private workspace for your iCloud Reminders connection.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
