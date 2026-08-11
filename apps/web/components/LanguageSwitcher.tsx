"use client";

import { GlobalOutlined } from "@ant-design/icons";
import { Segmented, Typography } from "antd";
import { useLocale } from "@/components/LocaleProvider";
import { isLocale, LOCALE_LABELS, LOCALES } from "@/lib/i18n";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useLocale();

  return (
    <div className="language-switcher">
      <Typography.Text className="language-switcher-label">
        <GlobalOutlined /> {t("sider.language")}
      </Typography.Text>
      <Segmented
        block
        size="small"
        value={locale}
        onChange={(value) => {
          if (isLocale(value)) setLocale(value);
        }}
        options={LOCALES.map((value) => ({ value, label: LOCALE_LABELS[value] }))}
      />
    </div>
  );
}
