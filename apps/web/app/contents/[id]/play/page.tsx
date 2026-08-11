"use client";

import { ArrowLeftOutlined, EditOutlined, LoadingOutlined, TrophyOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Flex, Input, Result, Space, Spin, Typography } from "antd";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { apiFetch, type ContentItem } from "@/lib/api";

export default function PlayContentPage() {
  const params = useParams<{ id: string }>();
  const { locale, t } = useLocale();
  const [content, setContent] = useState<ContentItem>();
  const [playerUrl, setPlayerUrl] = useState<string>();
  const [userId, setUserId] = useState("learner-001");
  const [error, setError] = useState<string>();

  const loadPlayer = useCallback(async () => {
    setPlayerUrl(undefined);
    try {
      const launchQuery = new URLSearchParams({ userId, language: locale });
      const [item, launch] = await Promise.all([
        apiFetch<ContentItem>(`/api/contents/${encodeURIComponent(params.id)}`),
        apiFetch<{ url: string }>(`/api/h5p/player-url/${encodeURIComponent(params.id)}?${launchQuery.toString()}`),
      ]);
      setContent(item);
      setPlayerUrl(launch.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("play.errorFallback"));
    }
  }, [params.id, userId, locale, t]);

  useEffect(() => { void loadPlayer(); }, [loadPlayer]);

  if (error) {
    return (
      <Result
        status="error"
        title={t("play.errorTitle")}
        subTitle={error}
        extra={<Link href="/"><Button>{t("play.backToLibrary")}</Button></Link>}
      />
    );
  }

  return (
    <main className="page-shell player-page">
      <Flex justify="space-between" align="center" gap={16} wrap="wrap" className="page-toolbar">
        <div>
          <Link href="/"><Button type="text" icon={<ArrowLeftOutlined />}>{t("play.back")}</Button></Link>
          <Typography.Title level={2}>{content?.title ?? t("play.loadingTitle")}</Typography.Title>
        </div>
        <Space wrap>
          <Input value={userId} onChange={(event) => setUserId(event.target.value)} onPressEnter={() => void loadPlayer()} addonBefore={t("play.learner")} style={{ width: 240 }} />
          <Link href={`/contents/${params.id}/grades`}><Button icon={<TrophyOutlined />}>{t("play.results")}</Button></Link>
          <Link href={`/contents/${params.id}/edit`}><Button type="primary" icon={<EditOutlined />}>{t("play.edit")}</Button></Link>
        </Space>
      </Flex>
      <Alert className="player-alert" type="info" showIcon message={t("play.alert")} />
      <Card className="player-card" styles={{ body: { padding: 0 } }}>
        {!playerUrl ? (
          <div className="frame-loading"><Spin indicator={<LoadingOutlined spin />} size="large" /><span>{t("play.loading")}</span></div>
        ) : (
          <iframe key={playerUrl} className="h5p-player-frame" src={playerUrl} title={content?.title ?? t("play.contentFallback")} allow="fullscreen; autoplay" />
        )}
      </Card>
    </main>
  );
}
