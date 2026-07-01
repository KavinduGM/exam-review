import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Web Site Auditor",
  description: "Link registry, uptime monitoring, and AI page review for exam-prep sites.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
