"use client";

import { ArrowLeftOutlined, CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled } from "@ant-design/icons";
import { Button, Card, Empty, Flex, Progress, Skeleton, Table, Tag, Typography } from "antd";
import type { TableProps } from "antd";
import dayjs from "dayjs";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { apiFetch, type ContentItem, type GradeItem } from "@/lib/api";

export default function GradesPage() {
  const params = useParams<{ id: string }>();
  const { t } = useLocale();
  const [content, setContent] = useState<ContentItem>();
  const [grades, setGrades] = useState<GradeItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch<ContentItem>(`/api/contents/${encodeURIComponent(params.id)}`),
      apiFetch<GradeItem[]>(`/api/contents/${encodeURIComponent(params.id)}/grades`),
    ]).then(([item, items]) => {
      setContent(item);
      setGrades(items);
    }).finally(() => setLoading(false));
  }, [params.id]);

  const columns: TableProps<GradeItem>["columns"] = [
    { title: t("grades.colLearner"), dataIndex: "userId", render: (value) => <strong>{value}</strong> },
    {
      title: t("grades.colScore"), dataIndex: "scoreScaled", width: 220,
      render: (value, item) => (
        <Flex align="center" gap={12}><Progress percent={Math.round(value * 100)} size="small" style={{ width: 110 }} /><span>{item.scoreRaw}/{item.scoreMax}</span></Flex>
      ),
    },
    {
      title: t("grades.colStatus"), key: "status", width: 150,
      render: (_, item) => item.success
        ? <Tag color="success" icon={<CheckCircleFilled />}>{t("grades.passed")}</Tag>
        : item.completed
          ? <Tag color="error" icon={<CloseCircleFilled />}>{t("grades.failed")}</Tag>
          : <Tag icon={<ClockCircleOutlined />}>{item.verb}</Tag>,
    },
    { title: t("grades.colEvent"), dataIndex: "verb", width: 130, render: (value) => <Tag>{value}</Tag> },
    { title: t("grades.colTime"), dataIndex: "attemptedAt", width: 170, render: (value) => dayjs(value).format("DD/MM/YYYY HH:mm:ss") },
  ];

  return (
    <main className="page-shell">
      <div className="page-toolbar">
        <Link href={`/contents/${params.id}/play`}><Button type="text" icon={<ArrowLeftOutlined />}>{t("grades.back")}</Button></Link>
        <Typography.Title level={2}>{t("grades.title", { title: content?.title ?? t("play.contentFallback") })}</Typography.Title>
        <Typography.Text type="secondary">{t("grades.subtitle")}</Typography.Text>
      </div>
      <Card className="library-card">
        {loading ? <Skeleton active /> : grades.length === 0
          ? <Empty description={t("grades.empty")} />
          : <Table rowKey="id" columns={columns} dataSource={grades} scroll={{ x: 800 }} />}
      </Card>
    </main>
  );
}
