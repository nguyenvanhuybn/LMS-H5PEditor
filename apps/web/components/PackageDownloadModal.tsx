"use client";

import { DownloadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Modal, Radio, Select, Space, Spin, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import type { ContentItem } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n";

type Format = "scorm12" | "scorm2004" | "xapi";

const FORMATS: { value: Format; label: TranslationKey; hint: TranslationKey }[] = [
  { value: "scorm12", label: "package.scorm12", hint: "package.scorm12Hint" },
  { value: "scorm2004", label: "package.scorm2004", hint: "package.scorm2004Hint" },
  { value: "xapi", label: "package.xapi", hint: "package.xapiHint" },
];

export function PackageDownloadModal({
  content,
  open,
  onClose,
}: {
  content?: ContentItem;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const { message } = App.useApp();
  const [format, setFormat] = useState<Format>("scorm12");
  const [origins, setOrigins] = useState<string[]>();
  const [origin, setOrigin] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!open) return;

    setLoadError(undefined);
    setOrigins(undefined);

    fetch("/api/packages/origins", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
        return body as { origins: string[] };
      })
      .then((body) => {
        setOrigins(body.origins);
        setOrigin((current) => current ?? body.origins[0]);
      })
      .catch((reason) => setLoadError(reason instanceof Error ? reason.message : String(reason)));
  }, [open]);

  const download = useCallback(async () => {
    if (!content || !origin) return;

    setDownloading(true);
    try {
      const query = new URLSearchParams({ format, lmsOrigin: origin });
      const response = await fetch(
        `/api/packages/${encodeURIComponent(content.h5pContentId)}?${query}`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      }

      // Read the whole zip first so a mid-stream failure surfaces as an error
      // rather than a truncated file landing in the user's Downloads folder.
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const suggested = /filename="?([^";]+)"?/.exec(disposition)?.[1];

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = suggested ?? `h5p-${content.h5pContentId}-${format}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      message.success(t("package.done"));
      onClose();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : t("package.failed"));
    } finally {
      setDownloading(false);
    }
  }, [content, origin, format, message, onClose, t]);

  const noOrigins = origins?.length === 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={t("package.title", { title: content?.title ?? "" })}
      footer={[
        <Button key="cancel" onClick={onClose}>{t("package.cancel")}</Button>,
        <Button
          key="download"
          type="primary"
          icon={<DownloadOutlined />}
          loading={downloading}
          disabled={!origin || Boolean(loadError)}
          onClick={() => void download()}
        >
          {t("package.download")}
        </Button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>{t("package.formatLabel")}</Typography.Text>
          <Radio.Group
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            style={{ display: "block", marginTop: 8 }}
          >
            <Space direction="vertical" size={6}>
              {FORMATS.map((item) => (
                <Radio key={item.value} value={item.value}>
                  {t(item.label)}
                  <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                    {t(item.hint)}
                  </Typography.Text>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </div>

        <div>
          <Typography.Text strong>{t("package.originLabel")}</Typography.Text>
          {loadError ? (
            <Alert type="error" showIcon style={{ marginTop: 8 }} message={loadError} />
          ) : origins === undefined ? (
            <div style={{ marginTop: 8 }}><Spin size="small" /></div>
          ) : noOrigins ? (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t("package.noOrigins")} />
          ) : (
            <Select
              value={origin}
              onChange={setOrigin}
              style={{ width: "100%", marginTop: 8 }}
              options={origins.map((value) => ({ value, label: value }))}
            />
          )}
        </div>

        <Alert type="info" showIcon message={t("package.hostNote")} />
      </Space>
    </Modal>
  );
}
