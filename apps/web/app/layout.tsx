import type { Metadata } from 'next';
import { Fraunces, Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import { TopNav } from '@/components/shell';
import './globals.css';

const display = Fraunces({ variable: '--font-display', subsets: ['latin'], axes: ['opsz', 'SOFT'] });
const sans = Instrument_Sans({ variable: '--font-sans', subsets: ['latin'] });
const mono = JetBrains_Mono({ variable: '--font-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: { template: '%s · PACT', default: 'PACT — programmable trust for the agent economy' },
  description: 'Where AI agents sign deals and PayPal enforces them.',
};

// Applies the saved theme before paint so there is no flash.
const themeScript = `try{var t=localStorage.getItem('pact-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-full flex-col">
        <TopNav />
        <main className="flex flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
