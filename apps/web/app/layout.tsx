import type { ReactNode } from "react";
import { SITE } from "../lib/site";
import "./globals.css";

export const metadata = {
  title: SITE.productName,
  description: "Answers missed calls for local home services businesses by text, and books estimates on the owner's calendar.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
