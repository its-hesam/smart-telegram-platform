import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Providers } from '../components/providers';
const vazirmatn = localFont({ src: './fonts/Vazirmatn-Variable.woff2', variable: '--font-vazirmatn', weight: '100 900', display: 'swap' });
export const metadata: Metadata = { title: 'ربات هوشمند | پنل مدیریت', description: 'مدیریت اکانت‌های تلگرام، مخاطبان و عملیات در یک پنل یکپارچه' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const demo = process.env.NEXT_PUBLIC_DEMO === 'true';
  return <html lang="fa" dir="rtl"><body className={`${vazirmatn.variable}${demo ? ' demo-mode' : ''}`}>{demo && <div className="demo-banner" role="status">دموی محلی · داده‌های نمایشی · اتصال و ارسال واقعی تلگرام غیرفعال</div>}<Providers>{children}</Providers></body></html>;
}
