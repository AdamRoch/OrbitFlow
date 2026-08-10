import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SpaceBackground } from "@/components/space-background";
import { SiteNav } from "@/components/site-nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OrbitFactory",
  description:
    "Build, run, and observe configurable AI agent workflows with OrbitFlow.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="relative min-h-full">
        <SpaceBackground />
        <SiteNav />
        <main className="relative z-10 mx-auto w-full max-w-5xl px-4 pt-24 pb-16">
          {children}
        </main>
      </body>
    </html>
  );
}
