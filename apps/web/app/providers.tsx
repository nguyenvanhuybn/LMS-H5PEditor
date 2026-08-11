"use client";

import { App, ConfigProvider, theme } from "antd";
import enUS from "antd/locale/en_US";
import viVN from "antd/locale/vi_VN";
import "dayjs/locale/vi";
import type { ReactNode } from "react";
import { LocaleProvider, useLocale } from "@/components/LocaleProvider";
import type { Locale } from "@/lib/i18n";

const ANTD_LOCALES = { vi: viVN, en: enUS } as const;

function AntdWithLocale({ children }: { children: ReactNode }) {
  const { locale } = useLocale();

  return (
    <ConfigProvider
      locale={ANTD_LOCALES[locale]}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#2563eb",
          colorInfo: "#2563eb",
          colorSuccess: "#059669",
          colorWarning: "#d97706",
          borderRadius: 10,
          fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        },
        components: {
          Button: { controlHeight: 40, fontWeight: 600 },
          Card: { borderRadiusLG: 16 },
          Menu: { itemBorderRadius: 10, itemHeight: 44 },
          Table: { headerBg: "#f8fafc", headerColor: "#475569" },
        },
      }}
    >
      <App>{children}</App>
    </ConfigProvider>
  );
}

export function Providers({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <LocaleProvider initialLocale={locale}>
      <AntdWithLocale>{children}</AntdWithLocale>
    </LocaleProvider>
  );
}
