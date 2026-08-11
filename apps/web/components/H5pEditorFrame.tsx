"use client";

import { ArrowLeftOutlined, LoadingOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Result, Spin, Typography } from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { apiFetch } from "@/lib/api";

export function H5pEditorFrame({ contentId }: { contentId?: string }) {
  const router = useRouter();
  const { locale, t } = useLocale();
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [frameHeight, setFrameHeight] = useState(680);
  const [viewportHeight, setViewportHeight] = useState(680);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const updateViewportHeight = () => setViewportHeight(Math.max(680, window.innerHeight - 112));
    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => window.removeEventListener("resize", updateViewportHeight);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "h5p-content-saved" && event.origin === window.location.origin) {
        router.push("/");
        router.refresh();
        return;
      }

      if (event.data?.type !== "h5p-frame-resize" || !url || event.source !== frameRef.current?.contentWindow) return;

      const engineOrigin = new URL(url).origin;
      const requestedHeight = Number(event.data.height);
      if (event.origin !== engineOrigin || !Number.isFinite(requestedHeight)) return;

      setFrameHeight(Math.min(6000, Math.max(680, Math.ceil(requestedHeight))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router, url]);

  useEffect(() => {
    // `locale` is a dependency: switching language re-requests the launch URL so
    // the engine re-renders the editor iframe in the new language.
    setUrl(undefined);
    setError(undefined);

    const callback = `${window.location.origin}/contents/callback`;
    const query = new URLSearchParams({
      returnUrl: callback,
      userId: "demo-author",
      userName: "Tác giả Demo",
      language: locale,
    });
    if (contentId) query.set("contentId", contentId);

    let cancelled = false;
    apiFetch<{ url: string }>(`/api/h5p/editor-url?${query.toString()}`)
      .then((value) => { if (!cancelled) setUrl(value.url); })
      .catch((reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : t("editor.errorFallback"));
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentId, locale]);

  if (error) {
    return (
      <Result
        status="error"
        title={t("editor.errorTitle")}
        subTitle={error}
        extra={<Link href="/"><Button>{t("editor.backToLibrary")}</Button></Link>}
      />
    );
  }

  return (
    <main className="editor-page">
      <div className="editor-toolbar">
        <div>
          <Link href="/"><Button type="text" icon={<ArrowLeftOutlined />}>{t("editor.back")}</Button></Link>
          <Typography.Title level={3}>{contentId ? t("editor.titleEdit") : t("editor.titleNew")}</Typography.Title>
        </div>
        <Alert type="info" showIcon message={t("editor.notice")} />
      </div>
      <Card className="editor-card" styles={{ body: { padding: 0 } }}>
        {!url ? (
          <div className="frame-loading"><Spin indicator={<LoadingOutlined spin />} size="large" /><span>{t("editor.loading")}</span></div>
        ) : (
          <iframe
            key={url}
            ref={frameRef}
            className="h5p-editor-frame"
            src={url}
            title={contentId ? t("editor.frameTitleEdit") : t("editor.frameTitleNew")}
            style={{ height: Math.max(frameHeight, viewportHeight) }}
          />
        )}
      </Card>
    </main>
  );
}
