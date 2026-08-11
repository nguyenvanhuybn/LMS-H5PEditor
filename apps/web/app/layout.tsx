import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import { cookies } from "next/headers";
import { Providers } from "./providers";
import { AppShell } from "@/components/AppShell";
import { createTranslator, LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";
import "./globals.css";

/** `cookies()` is async in this Next version, so both readers below await it. */
async function readLocale() {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
}

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await readLocale());
  return {
    title: t("meta.title"),
    description: t("meta.description"),
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await readLocale();

  return (
    <html lang={locale}>
      <body>
        <AntdRegistry>
          <Providers locale={locale}>
            <AppShell>{children}</AppShell>
          </Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
