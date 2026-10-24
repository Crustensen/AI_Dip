import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Виртуальный дипломат — тренажёр переговоров',
  description: 'Безопасный учебный тренажёр международных переговоров.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
