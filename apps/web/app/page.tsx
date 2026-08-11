"use client";

import {
  ArrowRightOutlined,
  BookOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  TrophyOutlined,
} from "@ant-design/icons";
import {
  App,
  Button,
  Card,
  Col,
  Dropdown,
  Empty,
  Flex,
  Progress,
  Row,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableProps } from "antd";
import dayjs from "dayjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { PackageDownloadModal } from "@/components/PackageDownloadModal";
import { apiFetch, compactLibraryName, type ContentItem } from "@/lib/api";

export default function DashboardPage() {
  const { message, modal } = App.useApp();
  const { t } = useLocale();
  const [contents, setContents] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null);
  const [packageFor, setPackageFor] = useState<ContentItem>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [items, health] = await Promise.all([
        apiFetch<ContentItem[]>("/api/contents"),
        apiFetch<{ h5pEngine: string }>("/health").catch(() => ({ h5pEngine: "unavailable" })),
      ]);
      setContents(items);
      setEngineOnline(health.h5pEngine === "ok");
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("home.loadError"));
    } finally {
      setLoading(false);
    }
  }, [message, t]);

  useEffect(() => { void load(); }, [load]);

  const remove = (item: ContentItem) => {
    modal.confirm({
      title: t("home.deleteTitle"),
      content: t("home.deleteBody", { title: item.title }),
      okText: t("home.deleteOk"),
      okType: "danger",
      cancelText: t("home.deleteCancel"),
      onOk: async () => {
        await apiFetch(`/api/contents/${encodeURIComponent(item.h5pContentId)}`, { method: "DELETE" });
        message.success(t("home.deleteDone"));
        await load();
      },
    });
  };

  const stats = useMemo(() => ({
    attempts: contents.reduce((sum, item) => sum + item.attemptCount, 0),
    scored: contents.filter((item) => item.latestScore != null),
  }), [contents]);

  const columns: TableProps<ContentItem>["columns"] = [
    {
      title: t("home.colContent"),
      dataIndex: "title",
      render: (_, item) => (
        <div className="content-title-cell">
          <div className="content-icon"><BookOutlined /></div>
          <div>
            <Link className="content-link" href={`/contents/${item.h5pContentId}/play`}>{item.title}</Link>
            <Typography.Text type="secondary">ID: {item.h5pContentId}</Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: t("home.colType"),
      dataIndex: "mainLibrary",
      width: 180,
      render: (value) => <Tag color="blue">{compactLibraryName(value)}</Tag>,
    },
    {
      title: t("home.colAttempts"),
      dataIndex: "attemptCount",
      align: "center",
      width: 130,
    },
    {
      title: t("home.colLatestScore"),
      dataIndex: "latestScore",
      width: 160,
      render: (value?: number) => value == null
        ? <Typography.Text type="secondary">{t("home.noScore")}</Typography.Text>
        : <Progress percent={Math.round(value * 100)} size="small" style={{ width: 110 }} />,
    },
    {
      title: t("home.colUpdated"),
      dataIndex: "updatedAt",
      width: 145,
      render: (value) => dayjs(value).format("DD/MM/YYYY HH:mm"),
    },
    {
      title: "",
      key: "actions",
      align: "right",
      width: 68,
      render: (_, item) => (
        <Dropdown
          trigger={["click"]}
          menu={{
            items: [
              { key: "play", icon: <EyeOutlined />, label: <Link href={`/contents/${item.h5pContentId}/play`}>{t("home.actionPlay")}</Link> },
              { key: "edit", icon: <EditOutlined />, label: <Link href={`/contents/${item.h5pContentId}/edit`}>{t("home.actionEdit")}</Link> },
              { key: "grades", icon: <TrophyOutlined />, label: <Link href={`/contents/${item.h5pContentId}/grades`}>{t("home.actionGrades")}</Link> },
              { key: "package", icon: <DownloadOutlined />, label: t("home.actionPackage"), onClick: () => setPackageFor(item) },
              { type: "divider" },
              { key: "delete", danger: true, icon: <DeleteOutlined />, label: t("home.actionDelete"), onClick: () => remove(item) },
            ],
          }}
        >
          <Button type="text" icon={<MoreOutlined />} aria-label={t("home.actionsFor", { title: item.title })} />
        </Dropdown>
      ),
    },
  ];

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div>
          <div className="eyebrow"><span className="live-dot" /> {t("home.eyebrow")}</div>
          <Typography.Title>{t("home.heroTitle")}</Typography.Title>
          <Typography.Paragraph>{t("home.heroBody")}</Typography.Paragraph>
          <Space wrap>
            <Link href="/contents/new"><Button type="primary" size="large" icon={<PlusOutlined />}>{t("home.ctaCreate")}</Button></Link>
            <Button size="large" icon={<ReloadOutlined />} onClick={() => void load()}>{t("home.ctaRefresh")}</Button>
          </Space>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="orbit-card orbit-card-main"><BookOutlined /><span>Interactive Book</span></div>
          <div className="orbit-card orbit-card-top">Quiz</div>
          <div className="orbit-card orbit-card-bottom">xAPI</div>
        </div>
      </section>

      <Row gutter={[16, 16]} className="stats-row">
        <Col xs={24} sm={8}>
          <Card><Statistic title={t("home.statContents")} value={contents.length} prefix={<BookOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card><Statistic title={t("home.statEvents")} value={stats.attempts} prefix={<TrophyOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title={t("home.statEngine")}
              value={engineOnline == null ? t("home.engineChecking") : engineOnline ? t("home.engineReady") : t("home.engineOffline")}
              valueStyle={{ color: engineOnline ? "#047857" : engineOnline === false ? "#b91c1c" : undefined, fontSize: 22 }}
              prefix={<span className={`status-dot ${engineOnline ? "online" : ""}`} />}
            />
          </Card>
        </Col>
      </Row>

      <Card className="library-card">
        <Flex justify="space-between" align="center" gap={16} wrap="wrap" className="section-heading">
          <div>
            <Typography.Title level={3}>{t("home.libraryTitle")}</Typography.Title>
            <Typography.Text type="secondary">{t("home.librarySubtitle")}</Typography.Text>
          </div>
          <Link href="/contents/new"><Button type="primary" icon={<PlusOutlined />}>{t("home.newContent")}</Button></Link>
        </Flex>

        {loading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : contents.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t("home.emptyTitle")}
          >
            <Link href="/contents/new"><Button type="primary">{t("home.emptyCta")} <ArrowRightOutlined /></Button></Link>
          </Empty>
        ) : (
          <Table rowKey="id" columns={columns} dataSource={contents} pagination={{ pageSize: 8 }} scroll={{ x: 900 }} />
        )}
      </Card>

      <PackageDownloadModal
        content={packageFor}
        open={Boolean(packageFor)}
        onClose={() => setPackageFor(undefined)}
      />
    </main>
  );
}
