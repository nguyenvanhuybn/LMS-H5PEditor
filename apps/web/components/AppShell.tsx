"use client";

import {
  AppstoreOutlined,
  BookOutlined,
  PlusCircleOutlined,
  ReadOutlined,
} from "@ant-design/icons";
import { Layout, Menu, Typography } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useLocale } from "@/components/LocaleProvider";

const { Sider, Content } = Layout;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { t } = useLocale();
  const selected = pathname === "/" ? "library" : pathname.includes("/new") ? "create" : "library";

  return (
    <Layout className="app-layout">
      <Sider className="app-sider" width={248} breakpoint="lg" collapsedWidth={0}>
        <div className="brand-block">
          <div className="brand-mark"><ReadOutlined /></div>
          <div>
            <Typography.Text className="brand-name">H5P Studio</Typography.Text>
            <Typography.Text className="brand-subtitle">{t("brand.subtitle")}</Typography.Text>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selected]}
          items={[
            {
              key: "library",
              icon: <AppstoreOutlined />,
              label: <Link href="/">{t("nav.library")}</Link>,
            },
            {
              key: "create",
              icon: <PlusCircleOutlined />,
              label: <Link href="/contents/new">{t("nav.create")}</Link>,
            },
          ]}
        />
        <LanguageSwitcher />
        <div className="sider-note">
          <BookOutlined />
          <div>
            <strong>{t("sider.noteTitle")}</strong>
            <span>{t("sider.noteBody")}</span>
          </div>
        </div>
      </Sider>
      <Layout>
        <Content className="app-content">{children}</Content>
      </Layout>
    </Layout>
  );
}
